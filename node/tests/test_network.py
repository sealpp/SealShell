import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from seal.errors import ProtocolError
from seal.network import ACCEPTED_STREAM_START, INITIAL_CREDIT_BYTES, NetworkSession, TcpStream
from seal.seal_pb2 import SealMessage
from seal.server import ClientConnection


class Peer:
    def __init__(self):
        self.events = asyncio.Queue()

    def message(self):
        return SealMessage(protocol_version=1)

    async def send(self, message):
        self.events.put_nowait(message)

    async def send_error(self, request_id, code, message, stream_id=0):
        result = self.message()
        result.request_id = request_id
        result.transport_error_event.code = code
        result.transport_error_event.message = message
        result.transport_error_event.stream_id = stream_id
        await self.send(result)

    async def send_credit(self, stream_id, direction, amount):
        result = self.message()
        result.transport_credit.stream_id = stream_id
        result.transport_credit.direction = direction
        result.transport_credit.add_bytes = amount
        await self.send(result)

    async def send_stream_error(self, stream_id, code, message):
        await self.send_error('', code, message, stream_id)

    async def event(self, kind):
        async with asyncio.timeout(3):
            while True:
                message = await self.events.get()
                if message.WhichOneof('body') == 'transport_error_event':
                    raise AssertionError(message)
                if message.WhichOneof('body') == kind:
                    return getattr(message, kind)


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.peer = Peer()
        self.network = NetworkSession(self.peer)

    async def asyncTearDown(self):
        await self.network.close()

    async def listen(self):
        request = self.peer.message()
        request.tcp_listen_request.listener_id = 1
        request.tcp_listen_request.host = '127.0.0.1'
        await self.network.dispatch(request)
        return await self.peer.event('tcp_listening_event')

    async def accepted(self):
        bound = await self.listen()
        reader, writer = await asyncio.open_connection(bound.host, bound.port)
        self.addAsyncCleanup(writer.wait_closed)
        self.addCleanup(writer.close)
        event = await self.peer.event('tcp_accepted_event')
        self.assertGreaterEqual(event.stream_id, ACCEPTED_STREAM_START)
        return reader, writer, event.stream_id, bound.port

    async def test_accept_half_close_and_listener_independent_lifetime(self):
        reader, writer, stream_id, port = await self.accepted()
        request = self.peer.message()
        request.tcp_listener_close_request.listener_id = 1
        await self.network.dispatch(request)
        await self.peer.event('tcp_listener_closed_event')
        writer.write(b'hello')
        await writer.drain()
        writer.write_eof()
        self.assertEqual((await self.peer.event('transport_data')).payload, b'hello')
        await self.peer.event('transport_eof_event')
        # A FIN closes only the readable direction; replies still work.
        request = self.peer.message()
        request.transport_data.stream_id = stream_id
        request.transport_data.payload = b'reply after FIN'
        await self.network.dispatch(request)
        request = self.peer.message()
        request.transport_half_close_request.stream_id = stream_id
        await self.network.dispatch(request)
        self.assertEqual(await asyncio.wait_for(reader.read(), 3), b'reply after FIN')
        await self.peer.event('transport_closed_event')
        self.assertFalse(self.network.streams)
        rebound = await asyncio.start_server(lambda r, w: w.close(), '127.0.0.1', port)
        rebound.close()
        await rebound.wait_closed()

    async def test_session_close_releases_listener_and_accepted_socket(self):
        reader, _, _, port = await self.accepted()
        await self.network.close()
        self.assertEqual(await asyncio.wait_for(reader.read(), 3), b'')
        rebound = await asyncio.start_server(lambda r, w: w.close(), '127.0.0.1', port)
        rebound.close()
        await rebound.wait_closed()

    async def test_slow_writer_does_not_block_dispatch_and_credit_is_bounded(self):
        blocked = asyncio.Event()

        class SlowStream(TcpStream):
            async def write(self, payload):
                await blocked.wait()

        _, _, stream_id, _ = await self.accepted()
        stream = self.network.streams[stream_id]
        stream.__class__ = SlowStream
        for _ in range(4):
            await asyncio.wait_for(stream.accept_input(b'x' * 65536), 0.1)
        self.assertEqual(stream.input_credit, 0)
        with self.assertRaisesRegex(ProtocolError, 'credit'):
            await stream.accept_input(b'x')
        blocked.set()
        for _ in range(4):
            await self.peer.event('transport_credit')
        self.assertEqual(stream.input_credit, INITIAL_CREDIT_BYTES)

    async def test_pending_open_ids_are_reserved_and_cancelled_on_disconnect(self):
        entered = asyncio.Event()

        async def slow_open(*args):
            entered.set()
            await asyncio.Future()

        request = self.peer.message()
        request.transport_open_request.stream_id = 1
        request.transport_open_request.transport = 'tcp'
        request.transport_open_request.host = '127.0.0.1'
        request.transport_open_request.port = 1234
        with patch('seal.network.asyncio.open_connection', slow_open):
            await self.network.dispatch(request)
            await entered.wait()
            with self.assertRaisesRegex(ProtocolError, 'reserved'):
                await self.network.dispatch(request)
            await self.network.close()
        self.assertFalse(self.network.opening)
        self.assertFalse(self.network.tasks)

    async def test_listener_requires_authentication(self):
        client = ClientConnection(SimpleNamespace(file_io_slots=asyncio.Semaphore(4)), None)
        request = self.peer.message()
        request.tcp_listen_request.host = '127.0.0.1'
        request.tcp_listen_request.listener_id = 1
        with self.assertRaisesRegex(ProtocolError, 'authentication'):
            await client.dispatch(request)
