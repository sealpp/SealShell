import { describe, expect, it } from 'vitest'
import { RoutedTransport } from './routed-transport'
import { normalizeTarget, ProxyError, type ByteTransport, type ProxyConnection } from './types'

const text = (value: string) => new TextEncoder().encode(value)
const http: ProxyConnection = { type: 'http', host: 'proxy.example', port: 8080, authentication: 'none', username: '' }
const socks: ProxyConnection = { ...http, type: 'socks5', port: 1080 }

class Wire implements ByteTransport {
  targets: unknown[] = []
  sent: Uint8Array[] = []
  closed = false
  handler: (data: Uint8Array) => void = () => undefined
  waiters: Array<() => void> = []
  reply: (data: Uint8Array) => void = () => undefined
  onData(handler: (data: Uint8Array) => void) { this.handler = handler }
  async connect(host: string, port: number) { this.targets.push({ host, port }) }
  async send(data: Uint8Array) { this.sent.push(data); this.reply(data) }
  receive(data: Uint8Array) { this.handler(data); this.waiters.splice(0).forEach(wake => wake()) }
  async waitForData(ms = 1000) {
    if (this.closed) throw new Error('peer closed')
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); this.waiters = this.waiters.filter(item => item !== wake); resolve() }
      const timer = setTimeout(wake, ms)
      this.waiters.push(wake)
    })
  }
  async close() { this.closed = true; this.waiters.splice(0).forEach(wake => wake()) }
}

describe('TCP proxy routes', () => {
  it('passes direct data without a proxy handshake', async () => {
    const wire = new Wire()
    const route = new RoutedTransport(wire)
    const output: Uint8Array[] = []
    route.onData(bytes => output.push(bytes))
    await route.connect('target.example', 22)
    wire.receive(text('SSH-2.0-server\r\n'))
    expect(wire.targets).toEqual([{ host: 'target.example', port: 22 }])
    expect(wire.sent).toEqual([])
    expect(output).toEqual([text('SSH-2.0-server\r\n')])
  })

  it('parses a fragmented HTTP response and preserves a coalesced SSH banner', async () => {
    const wire = new Wire()
    const route = new RoutedTransport(wire)
    const output: Uint8Array[] = []
    route.onData(bytes => output.push(bytes))
    wire.reply = () => {
      wire.receive(text('HTTP/1.1 200 Connection'))
      setTimeout(() => wire.receive(text(' established\r\n\r\nSSH-2.0-test\r\n')), 1)
    }
    await route.connect('internal.example', 22, { ...http, authentication: 'password', username: 'alice', password: 'secret' })
    expect(wire.targets).toEqual([{ host: 'proxy.example', port: 8080 }])
    expect(new TextDecoder().decode(wire.sent[0])).toBe('CONNECT internal.example:22 HTTP/1.1\r\nHost: internal.example:22\r\nProxy-Authorization: Basic YWxpY2U6c2VjcmV0\r\n\r\n')
    expect(output).toEqual([text('SSH-2.0-test\r\n')])
    await route.send(text('client application bytes'))
    expect(wire.sent[1]).toEqual(text('client application bytes'))
  })

  it('supports informational responses and IPv6 HTTP authorities', async () => {
    const wire = new Wire()
    wire.reply = () => wire.receive(text('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n'))
    await new RoutedTransport(wire).connect('::1', 2222, http)
    expect(new TextDecoder().decode(wire.sent[0])).toContain('CONNECT [::1]:2222 HTTP/1.1')
  })

  it('reports HTTP authentication failure without leaking credentials or dialing the target directly', async () => {
    const wire = new Wire()
    wire.reply = () => wire.receive(text('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'))
    const result = new RoutedTransport(wire).connect('internal.example', 22, { ...http, authentication: 'password', username: 'alice', password: 'secret' })
    await expect(result).rejects.toMatchObject({ code: 'PROXY_ERROR', stage: 'authenticate' })
    expect(wire.closed).toBe(true)
    expect(wire.targets).toEqual([{ host: 'proxy.example', port: 8080 }])
  })

  it.each([false, true])('negotiates SOCKS5 (password: %s), sends the domain, and consumes only the SOCKS response', async authenticated => {
    const wire = new Wire()
    const output: Uint8Array[] = []
    const route = new RoutedTransport(wire)
    route.onData(bytes => output.push(bytes))
    wire.reply = bytes => {
      if (bytes.length === 3) {
        expect([...bytes]).toEqual([5, 1, authenticated ? 2 : 0])
        wire.receive(Uint8Array.of(5))
        setTimeout(() => wire.receive(Uint8Array.of(authenticated ? 2 : 0)), 1)
      } else if (bytes[0] === 1) {
        expect([...bytes]).toEqual([1, 1, 117, 1, 112])
        wire.receive(Uint8Array.of(1, 0))
      } else {
        expect([...bytes]).toEqual([5, 1, 0, 3, 8, ...text('internal'), 0, 22])
        wire.receive(Uint8Array.from([5, 0, 0, 1, 127, 0, 0, 1, 9, 9, ...text('SSH-2.0-test\r\n')]))
      }
    }
    await route.connect('internal', 22, authenticated ? { ...socks, authentication: 'password', username: 'u', password: 'p' } : socks)
    expect(output).toEqual([text('SSH-2.0-test\r\n')])
    expect(wire.targets).toEqual([{ host: 'proxy.example', port: 1080 }])
  })

  it('encodes IPv6 SOCKS destinations and accepts a domain bound address', async () => {
    const wire = new Wire()
    wire.reply = bytes => {
      if (bytes.length === 3) wire.receive(Uint8Array.of(5, 0))
      else wire.receive(Uint8Array.from([5, 0, 0, 3, 1, 120, 0, 1]))
    }
    await new RoutedTransport(wire).connect('2001:db8::1', 22, socks)
    expect([...wire.sent[1]]).toEqual([5, 1, 0, 4, 32, 1, 13, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 22])
  })

  it('refuses authentication downgrade and closes a timed out handshake', async () => {
    const wire = new Wire()
    wire.reply = () => wire.receive(Uint8Array.of(5, 0))
    await expect(new RoutedTransport(wire).connect('internal', 22, { ...socks, authentication: 'password', username: 'u', password: 'p' })).rejects.toMatchObject({ stage: 'authenticate' })
    expect(wire.closed).toBe(true)
    const silent = new Wire()
    await expect(new RoutedTransport(silent, 10).connect('internal', 22, http)).rejects.toBeInstanceOf(ProxyError)
    expect(silent.closed).toBe(true)
  })

  it('rejects oversized headers and target rejection without direct fallback', async () => {
    for (const response of ['HTTP/1.1 403 Forbidden\r\n\r\n', 'x'.repeat(17000)]) {
      const wire = new Wire()
      wire.reply = () => wire.receive(text(response))
      await expect(new RoutedTransport(wire).connect('internal', 22, http)).rejects.toMatchObject({ stage: 'target' })
      expect(wire.closed).toBe(true)
      expect(wire.targets).toHaveLength(1)
    }
  })

  it('validates addresses before emitting a CONNECT request', () => {
    for (const host of ['host\r\nAuthorization: secret', 'http://host', 'host/path', 'user@host', 'host:22']) {
      expect(() => normalizeTarget({ host, port: 22 })).toThrow()
    }
    expect(normalizeTarget({ host: '[::1]', port: 22 })).toEqual({ host: '::1', port: 22 })
  })
})
