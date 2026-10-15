"""Loopback WebSocket to TCP/UDP transport for SealShell."""

from __future__ import annotations

import asyncio
import ipaddress
import secrets
import time
from typing import Any

import websockets

from seal.seal_pb2 import SealMessage
from seal.filesystem import FileSession
from seal.trust import TrustRepository, verify_device_signature

MAX_MESSAGE_BYTES = 64 * 1024
MAX_DATA_PAYLOAD = 60 * 1024
MAX_STREAMS_PER_CLIENT = 64
MAX_HOST_LENGTH = 253
MAX_IDENTIFIER_LENGTH = 128
MAX_CREDIT = 1024 * 1024
INITIAL_CREDIT_BYTES = 256 * 1024
MAX_PIN_ATTEMPTS = 5
PIN_TTL_SECONDS = 120
CONNECT_TIMEOUT_SECONDS = 10
PROTOCOL_VERSION = 1
NODE_VERSION = "0.2.0"


class ProtocolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


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


def _validate_target(host: str, port: int) -> None:
    if not host or len(host) > MAX_HOST_LENGTH:
        raise ProtocolError("invalid_target", "host is invalid")
    if host != host.strip() or any(char in host for char in ("/", "\\", "@", "\x00")):
        raise ProtocolError("invalid_target", "host is invalid")
    if "://" in host:
        raise ProtocolError("invalid_target", "host must not contain a scheme")
    if not 1 <= port <= 65535:
        raise ProtocolError("invalid_target", "port is invalid")


def _validate_loopback_bind(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class _DatagramReceiver(asyncio.DatagramProtocol):
    def __init__(self, queue: asyncio.Queue[bytes]):
        self.queue = queue
        self.transport: asyncio.DatagramTransport | None = None
        self.error: Exception | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, _addr: Any) -> None:
        if len(data) <= MAX_DATA_PAYLOAD:
            try:
                self.queue.put_nowait(data)
            except asyncio.QueueFull:
                pass

    def error_received(self, exc: Exception) -> None:
        self.error = exc

    def connection_lost(self, exc: Exception | None) -> None:
        if exc:
            self.error = exc


class TransportStream:
    def __init__(self, client: ClientConnection, stream_id: int, transport_kind: str):
        self.client = client
        self.stream_id = stream_id
        self.transport_kind = transport_kind
        self.input_credit = INITIAL_CREDIT_BYTES
        self.output_credit = INITIAL_CREDIT_BYTES
        self.input_sequence = 0
        self.output_sequence = 0
        self.closed = False
        self._credit_condition = asyncio.Condition()
        self._pump_task: asyncio.Task[None] | None = None
        self._closed_event_sent = False

    async def start(self) -> None:
        raise NotImplementedError

    async def write(self, payload: bytes) -> None:
        raise NotImplementedError

    async def half_close(self) -> None:
        raise NotImplementedError

    async def _take_output_credit(self, required: int = 1) -> bool:
        async with self._credit_condition:
            while not self.closed and self.output_credit < required:
                await self._credit_condition.wait()
            if self.closed:
                return False
            self.output_credit -= required
            return True

    async def add_output_credit(self, amount: int) -> None:
        if amount <= 0 or amount > MAX_CREDIT:
            raise ProtocolError("invalid_credit", "credit increment is invalid")
        async with self._credit_condition:
            if self.output_credit + amount > MAX_CREDIT:
                raise ProtocolError("invalid_credit", "credit exceeds the stream limit")
            self.output_credit += amount
            self._credit_condition.notify_all()

    async def accept_input(self, payload: bytes) -> None:
        if len(payload) > self.input_credit:
            raise ProtocolError("credit_exhausted", "input credit is exhausted")
        self.input_credit -= len(payload)
        await self.write(payload)
        self.input_credit += len(payload)
        await self.client.send_credit(self.stream_id, "input", len(payload))

    async def send_data(self, payload: bytes) -> None:
        if not payload or len(payload) > MAX_DATA_PAYLOAD:
            raise ProtocolError("invalid_message", "transport payload is invalid")
        if not await self._take_output_credit(len(payload)):
            return
        msg = self.client.message()
        msg.transport_data.stream_id = self.stream_id
        msg.transport_data.sequence = self.output_sequence
        msg.transport_data.payload = payload
        self.output_sequence += 1
        await self.client.send(msg)

    async def close(self, reason: str = "", notify: bool = True) -> None:
        if self.closed:
            return
        self.closed = True
        async with self._credit_condition:
            self._credit_condition.notify_all()
        if self._pump_task and self._pump_task is not asyncio.current_task():
            self._pump_task.cancel()
            try:
                await self._pump_task
            except asyncio.CancelledError:
                pass
        await self._close_transport()
        self.client.streams.pop(self.stream_id, None)
        if notify and not self._closed_event_sent:
            self._closed_event_sent = True
            msg = self.client.message()
            msg.transport_closed_event.stream_id = self.stream_id
            msg.transport_closed_event.reason = reason
            await self.client.send(msg)

    async def _close_transport(self) -> None:
        raise NotImplementedError


