export interface PortRule {
  id: string
  host: string
  port: number
  localPort: number
  enabled: boolean
}
export interface PortRow extends PortRule {
  configured: boolean
  listening: boolean | null
  status: 'disabled' | 'connecting' | 'active' | 'failed'
  error: string
}
export interface PortsState {
  address: string
  port: number
  username: string
  rows: PortRow[]
  needsPassword: boolean
  discovery: 'connecting' | 'ready' | 'unsupported' | 'failed'
  discoveryError: string
  saveError: string
}
export type PortBindHost = '127.0.0.1' | '0.0.0.0'
