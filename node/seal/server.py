"""Authenticated local gateway for native network and filesystem capabilities."""

from __future__ import annotations

import asyncio
import ipaddress
import secrets
import time
from typing import Any

import websockets

from seal.seal_pb2 import SealMessage
from seal.filesystem import FileSession
from seal.network import NetworkSession
from seal.errors import ProtocolError
from seal.trust import TrustRepository, verify_device_signature

MAX_MESSAGE_BYTES = 64 * 1024
MAX_IDENTIFIER_LENGTH = 128
MAX_PIN_ATTEMPTS = 5
PIN_TTL_SECONDS = 120
PROTOCOL_VERSION = 1
NODE_VERSION = "0.2.0"


def _text(value: str) -> bytes:
    return value.encode("utf-8")


def _transcript(label: str, *fields: str | bytes) -> bytes:
    encoded = bytearray()
    for field in (label, *fields):
        value = _text(field) if isinstance(field, str) else field
        encoded.extend(len(value).to_bytes(4, "big"))
        encoded.extend(value)
    return bytes(encoded)


def _is_valid_identifier(value: str, field: str) -> None:
    if not value or len(value) > MAX_IDENTIFIER_LENGTH:
        raise ProtocolError("invalid_message", f"{field} is invalid")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ProtocolError("invalid_message", f"{field} contains control characters")