class TcpStream(TransportStream):
    def __init__(
        self,
        client: ClientConnection,
        stream_id: int,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ):
        super().__init__(client, stream_id, "tcp")
        self.reader = reader
        self.writer = writer

    async def start(self) -> None:
        self._pump_task = asyncio.create_task(self._pump_output())

    async def _pump_output(self) -> None:
        try:
            while not self.closed:
                async with self._credit_condition:
                    while not self.closed and self.output_credit == 0:
                        await self._credit_condition.wait()
                    if self.closed:
                        return
                    read_size = min(MAX_DATA_PAYLOAD, self.output_credit)
                payload = await self.reader.read(read_size)
                if not payload:
                    await self.close("eof")
                    return
                await self.send_data(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.client.send_stream_error(self.stream_id, "tcp_read_failed", str(exc))
            await self.close("tcp_read_failed", notify=True)

    async def write(self, payload: bytes) -> None:
        if self.closed:
            raise ProtocolError("stream_closed", "transport stream is closed")
        self.writer.write(payload)
        await self.writer.drain()

    async def half_close(self) -> None:
        if self.closed:
            return
        if self.writer.can_write_eof():
            self.writer.write_eof()
            await self.writer.drain()

    async def _close_transport(self) -> None:
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except Exception:
            pass


class UdpStream(TransportStream):
    def __init__(
        self,
        client: ClientConnection,
        stream_id: int,
        transport: asyncio.DatagramTransport,
        queue: asyncio.Queue[bytes],
    ):
        super().__init__(client, stream_id, "udp")
        self.transport = transport
        self.queue = queue

    async def start(self) -> None:
        self._pump_task = asyncio.create_task(self._pump_output())

    async def _pump_output(self) -> None:
        try:
            while not self.closed:
                payload = await self.queue.get()
                if len(payload) > MAX_DATA_PAYLOAD:
                    continue
                if not await self._take_output_credit(len(payload)):
                    return
                msg = self.client.message()
                msg.transport_data.stream_id = self.stream_id
                msg.transport_data.sequence = self.output_sequence
                msg.transport_data.payload = payload
                self.output_sequence += 1
                await self.client.send(msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.client.send_stream_error(self.stream_id, "udp_read_failed", str(exc))
            await self.close("udp_read_failed", notify=True)

    async def write(self, payload: bytes) -> None:
        if self.closed:
            raise ProtocolError("stream_closed", "transport stream is closed")
        if not payload:
            return
        self.transport.sendto(payload)

    async def half_close(self) -> None:
        raise ProtocolError("unsupported", "UDP does not support half-close")

    async def _close_transport(self) -> None:
        self.transport.close()


class ClientConnection:
    def __init__(self, server: SealServer, websocket: Any):
        self.server = server
        self.websocket = websocket
        self.authenticated = False
        self.device_id = ""
        self.pending_pair: dict[str, Any] | None = None
        self.pending_auth: dict[str, Any] | None = None
        self.streams: dict[int, TransportStream] = {}
        self._send_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[Any]] = set()
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
                    await self.send_error(msg.request_id, exc.code, exc.message)
                except Exception as exc:
                    await self.send_error(msg.request_id, "internal", str(exc))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.closed = True
            for task in list(self._tasks):
                task.cancel()
            for stream in list(self.streams.values()):
                await stream.close("websocket_closed", notify=False)
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
        elif body == "transport_open_request":
            self._require_authentication()
            self._spawn(self._open_transport(msg))
        elif body == "transport_data":
            self._require_authentication()
            await self._transport_data(msg)
        elif body == "transport_credit":
            self._require_authentication()
            await self._transport_credit(msg)
        elif body == "transport_half_close_request":
            self._require_authentication()
            await self._transport_half_close(msg)
        elif body == "transport_close_request":
            self._require_authentication()
            await self._transport_close(msg)
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

    def _spawn(self, coroutine: Any) -> None:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

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

    async def _open_transport(self, msg: SealMessage) -> None:
        request = msg.transport_open_request
        try:
            if request.stream_id == 0 or request.stream_id in self.streams:
                raise ProtocolError("invalid_stream", "stream id is already in use")
            if len(self.streams) >= MAX_STREAMS_PER_CLIENT:
                raise ProtocolError("resource_limit", "too many transport streams")
            if request.transport not in ("tcp", "udp"):
                raise ProtocolError("unsupported_transport", "transport must be tcp or udp")
            _validate_target(request.host, request.port)

            if request.transport == "tcp":
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(request.host, request.port),
                    timeout=CONNECT_TIMEOUT_SECONDS,
                )
                stream: TransportStream = TcpStream(self, request.stream_id, reader, writer)
            else:
                queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=16)
                loop = asyncio.get_running_loop()
                transport, _protocol = await asyncio.wait_for(
                    loop.create_datagram_endpoint(
                        lambda: _DatagramReceiver(queue),
                        remote_addr=(request.host, request.port),
                    ),
                    timeout=CONNECT_TIMEOUT_SECONDS,
                )
                stream = UdpStream(self, request.stream_id, transport, queue)

            self.streams[stream.stream_id] = stream
            response = self.message()
            response.request_id = msg.request_id
            response.transport_opened_event.stream_id = stream.stream_id
            response.transport_opened_event.transport = stream.transport_kind
            response.transport_opened_event.input_credit_bytes = INITIAL_CREDIT_BYTES
            response.transport_opened_event.output_credit_bytes = INITIAL_CREDIT_BYTES
            await self.send(response)
            await stream.start()
        except (ProtocolError, asyncio.TimeoutError, OSError) as exc:
            if isinstance(exc, ProtocolError):
                code, message = exc.code, exc.message
            elif isinstance(exc, asyncio.TimeoutError):
                code, message = "connect_timeout", "target connection timed out"
            else:
                code, message = "connect_failed", str(exc)
            await self.send_error(msg.request_id, code, message, request.stream_id)

    async def _transport_data(self, msg: SealMessage) -> None:
        data = msg.transport_data
        stream = self.streams.get(data.stream_id)
        if stream is None:
            raise ProtocolError("stream_not_found", "transport stream does not exist")
        if data.sequence != stream.input_sequence:
            raise ProtocolError("sequence_error", "transport sequence is not increasing")
        payload = bytes(data.payload)
        if not payload or len(payload) > MAX_DATA_PAYLOAD:
            raise ProtocolError("invalid_message", "transport payload is invalid")
        stream.input_sequence += 1
        await stream.accept_input(payload)

    async def _transport_credit(self, msg: SealMessage) -> None:
        credit = msg.transport_credit
        stream = self.streams.get(credit.stream_id)
        if stream is None:
            raise ProtocolError("stream_not_found", "transport stream does not exist")
        if credit.direction != "output":
            raise ProtocolError("invalid_credit", "only output credit can be granted by the PWA")
        await stream.add_output_credit(int(credit.add_bytes))

    async def _transport_half_close(self, msg: SealMessage) -> None:
        stream = self.streams.get(msg.transport_half_close_request.stream_id)
        if stream is None:
            raise ProtocolError("stream_not_found", "transport stream does not exist")
        await stream.half_close()

    async def _transport_close(self, msg: SealMessage) -> None:
        stream = self.streams.get(msg.transport_close_request.stream_id)
        if stream is None:
            return
        await stream.close(msg.transport_close_request.reason)


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
