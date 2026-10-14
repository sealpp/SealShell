import type { FileBackend } from './types'

export async function readFileContents(backend: FileBackend, path: string, size: number): Promise<ArrayBuffer> {
  const output = new Uint8Array(size)
  const reader = await backend.openReader?.(path)
  let offset = 0
  try {
    while (offset < size) {
      const length = Math.min(256 * 1024, size - offset)
      const chunk = reader ? await reader.read(offset, length) : await backend.read(path, offset, length)
      if (!chunk.byteLength) throw new Error('文件在读取完成前发生变化，请重新打开')
      output.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }
    return output.buffer
  } finally { await reader?.close() }
}
