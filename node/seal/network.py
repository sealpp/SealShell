"""Connection-owned native TCP/UDP capabilities; no application protocol logic."""
from __future__ import annotations

import asyncio
import ipaddress
from typing import Any

from seal.errors import ProtocolError
from seal.seal_pb2 import SealMessage

MAX_DATA_PAYLOAD = 60 * 1024
MAX_STREAMS_PER_CLIENT = 64
MAX_LISTENERS_PER_CLIENT = 32
MAX_HOST_LENGTH = 253
MAX_CREDIT = 1024 * 1024
INITIAL_CREDIT_BYTES = 256 * 1024
CONNECT_TIMEOUT_SECONDS = 10
ACCEPTED_STREAM_START = 1 << 31

def _validate_target(host: str, port: int) -> None:
    if not host or len(host) > MAX_HOST_LENGTH:
        raise ProtocolError("invalid_target", "host is invalid")
    if host != host.strip() or any(char in host for char in ("/", "\\", "@", "\x00")):
        raise ProtocolError("invalid_target", "host is invalid")
    if "://" in host:
        raise ProtocolError("invalid_target", "host must not contain a scheme")
    if not 1 <= port <= 65535:
        raise ProtocolError("invalid_target", "port is invalid")


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
    def __init__(self, client: NetworkSession, stream_id: int, transport_kind: str):
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
        self._writer_task: asyncio.Task[None] | None = None
        self._input: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.input_ended = False
        self.write_ended = False
        self.read_ended = False
        self._closed_event_sent = False

    async def start(self) -> None:
        self._writer_task = asyncio.create_task(self._pump_input())

    async def write(self, payload: bytes) -> None:
        raise NotImplementedError

    async def half_close(self) -> None:
        if self.transport_kind != "tcp":
            raise ProtocolError("unsupported", "UDP does not support half-close")
        if not self.closed and not self.input_ended:
            self.input_ended = True
            self._input.put_nowait(None)

    async def _finish_write(self) -> None:
        raise NotImplementedError

    async def _pump_input(self) -> None:
        try:
            while not self.closed:
                payload = await self._input.get()
                if payload is None:
                    await self._finish_write()
                    return
                await self.write(payload)
                self.input_credit += len(payload)
                await self.client.send_credit(self.stream_id, "input", len(payload))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.client.send_stream_error(self.stream_id, "write_failed", str(exc))
            await self.close("write_failed")

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
        if self.closed or self.input_ended:
            raise ProtocolError("stream_closed", "stream input has ended")
        if len(payload) > self.input_credit:
            raise ProtocolError("credit_exhausted", "input credit is exhausted")
        self.input_credit -= len(payload)
        self._input.put_nowait(payload)

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
        tasks = [task for task in (self._pump_task, self._writer_task) if task and task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
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
        client: NetworkSession,
        stream_id: int,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ):
        super().__init__(client, stream_id, "tcp")
        self.reader = reader
        self.writer = writer

    async def start(self) -> None:
        await super().start()
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
                    self.read_ended = True
                    msg = self.client.message()
                    msg.transport_eof_event.stream_id = self.stream_id
                    await self.client.send(msg)
                    if self.write_ended:
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

    async def _finish_write(self) -> None:
        self.writer.write_eof()
        await self.writer.drain()
        self.write_ended = True
        if self.read_ended:
            await self.close("eof")

    async def _close_transport(self) -> None:
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except Exception:
            pass


class UdpStream(TransportStream):
    def __init__(
        self,
        client: NetworkSession,
        stream_id: int,
        transport: asyncio.DatagramTransport,
        queue: asyncio.Queue[bytes],
    ):
        super().__init__(client, stream_id, "udp")
        self.transport = transport
        self.queue = queue

    async def start(self) -> None:
        await super().start()
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


