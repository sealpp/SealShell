import { listen } from '@tauri-apps/api/event'

interface DropResult { id: string; paths?: string[]; error?: string }

export async function droppedFilePaths(files: File[]): Promise<string[]> {
  const send = (window as unknown as { __SEALSHELL_FILE_DROP__?: (files: File[], id: string) => void }).__SEALSHELL_FILE_DROP__
  if (!send) throw new Error('当前桌面环境不支持读取拖入文件的本机路径')
  const id = crypto.randomUUID()
  let receive!: (value: DropResult) => void
  const result = new Promise<DropResult>(resolve => { receive = resolve })
  const stop = await listen<DropResult>('file-drop-paths', event => {
    if (event.payload.id === id) receive(event.payload)
  })
  try {
    send(files, id)
    const response = await result
    if (response.error) throw new Error(response.error)
    if (!response.paths?.length || response.paths.some(path => !path)) throw new Error('拖入项目没有可读取的本机路径')
    return response.paths
  } finally { stop() }
}
