import type { ProxyConnection, ProxyDefinition } from '../transport/types'

export interface ProxyProfile extends ProxyDefinition { id: string; name: string }
export interface HostProxySettings {
  enabled: boolean
  mode: 'inline' | 'saved'
  inline: ProxyDefinition
  savedId: string | null
}
export type ProxySource = { kind: 'saved' | 'host'; id: string }
export interface RemoteConnection {
  host: string
  port: number
  username: string
  password: string
  proxy?: ProxyConnection
  proxySource?: ProxySource
}

export function defaultProxy(): ProxyDefinition {
  return { type: 'http', host: '', port: 8080, authentication: 'none', username: '' }
}
export function defaultHostProxy(): HostProxySettings {
  return { enabled: false, mode: 'inline', inline: defaultProxy(), savedId: null }
}
export function copyHostProxy(value?: HostProxySettings): HostProxySettings {
  return value ? { ...value, inline: { ...value.inline } } : defaultHostProxy()
}
export function copyConnection(value: RemoteConnection): RemoteConnection {
  return { ...value, proxy: value.proxy ? { ...value.proxy } : undefined, proxySource: value.proxySource ? { ...value.proxySource } : undefined }
}
