"""Loopback-only HTTP CONNECT/SOCKS5 fixtures; targets are restricted to mock SSH."""
import asyncio
import base64
import json
import os
from pathlib import Path

TARGET_PORT = int(os.environ['MOCK_PROXY_TARGET_PORT'])
STATE_PATH = Path(os.environ['MOCK_PROXY_STATE_PATH'])
state = {'connections': [], 'authentication_failures': 0, 'target_failures': 0}


def record():
    temporary = STATE_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(state), encoding='utf-8')
    temporary.replace(STATE_PATH)


async def transfer(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()
    if writer.can_write_eof():
        writer.write_eof()


async def connect(protocol, host, port, authenticated):
    if host not in ('internal.proxy.test', '127.0.0.1', '::1') or port != TARGET_PORT:
        state['target_failures'] += 1
        record()
        raise OSError('fixture refuses target')
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    state['connections'].append({'protocol': protocol, 'host': host, 'port': port, 'authenticated': authenticated})
    record()
    return reader, writer


async def fragmented(writer, payload):
    writer.write(payload[:3])
    await writer.drain()
    await asyncio.sleep(0.005)
    writer.write(payload[3:])
    await writer.drain()


async def http(reader, writer):
    remote = None
    try:
        header = (await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)).decode('ascii')
        method, authority, _ = header.split('\r\n', 1)[0].split(' ')
        if method != 'CONNECT':
            return
        headers = dict(line.split(':', 1) for line in header.split('\r\n')[1:] if ':' in line)
        authorization = next((value.strip() for key, value in headers.items() if key.lower() == 'proxy-authorization'), '')
        expected = 'Basic ' + base64.b64encode(b'proxy-user:proxy-pass').decode()
        if authorization and authorization != expected:
            state['authentication_failures'] += 1
            record()
            await fragmented(writer, b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\n\r\n')
            return
        host, port = authority.rsplit(':', 1)
        try:
            incoming, remote = await connect('http', host.strip('[]'), int(port), bool(authorization))
        except OSError:
            await fragmented(writer, b'HTTP/1.1 403 Forbidden\r\n\r\n')
            return
        banner = await incoming.read(1024)
        await fragmented(writer, b'HTTP/1.1 200 Connection Established\r\n\r\n' + banner)
        await asyncio.gather(transfer(reader, remote), transfer(incoming, writer))
    except (OSError, EOFError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ValueError):
        pass
    finally:
        writer.close()
        if remote:
            remote.close()


async def socks(reader, writer):
    remote = None
    try:
        version, count = await reader.readexactly(2)
        methods = await reader.readexactly(count)
        if version != 5:
            return
        method = 2 if 2 in methods else 0 if 0 in methods else 255
        writer.write(bytes([5, method]))
        await writer.drain()
        if method == 255:
            return
        if method == 2:
            version, size = await reader.readexactly(2)
            username = await reader.readexactly(size)
            size = (await reader.readexactly(1))[0]
            password = await reader.readexactly(size)
            accepted = version == 1 and username == b'proxy-user' and password == b'proxy-pass'
            writer.write(bytes([1, 0 if accepted else 1]))
            await writer.drain()
            if not accepted:
                state['authentication_failures'] += 1
                record()
                return
        version, command, _, kind = await reader.readexactly(4)
        if version != 5 or command != 1:
            return
        if kind == 3:
            host = (await reader.readexactly((await reader.readexactly(1))[0])).decode()
        elif kind == 1:
            host = '.'.join(str(byte) for byte in await reader.readexactly(4))
        else:
            import ipaddress
            host = str(ipaddress.IPv6Address(await reader.readexactly(16)))
        port = int.from_bytes(await reader.readexactly(2), 'big')
        try:
            incoming, remote = await connect('socks5', host, port, method == 2)
        except OSError:
            await fragmented(writer, bytes([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
            return
        banner = await incoming.read(1024)
        await fragmented(writer, bytes([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]) + banner)
        await asyncio.gather(transfer(reader, remote), transfer(incoming, writer))
    except (OSError, EOFError, asyncio.IncompleteReadError, ValueError):
        pass
    finally:
        writer.close()
        if remote:
            remote.close()


async def main():
    record()
    first = await asyncio.start_server(http, '127.0.0.1', 0)
    second = await asyncio.start_server(socks, '127.0.0.1', 0)
    print('MOCK_PROXY_PORTS=' + json.dumps({'http': first.sockets[0].getsockname()[1], 'socks5': second.sockets[0].getsockname()[1]}), flush=True)
    async with first, second:
        await asyncio.gather(first.serve_forever(), second.serve_forever())


asyncio.run(main())
