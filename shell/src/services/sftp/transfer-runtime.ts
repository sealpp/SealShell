import { reactive } from 'vue'
import { nativeCall, nativeEvents, type NativeEvent } from '../../native/bridge'
import { readMeta, saveMeta } from '../storage'
import { initializeNativeEvents } from '../native-events'
import { choiceDialog, promptDialog } from '../dialogs'
import type { TransferResult, TransferTaskSnapshot } from './transfer'

const DEFAULT_CONCURRENCY = 2
export const transferRuntime = reactive({ concurrency: DEFAULT_CONCURRENCY, tasks: [] as TransferTaskSnapshot[], panelOpen: false })
let initialized: Promise<void> | undefined

function update(snapshot: TransferTaskSnapshot): void {
  const index = transferRuntime.tasks.findIndex(task => task.id === snapshot.id)
  if (index < 0) transferRuntime.tasks.push(snapshot)
  else transferRuntime.tasks[index] = snapshot
}
async function resolveConflict(event: NativeEvent): Promise<void> {
  let decision: { action: string; name?: string; all?: boolean } = { action: 'cancel' }
  try {
    const choice = await choiceDialog('目标已存在', `${event.path}\n${event.kind === 'directory' ? '替换整个目录，目标中源目录没有的文件也会永久删除。' : '替换会覆盖目标文件。'}`, [
      { value: 'replace', label: event.kind === 'directory' ? '整目录替换' : '覆盖' },
      { value: 'skip', label: '跳过' }, { value: 'rename', label: '重命名副本' },
    ], '将选择应用于本批剩余同类型重名项目')
    if (choice) {
      decision = { action: choice.value, all: choice.checked }
      if (choice.value === 'rename') {
        const name = await promptDialog('重命名副本', String(event.path).split(/[\\/]/).pop() ?? '')
        decision = name === null ? { action: 'skip' } : { action: 'rename', name }
      }
    }
  } finally { await nativeCall('transfer_decision', { requestId: event.requestId, decision }) }
}
async function initialize(): Promise<void> {
  return initialized ??= (async () => {
    await initializeNativeEvents()
    await nativeEvents(event => {
      if (event.type === 'transfer') update(event.task)
      if (event.type === 'conflict') void resolveConflict(event)
    })
    transferRuntime.tasks = await nativeCall('transfer_list')
  })()
}
export async function loadTransferConcurrency(): Promise<number> {
  await initialize()
  const stored = await readMeta<{ key: string; value: number }>('sftpTransferConcurrency')
  return transferRuntime.concurrency = await nativeCall('transfer_concurrency', { value: stored?.value ?? DEFAULT_CONCURRENCY })
}
export async function setTransferConcurrency(value: number): Promise<number> {
  transferRuntime.concurrency = await nativeCall('transfer_concurrency', { value: Math.max(1, Math.min(4, Math.floor(value) || 2)) })
  await saveMeta({ key: 'sftpTransferConcurrency', value: transferRuntime.concurrency })
  return transferRuntime.concurrency
}
export async function enqueueTransfer(label: string, spec: { sourceId: string; targetId: string; paths: string[]; directory: string; moveFiles: boolean }): Promise<TransferResult> {
  await initialize()
  const id = crypto.randomUUID()
  await nativeCall('transfer_enqueue', { id, label, ...spec })
  return nativeCall('transfer_wait', { id })
}
export async function cancelTransfer(id: string): Promise<boolean> { return nativeCall('transfer_cancel', { id }) }
export async function retryTransfer(id: string): Promise<boolean> { return nativeCall('transfer_retry', { id }) }
export async function dismissTransfer(id: string): Promise<void> {
  if (await nativeCall<boolean>('transfer_dismiss', { id })) transferRuntime.tasks = transferRuntime.tasks.filter(task => task.id !== id)
}
