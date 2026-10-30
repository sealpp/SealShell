import { nativeFixture } from './native-mock'
import { transferRuntime } from '../src/services/sftp/transfer-runtime'
import type { TransferResult, TransferTaskSnapshot } from '../src/services/sftp/transfer'

export class TransferCancelledError extends Error { constructor() { super('传输已取消') } }
interface Job { snapshot: TransferTaskSnapshot; run: (signal: AbortSignal, progress: (bytes: number, total: number) => void) => Promise<TransferResult>; cancel: AbortController; resolve: (value: TransferResult) => void; reject: (error: unknown) => void }
const jobs = new Map<string, Job>()
let running = 0
function pump() {
  for (const job of jobs.values()) {
    if (running >= 2) return
    if (job.snapshot.state !== 'queued') continue
    running++; job.snapshot.state = 'running'
    void job.run(job.cancel.signal, (bytes, total) => { job.snapshot.progress = bytes / total }).then(result => {
      job.snapshot.state = 'completed'; job.snapshot.progress = 1; job.snapshot.result = result; job.snapshot.orphanPath = result.orphanPath; job.resolve(result)
    }, error => {
      job.snapshot.state = job.cancel.signal.aborted ? 'cancelled' : 'failed'; job.snapshot.error = error.message; job.reject(error)
    }).finally(() => { running--; pump() })
  }
}
export function enqueueTransfer(label: string, run: Job['run']) {
  const id = crypto.randomUUID()
  const promise = new Promise<TransferResult>((resolve, reject) => {
    transferRuntime.tasks.push({ id, label, state: 'queued', progress: 0 })
    jobs.set(id, { snapshot: transferRuntime.tasks.at(-1)!, run, cancel: new AbortController(), resolve, reject })
  })
  pump(); return { id, promise }
}
export function cancelTransfer(id: string) {
  const job = jobs.get(id)
  if (!job) return false
  job.cancel.abort()
  if (job.snapshot.state === 'queued') { job.snapshot.state = 'cancelled'; job.reject(new TransferCancelledError()) }
  return true
}
nativeFixture.handlers.transfer_cancel = ({ id }) => cancelTransfer(id)
nativeFixture.handlers.transfer_retry = ({ id }) => {
  const job = jobs.get(id)
  if (!job) return false
  job.cancel = new AbortController(); job.snapshot.state = 'queued'; job.snapshot.error = undefined; job.snapshot.progress = 0; pump(); return true
}
nativeFixture.handlers.transfer_dismiss = ({ id }) => jobs.delete(id)
