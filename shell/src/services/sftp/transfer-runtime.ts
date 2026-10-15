import { reactive } from 'vue'
import { readMeta, saveMeta } from '../storage'
import { TransferQueue, type TransferResult, type TransferTaskSnapshot } from './transfer'

const DEFAULT_CONCURRENCY = 2
const transferQueue = new TransferQueue(DEFAULT_CONCURRENCY)
export const transferRuntime = reactive({
  concurrency: DEFAULT_CONCURRENCY,
  tasks: [] as TransferTaskSnapshot[],
  panelOpen: false,
})

transferQueue.subscribe((snapshot) => {
  const index = transferRuntime.tasks.findIndex((task) => task.id === snapshot.id)
  if (index < 0) transferRuntime.tasks.push(snapshot)
  else transferRuntime.tasks[index] = snapshot
})

export async function loadTransferConcurrency(): Promise<number> {
  const stored = await readMeta<{ key: string; value: number }>('sftpTransferConcurrency')
  transferRuntime.concurrency = transferQueue.setConcurrency(stored?.value ?? DEFAULT_CONCURRENCY)
  return transferRuntime.concurrency
}

export async function setTransferConcurrency(value: number): Promise<number> {
  const concurrency = transferQueue.setConcurrency(value)
  transferRuntime.concurrency = concurrency
  await saveMeta({ key: 'sftpTransferConcurrency', value: concurrency })
  return concurrency
}

export function enqueueTransfer(label: string, run: (signal: AbortSignal, progress: (bytes: number, total: number) => void) => Promise<TransferResult>): { id: string; promise: Promise<TransferResult> } {
  transferRuntime.panelOpen = true
  return transferQueue.enqueue(label, run)
}

export function cancelTransfer(id: string): boolean { return transferQueue.cancel(id) }
export function retryTransfer(id: string): boolean { return transferQueue.retry(id) }
export function dismissTransfer(id: string): void { transferRuntime.tasks = transferRuntime.tasks.filter((task) => task.id !== id) }
