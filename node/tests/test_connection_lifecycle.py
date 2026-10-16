import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK
from websockets.frames import Close

from seal.server import ClientConnection


class ConnectionLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_abrupt_peer_close_still_releases_streams_and_files(self):
        class ClosedSocket:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise ConnectionClosedError(None, None)

        client = ClientConnection(SimpleNamespace(file_io_slots=asyncio.Semaphore(4)), ClosedSocket())
        stream = SimpleNamespace(close=AsyncMock())
        client.network.streams[1] = stream
        client.files = SimpleNamespace(close=AsyncMock())
        await client.run()
        self.assertTrue(client.closed)
        stream.close.assert_awaited_once_with('websocket_closed', notify=False)
        client.files.close.assert_awaited_once()

    async def test_peer_close_during_send_stops_future_sends(self):
        websocket = SimpleNamespace(send=AsyncMock(side_effect=ConnectionClosedOK(Close(1000, ""), Close(1000, ""), True)))
        client = ClientConnection(SimpleNamespace(file_io_slots=asyncio.Semaphore(4)), websocket)
        await client.send(client.message())
        self.assertTrue(client.closed)
        await client.send(client.message())
        websocket.send.assert_awaited_once()

    async def test_other_send_failures_are_not_suppressed(self):
        websocket = SimpleNamespace(send=AsyncMock(side_effect=RuntimeError("unexpected failure")))
        client = ClientConnection(SimpleNamespace(file_io_slots=asyncio.Semaphore(4)), websocket)
        with self.assertRaisesRegex(RuntimeError, "unexpected failure"):
            await client.send(client.message())
        self.assertFalse(client.closed)