def _validate_loopback_bind(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class ClientConnection:
    def __init__(self, server: SealServer, websocket: Any):
        self.server = server
        self.websocket = websocket
        self.authenticated = False
        self.device_id = ""
        self.pending_pair: dict[str, Any] | None = None
        self.pending_auth: dict[str, Any] | None = None
        self.network = NetworkSession(self)
        self._send_lock = asyncio.Lock()
        self._file_tasks: set[asyncio.Task[Any]] = set()
        self.files = FileSession(server.file_io_slots)
        self.closed = False

    def message(self) -> SealMessage:
        msg = SealMessage()
        msg.protocol_version = PROTOCOL_VERSION
        return msg

    async def send(self, msg: SealMessage) -> None:
        payload = msg.SerializeToString()
        if len(payload) > MAX_MESSAGE_BYTES:
            raise ProtocolError("message_too_large", "Response exceeds the message limit")
        async with self._send_lock:
            if not self.closed:
                try:
                    await self.websocket.send(payload)
                except websockets.ConnectionClosed:
                    # The peer may finish closing between the state check and
                    # send. Let run() release streams and file handles normally.
                    self.closed = True

    async def send_error(self, request_id: str, code: str, message: str, stream_id: int = 0) -> None:
        msg = self.message()
        msg.request_id = request_id
        msg.transport_error_event.stream_id = stream_id
        msg.transport_error_event.code = code
        msg.transport_error_event.message = message
        await self.send(msg)

    async def send_credit(self, stream_id: int, direction: str, amount: int) -> None:
        msg = self.message()
        msg.transport_credit.stream_id = stream_id
        msg.transport_credit.direction = direction
        msg.transport_credit.add_bytes = amount
        await self.send(msg)

    async def send_stream_error(self, stream_id: int, code: str, message: str) -> None:
        await self.send_error("", code, message, stream_id)

    async def run(self) -> None:
        try:
            async for raw in self.websocket:
                if isinstance(raw, str):
                    await self.send_error("", "invalid_message", "text WebSocket frames are not supported")
                    continue
                if len(raw) > MAX_MESSAGE_BYTES:
                    await self.send_error("", "message_too_large", "WebSocket message is too large")
                    await self.websocket.close(1009, "message too large")
                    return
                msg = SealMessage()
                try:
                    msg.ParseFromString(raw)
                    await self.dispatch(msg)
                except websockets.ConnectionClosed:
                    return
                except ProtocolError as exc:
                    body = msg.WhichOneof("body")
                    stream_id = getattr(getattr(msg, body), "stream_id", 0) if body else 0
                    await self.send_error(msg.request_id, exc.code, exc.message, stream_id)
                except Exception as exc:
                    await self.send_error(msg.request_id, "internal", str(exc))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.closed = True
            await self.network.close()
            # Cancelling to_thread does not stop OS I/O. Drain before closing fds.
            await asyncio.gather(*self._file_tasks, return_exceptions=True)
            await self.files.close()

    async def dispatch(self, msg: SealMessage) -> None:
        if msg.protocol_version != PROTOCOL_VERSION:
            raise ProtocolError("protocol_version", "unsupported protocol version")
        body = msg.WhichOneof("body")
        if body == "pair_begin":
            await self._pair_begin(msg)
        elif body == "pair_proof":
            await self._pair_proof(msg)
        elif body == "auth_begin":
            await self._auth_begin(msg)
        elif body == "auth_proof":
            await self._auth_proof(msg)
        elif body == "fs_request":
            self._require_authentication()
            _is_valid_identifier(msg.request_id, "request_id")
            if len(self._file_tasks) >= 16:
                response = self.message()
                response.request_id = msg.request_id
                response.fs_response.error.code = "resource_limit"
                response.fs_response.error.message = "Too many pending file requests"
                await self.send(response)
            else:
                task = asyncio.create_task(self._file_request(msg))
                self._file_tasks.add(task)
                task.add_done_callback(self._file_tasks.discard)
        elif body in ("transport_open_request", "transport_data", "transport_credit", "transport_half_close_request",
                      "transport_close_request", "tcp_listen_request", "tcp_listener_close_request"):
            self._require_authentication()
            await self.network.dispatch(msg)
        else:
            raise ProtocolError("unsupported", f"message type {body!r} is not supported")

    def _require_authentication(self) -> None:
        if not self.authenticated:
            raise ProtocolError("not_authenticated", "device authentication is required")

    async def _file_request(self, request: SealMessage) -> None:
        response = self.message()
        response.request_id = request.request_id
        response.fs_response.CopyFrom(await self.files.execute(request.fs_request))
        if not self.closed:
            try:
                await self.send(response)
            except websockets.ConnectionClosed:
                pass

    async def _pair_begin(self, msg: SealMessage) -> None:
        if self.authenticated:
            raise ProtocolError("invalid_state", "connection is already authenticated")
        if self.server.pin_expired:
            raise ProtocolError("expired_pairing_code", "pairing code has expired")
        if not secrets.compare_digest(msg.pair_begin.pairing_code, self.server.pairing_code):
            self.server.pin_attempts += 1
            if self.server.pin_attempts >= MAX_PIN_ATTEMPTS:
                await self.send_error(msg.request_id, "too_many_attempts", "too many pairing attempts")
                await self.websocket.close(1008, "too many pairing attempts")
                return
            raise ProtocolError("invalid_pairing_code", "pairing code is incorrect")

        _is_valid_identifier(msg.pair_begin.device_id, "device_id")
        _is_valid_identifier(msg.pair_begin.device_name, "device_name")
        if not 16 <= len(msg.pair_begin.client_nonce) <= 64:
            raise ProtocolError("invalid_message", "client nonce is invalid")
        try:
            from seal.trust import load_p256_public_key

            load_p256_public_key(bytes(msg.pair_begin.device_public_key))
        except ValueError as exc:
            raise ProtocolError("invalid_device_key", str(exc)) from exc

        pairing_id = secrets.token_urlsafe(16)
        node_nonce = secrets.token_bytes(32)
        self.pending_pair = {
            "pairing_id": pairing_id,
            "device_id": msg.pair_begin.device_id,
            "device_name": msg.pair_begin.device_name,
            "device_public_key": bytes(msg.pair_begin.device_public_key),
            "client_nonce": bytes(msg.pair_begin.client_nonce),
            "node_nonce": node_nonce,
            "request_id": msg.request_id,
        }
        response = self.message()
        response.request_id = msg.request_id
        response.pair_challenge.pairing_id = pairing_id
        response.pair_challenge.node_id = self.server.trust.node_id
        response.pair_challenge.node_public_key = self.server.trust.node_public_key
        response.pair_challenge.node_nonce = node_nonce
        await self.send(response)

    async def _pair_proof(self, msg: SealMessage) -> None:
        pending = self.pending_pair
        if pending is None or msg.pair_proof.pairing_id != pending["pairing_id"]:
            raise ProtocolError("invalid_pairing", "pairing challenge is not active")
        transcript = _transcript(
            "SEAL-PAIR-1",
            str(PROTOCOL_VERSION),
            pending["pairing_id"],
            pending["device_id"],
            pending["device_name"],
            pending["device_public_key"],
            self.server.trust.node_id,
            self.server.trust.node_public_key,
            pending["client_nonce"],
            pending["node_nonce"],
        )
        if not verify_device_signature(
            pending["device_public_key"], transcript, bytes(msg.pair_proof.device_signature)
        ):
            raise ProtocolError("invalid_pairing_proof", "device proof is invalid")

        self.server.trust.upsert_device(
            pending["device_id"],
            pending["device_name"],
            pending["device_public_key"],
            time.time(),
        )
        self.authenticated = True
        self.device_id = pending["device_id"]
        self.pending_pair = None
        response = self.message()
        response.request_id = msg.request_id
        response.pair_succeeded.device_id = self.device_id
        response.pair_succeeded.node_id = self.server.trust.node_id
        response.pair_succeeded.node_public_key = self.server.trust.node_public_key
        await self.send(response)

    async def _auth_begin(self, msg: SealMessage) -> None:
        if self.authenticated:
            raise ProtocolError("invalid_state", "connection is already authenticated")
        _is_valid_identifier(msg.auth_begin.device_id, "device_id")
        _is_valid_identifier(msg.auth_begin.connection_id, "connection_id")
        if not 16 <= len(msg.auth_begin.client_nonce) <= 64:
            raise ProtocolError("invalid_message", "client nonce is invalid")
        device = self.server.trust.get_device(msg.auth_begin.device_id)
        if device is None:
            raise ProtocolError("unknown_device", "device is not paired")

        node_nonce = secrets.token_bytes(32)
        self.pending_auth = {
            "device_id": msg.auth_begin.device_id,
            "connection_id": msg.auth_begin.connection_id,
            "client_nonce": bytes(msg.auth_begin.client_nonce),
            "node_nonce": node_nonce,
            "device_public_key": device.public_key,
            "request_id": msg.request_id,
        }
        transcript = _transcript(
            "SEAL-AUTH-1",
            str(PROTOCOL_VERSION),
            msg.auth_begin.connection_id,
            msg.auth_begin.device_id,
            self.server.trust.node_id,
            bytes(msg.auth_begin.client_nonce),
            node_nonce,
        )
        response = self.message()
        response.request_id = msg.request_id
        response.auth_challenge.connection_id = msg.auth_begin.connection_id
        response.auth_challenge.node_id = self.server.trust.node_id
        response.auth_challenge.node_public_key = self.server.trust.node_public_key
        response.auth_challenge.node_nonce = node_nonce
        response.auth_challenge.node_signature = self.server.trust.sign(transcript)
        await self.send(response)

    async def _auth_proof(self, msg: SealMessage) -> None:
        pending = self.pending_auth
        if pending is None or msg.auth_proof.connection_id != pending["connection_id"]:
            raise ProtocolError("invalid_auth", "authentication challenge is not active")
        transcript = _transcript(
            "SEAL-AUTH-1",
            str(PROTOCOL_VERSION),
            pending["connection_id"],
            pending["device_id"],
            self.server.trust.node_id,
            pending["client_nonce"],
            pending["node_nonce"],
        )
        if not verify_device_signature(
            pending["device_public_key"], transcript, bytes(msg.auth_proof.device_signature)
        ):
            raise ProtocolError("invalid_auth_proof", "device proof is invalid")
        self.authenticated = True
        self.device_id = pending["device_id"]
        self.pending_auth = None
        response = self.message()
        response.request_id = msg.request_id
        response.auth_succeeded.device_id = self.device_id
        response.auth_succeeded.node_id = self.server.trust.node_id
        await self.send(response)



class SealServer:
    def __init__(self, trust: TrustRepository):
        self.trust = trust
        self.pairing_code = f"{secrets.randbelow(1_000_000):06d}"
        self.pin_created_at = time.time()
        self.pin_attempts = 0
        self.clients: set[ClientConnection] = set()
        self.file_io_slots = asyncio.Semaphore(4)

    @property
    def pin_expired(self) -> bool:
        return time.time() - self.pin_created_at > PIN_TTL_SECONDS

    async def handle(self, websocket: Any, _path: str = "/") -> None:
        client = ClientConnection(self, websocket)
        self.clients.add(client)
        try:
            await client.run()
        finally:
            self.clients.discard(client)


async def serve(trust: TrustRepository, host: str, port: int) -> None:
    if not _validate_loopback_bind(host):
        raise ValueError("SealNode must bind to localhost loopback")
    server = SealServer(trust)
    async with websockets.serve(server.handle, host, port, max_size=MAX_MESSAGE_BYTES):
        print(
            f"Listening on ws://{host}:{port}, pairing code: {server.pairing_code}",
            flush=True,
        )
        await asyncio.Future()
