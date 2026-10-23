export interface ProcessRow {
  key: string
  pid: number
  ppid: number
  uid: number
  user: string
  state: string
  name: string
  command: string
  argv: string[]
  rss: number
  threads: number
  startTicks: number
  startedAt: number
  cpuTicks: number
  cpu: number | null
}

export interface ProcessSnapshot {
  bootId: string
  hz: number
  uptime: number
  rows: ProcessRow[]
}
export type ProcessSignal = 'TERM' | 'KILL'
export type ProcessScope = 'selected' | 'tree'
export interface ProcessPlan {
  generation: number
  signal: ProcessSignal
  scope: ProcessScope
  targets: ProcessRow[]
  bootId: string
}
export interface ProcessOutcome {
  key: string
  pid: number
  name: string
  status: 'sent' | 'gone' | 'changed' | 'denied' | 'failed'
}
export interface ProcessesState {
  address: string
  port: number
  username: string
  needsPassword: boolean
  unsupported: boolean
  loading: boolean
  busy: boolean
  paused: boolean
  rows: ProcessRow[]
  sampledAt: number | null
  actionError: string
  outcomes: ProcessOutcome[]
}
