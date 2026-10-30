export interface TcpTarget { host: string; port: number }

export interface ProxyDefinition extends TcpTarget {
  type: 'http' | 'socks5'
  authentication: 'none' | 'password'
  username: string
}

export interface ProxyConnection extends ProxyDefinition { password?: string }

export type ProxyStage = 'connect' | 'authenticate' | 'target'

export class ProxyError extends Error {
  readonly code = 'PROXY_ERROR'
  constructor(readonly stage: ProxyStage, message: string) {
    super(`代理${{ connect: '连接', authenticate: '认证', target: '目标连接' }[stage]}失败：${message}`)
    this.name = 'ProxyError'
  }
}

export function normalizeTarget(target: TcpTarget): TcpTarget {
  const host = target.host.trim()
  if (!host || /[\s/@?#\\]/.test(host)) throw new Error('请输入有效的服务器地址，不包含协议或路径')
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('端口必须为 1–65535 的整数')
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  let parsed: URL
  try { parsed = new URL(`http://${authority}`) } catch { throw new Error('服务器地址无效') }
  if (parsed.port || parsed.pathname !== '/') throw new Error('地址与端口请分开填写')
  return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port: target.port }
}

export function validateProxy(proxy: ProxyDefinition, password?: string): void {
  normalizeTarget(proxy)
  if (proxy.authentication === 'password') {
    const encoder = new TextEncoder()
    const userLength = encoder.encode(proxy.username).length
    if (!userLength) throw new Error('请输入代理用户名')
    if (proxy.type === 'http' && proxy.username.includes(':')) throw new Error('HTTP 代理用户名不能包含冒号')
    if (proxy.type === 'socks5' && userLength > 255) throw new Error('SOCKS5 用户名不能超过 255 字节')
    if (password !== undefined && proxy.type === 'socks5' && (!encoder.encode(password).length || encoder.encode(password).length > 255)) {
      throw new Error('SOCKS5 密码必须为 1–255 字节')
    }
  }
}
