import { NodeTcpTransport } from './node-transport'
import { normalizeTarget, ProxyError, validateProxy, type ByteTransport, type ProxyConnection, type ProxyStage, type TcpTarget } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HTTP_HEADER_LIMIT = 16 * 1024

function socksAddress(host: string): Uint8Array {
  if (host.includes(':')) {
    // URL normalization expands an IPv4 tail to hex and validates IPv6 syntax.
    const [left, right] = host.split('::').map(part => part ? part.split(':') : [])
    const words = right ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
    return Uint8Array.from([4, ...words.flatMap(word => { const n = parseInt(word, 16); return [n >> 8, n & 255] })])
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return Uint8Array.from([1, ...host.split('.').map(Number)])
  const domain = encoder.encode(host)
  if (domain.length > 255) throw new Error('目标域名不能超过 255 字节')
  return Uint8Array.from([3, domain.length, ...domain])
}

/** A byte stream whose route is resolved before the application protocol starts. */
export class RoutedTransport implements ByteTransport {
  private incoming = new Uint8Array()
  private forwarding = false
  private handler?: (payload: Uint8Array) => void
  private deadline = 0
  private stage: ProxyStage = 'connect'

  constructor(private readonly base: ByteTransport = new NodeTcpTransport(), private readonly timeoutMs = 10000) {
    base.onData(payload => {
      if (this.forwarding) this.handler?.(payload)
      else {
        const bytes = new Uint8Array(this.incoming.length + payload.length)
        bytes.set(this.incoming)
        bytes.set(payload, this.incoming.length)
        this.incoming = bytes
      }
    })
  }

  onData(handler: (payload: Uint8Array) => void): void { this.handler = handler }
  send(payload: Uint8Array): Promise<void> { return this.base.send(payload) }
  waitForData(timeoutMs = 0): Promise<void> { return this.base.waitForData(timeoutMs) }
  close(reason = 'session_closed'): Promise<void> { return this.base.close(reason) }

  async connect(host: string, port: number, proxy?: ProxyConnection, onStage?: (stage: ProxyStage) => void): Promise<void> {
    const target = normalizeTarget({ host, port })
    try {
      if (proxy) validateProxy(proxy, proxy.password)
      const endpoint = proxy ? normalizeTarget(proxy) : target
      onStage?.(this.stage)
      await this.base.connect(endpoint.host, endpoint.port)
      this.deadline = Date.now() + this.timeoutMs
      if (proxy) {
        if (proxy.authentication === 'password' && proxy.password === undefined) throw new ProxyError('authenticate', '尚未设置代理密码')
        if (proxy.type === 'socks5') await this.socks(proxy, target, onStage)
        else await this.http(proxy, target, onStage)
      }
      this.forwarding = true
      const remaining = this.incoming
      this.incoming = new Uint8Array()
      if (remaining.length) this.handler?.(remaining)
    } catch (error) {
      await this.base.close('connection_failed')
      if (!proxy || error instanceof ProxyError) throw error
      throw new ProxyError(this.stage, error instanceof Error ? error.message : String(error))
    }
  }

  private setStage(stage: ProxyStage, callback?: (stage: ProxyStage) => void): void { this.stage = stage; callback?.(stage) }

  private async wait(): Promise<void> {
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) throw new Error('等待代理响应超时')
    await this.base.waitForData(remaining)
  }

  private take(length: number): Uint8Array {
    const result = this.incoming.slice(0, length)
    this.incoming = this.incoming.slice(length)
    return result
  }

  private async read(length: number): Promise<Uint8Array> {
    while (this.incoming.length < length) await this.wait()
    return this.take(length)
  }

  private async socks(proxy: ProxyConnection, target: TcpTarget, onStage?: (stage: ProxyStage) => void): Promise<void> {
    this.setStage('authenticate', onStage)
    const method = proxy.authentication === 'password' ? 2 : 0
    await this.base.send(Uint8Array.of(5, 1, method))
    const choice = await this.read(2)
    if (choice[0] !== 5 || choice[1] !== method) throw new Error('代理不接受所选认证方式')
    if (method === 2) {
      const user = encoder.encode(proxy.username)
      const password = encoder.encode(proxy.password!)
      await this.base.send(Uint8Array.from([1, user.length, ...user, password.length, ...password]))
      const auth = await this.read(2)
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error('用户名或密码不正确')
    }
    this.setStage('target', onStage)
    await this.base.send(Uint8Array.from([5, 1, 0, ...socksAddress(target.host), target.port >> 8, target.port & 255]))
    const reply = await this.read(4)
    if (reply[0] !== 5 || reply[2] !== 0) throw new Error('无效的 SOCKS5 响应')
    if (reply[1] !== 0) {
      const reasons = ['成功', '代理内部错误', '代理规则拒绝访问', '目标网络不可达', '目标主机不可达', '目标拒绝连接', '连接超时', '不支持 CONNECT', '不支持目标地址类型']
      throw new Error(reasons[reply[1]] ?? `SOCKS5 错误 ${reply[1]}`)
    }
    const size = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await this.read(1))[0] : -1
    if (size < 0) throw new Error('无效的 SOCKS5 地址类型')
    await this.read(size + 2)
  }

  private async http(proxy: ProxyConnection, target: TcpTarget, onStage?: (stage: ProxyStage) => void): Promise<void> {
    this.setStage('target', onStage)
    const authority = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`
    let authorization = ''
    if (proxy.authentication === 'password') {
      const encoded = encoder.encode(`${proxy.username}:${proxy.password}`)
      authorization = `Proxy-Authorization: Basic ${btoa(Array.from(encoded, byte => String.fromCharCode(byte)).join(''))}\r\n`
    }
    await this.base.send(encoder.encode(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`))
    for (;;) {
      let end = -1
      for (let i = 0; i + 3 < this.incoming.length; i++) {
        if (this.incoming[i] === 13 && this.incoming[i + 1] === 10 && this.incoming[i + 2] === 13 && this.incoming[i + 3] === 10) { end = i + 4; break }
      }
      if ((end < 0 && this.incoming.length > HTTP_HEADER_LIMIT) || end > HTTP_HEADER_LIMIT) throw new Error('HTTP 代理响应头过长')
      if (end < 0) { await this.wait(); continue }
      const header = decoder.decode(this.take(end))
      const match = /^HTTP\/1\.[01] (\d{3})(?:[ \r])/.exec(header)
      if (!match) throw new Error('无效的 HTTP CONNECT 响应')
      const status = Number(match[1])
      if (status >= 100 && status < 200) continue
      if (status === 407) throw new ProxyError('authenticate', '代理拒绝凭据或需要其他认证方式')
      if (status < 200 || status >= 300) throw new Error(`HTTP CONNECT 返回 ${status}`)
      return
    }
  }
}
