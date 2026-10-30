import type { ProxySource } from '../proxy/types'

export interface TransferResult {
  sourcePath: string; targetPath: string; bytes: number; atomic: boolean; metadataApplied: boolean; orphanPath?: string
}
export type TransferTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export interface TransferTaskSnapshot {
  id: string; label: string; state: TransferTaskState; progress: number
  error?: string; proxySource?: ProxySource; result?: TransferResult; orphanPath?: string
}
