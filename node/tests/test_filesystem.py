import asyncio
import os
import tempfile
import unittest
from pathlib import Path

import websockets
from cryptography.hazmat.primitives.asymmetric import ec

from seal.filesystem import MAX_CHUNK
from seal.seal_pb2 import SealMessage
from seal.server import SealServer
from seal.trust import TrustRepository
from scripts.smoke_test import authenticate, pair, recv_message


def exercise_filesystem(tmp_path: Path):
    async def exercise():
        server = SealServer(TrustRepository(tmp_path / "trust.json"))
        key = ec.generate_private_key(ec.SECP256R1())
        async with websockets.serve(server.handle, "127.0.0.1", 0, max_size=65536) as listener:
            port = listener.sockets[0].getsockname()[1]
            url = f"ws://127.0.0.1:{port}"
            sequence = 0

            async def call(ws, operation, **args):
                nonlocal sequence
                sequence += 1
                msg = SealMessage(protocol_version=1, request_id=f"fs-{sequence}", fs_request={operation: args})
                await ws.send(msg.SerializeToString())
                response = await recv_message(ws)
                assert response.request_id == msg.request_id
                return response

            async with websockets.connect(url) as ws:
                rejected = await call(ws, "info")
                assert rejected.transport_error_event.code == "not_authenticated"
                node_id, public_key = await pair(ws, server.pairing_code, key, "fs-test")
                info = (await call(ws, "info")).fs_response.info
                assert info.max_chunk_bytes == MAX_CHUNK
                assert info.home == str(Path.home())
                path = str(tmp_path / "空 白.bin")
                handle = (await call(ws, "open", path=path, write=True, create=True, exclusive=True)).fs_response.opened.handle
                assert handle
                data = bytes(range(256)) * 240
                for i in range(3):
                    result = (await call(ws, "write", handle=handle, offset=i * len(data), payload=data)).fs_response
                    assert result.written.bytes_written == len(data)
                await call(ws, "close", handle=handle)
                assert Path(path).read_bytes() == data * 3
                opened = (await call(ws, "open", path=path)).fs_response.opened.handle
                read = (await call(ws, "read", handle=opened, offset=123, length=700)).fs_response.read
                assert read.payload == (data * 3)[123:823]
                assert (await call(ws, "read", handle=opened, length=MAX_CHUNK + 1)).fs_response.error.code == "invalid_request"
                async with websockets.connect(url) as other:
                    await authenticate(other, key, "fs-test", node_id, public_key)
                    assert (await call(other, "read", handle=opened, length=1)).fs_response.error.code == "invalid_handle"
                await call(ws, "close", handle=opened)
                assert (await call(ws, "read", handle=opened, length=1)).fs_response.error.code == "invalid_handle"
                directory = tmp_path / "items"
                directory.mkdir()
                for i in range(270):
                    (directory / f"{i}-文件.txt").write_text(str(i))
                cursor = (await call(ws, "open_directory", path=str(directory))).fs_response.opened.handle
                names = []
                pages = 0
                while True:
                    response = await call(ws, "read_directory", handle=cursor)
                    assert response.ByteSize() < 65536
                    page = response.fs_response.directory
                    names.extend(item.name for item in page.entries)
                    pages += 1
                    if page.eof:
                        break
                assert pages >= 3 and len(set(names)) == 270
                assert (await call(ws, "remove", path=str(directory))).fs_response.error.code == "not_empty"
                destination = tmp_path / "existing.bin"
                destination.write_bytes(b"old")
                assert (await call(ws, "rename", source=path, target=str(destination))).fs_response.error.code == "already_exists"
                await call(ws, "rename", source=path, target=str(destination), replace=True)
                assert destination.read_bytes() == data * 3
                # A WS disconnect must close the OS handle, including pending I/O.
                handle = (await call(ws, "open", path=str(destination))).fs_response.opened.handle
                client = next(client for client in server.clients if client.files._handles)
                fd = client.files._handles[handle][1]
            for _ in range(100):
                if not server.clients:
                    break
                await asyncio.sleep(0.01)
            assert not server.clients
            try:
                os.fstat(fd)
                raise AssertionError("OS file descriptor leaked after disconnect")
            except OSError:
                pass
    asyncio.run(exercise())


class FileSystemTest(unittest.TestCase):
    def test_authenticated_filesystem(self):
        with tempfile.TemporaryDirectory() as folder:
            exercise_filesystem(Path(folder))