class NetworkSession:
    def __init__(self, client: Any):
        self.client = client
        self.message = client.message
        self.send = client.send
        self.send_error = client.send_error
        self.send_credit = client.send_credit
        self.send_stream_error = client.send_stream_error
        self.streams: dict[int, TransportStream] = {}
        self.listeners: dict[int, asyncio.Server] = {}
        self.opening: set[int] = set()
        self.binding: dict[int, asyncio.Task] = {}
        self.tasks: set[asyncio.Task] = set()
        self.next_accepted_id = ACCEPTED_STREAM_START
        self.closed = False

    def spawn(self, operation):
        task = asyncio.create_task(operation)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def dispatch(self, msg):
        body = msg.WhichOneof("body")
        if body == "transport_open_request":
            stream_id = msg.transport_open_request.stream_id
            if not 0 < stream_id < ACCEPTED_STREAM_START or stream_id in self.streams or stream_id in self.opening:
                raise ProtocolError("invalid_stream", "stream id is already in use or reserved")
            if len(self.streams) + len(self.opening) >= MAX_STREAMS_PER_CLIENT:
                raise ProtocolError("resource_limit", "too many transport streams")
            self.opening.add(stream_id)
            self.spawn(self._open_transport(msg))
        elif body == "tcp_listen_request":
            listener_id = msg.tcp_listen_request.listener_id
            if not listener_id or listener_id in self.listeners or listener_id in self.binding:
                raise ProtocolError("invalid_listener", "listener id is already in use")
            if len(self.listeners) + len(self.binding) >= MAX_LISTENERS_PER_CLIENT:
                raise ProtocolError("resource_limit", "too many TCP listeners")
            self.binding[listener_id] = self.spawn(self._listen(msg))
        elif body == "tcp_listener_close_request":
            listener_id = msg.tcp_listener_close_request.listener_id
            pending = self.binding.get(listener_id)
            if pending:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            listener = self.listeners.pop(listener_id, None)
            if listener:
                listener.close()
            response = self.message()
            response.request_id = msg.request_id
            response.tcp_listener_closed_event.listener_id = listener_id
            await self.send(response)
        else:
            handlers = {"transport_data": self._transport_data, "transport_credit": self._transport_credit,
                        "transport_half_close_request": self._transport_half_close, "transport_close_request": self._transport_close}
            await handlers[body](msg)

    async def close(self):
        self.closed = True
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for listener in self.listeners.values():
            listener.close()
        for stream in list(self.streams.values()):
            await stream.close("websocket_closed", notify=False)
        await asyncio.gather(*(listener.wait_closed() for listener in self.listeners.values()))
        self.listeners.clear()

    async def _listen(self, msg):
        request = msg.tcp_listen_request
        listener = None
        try:
            # Bind an explicit local address. Name resolution and port selection
            # policies belong to callers; port zero delegates allocation to the OS.
            ipaddress.ip_address(request.host)
            if request.port > 65535:
                raise ProtocolError("invalid_target", "port is invalid")
            listener = await asyncio.start_server(
                lambda reader, writer: self._accept(request.listener_id, reader, writer),
                request.host, request.port, start_serving=False,
            )
            self.listeners[request.listener_id] = listener
            address = listener.sockets[0].getsockname()
            response = self.message()
            response.request_id = msg.request_id
            response.tcp_listening_event.listener_id = request.listener_id
            response.tcp_listening_event.host = address[0]
            response.tcp_listening_event.port = address[1]
            await self.send(response)
            await listener.start_serving()
        except (ProtocolError, ValueError, OSError) as error:
            if listener:
                listener.close()
                self.listeners.pop(request.listener_id, None)
            code = error.code if isinstance(error, ProtocolError) else "listen_failed"
            await self.send_error(msg.request_id, code, str(error))
        finally:
            self.binding.pop(request.listener_id, None)

    def _accept(self, listener_id, reader, writer):
        if self.closed or listener_id not in self.listeners or len(self.streams) + len(self.opening) >= MAX_STREAMS_PER_CLIENT:
            writer.close()
            return
        stream_id = self.next_accepted_id
        self.next_accepted_id += 1
        stream = TcpStream(self, stream_id, reader, writer)
        self.streams[stream_id] = stream
        self.spawn(self._start_accepted(listener_id, stream))

    async def _start_accepted(self, listener_id, stream):
        stream_id = stream.stream_id
        writer = stream.writer
        peer = writer.get_extra_info("peername")
        event = self.message()
        accepted = event.tcp_accepted_event
        accepted.listener_id = listener_id
        accepted.stream_id = stream_id
        accepted.peer_host, accepted.peer_port = peer[:2]
        accepted.input_credit_bytes = INITIAL_CREDIT_BYTES
        accepted.output_credit_bytes = INITIAL_CREDIT_BYTES
        await self.send(event)
        await stream.start()

    async def _open_transport(self, msg: SealMessage) -> None:
        request = msg.transport_open_request
        try:
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
        finally:
            self.opening.discard(request.stream_id)

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
