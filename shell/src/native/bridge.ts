import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface NativeEvent { type: string; id?: string; [key: string]: any }
export interface NativeAdapter {
  call<T>(operation: string, args: Record<string, unknown>): Promise<T>
  subscribe(handler: (event: NativeEvent) => void): Promise<() => void>
}
export class NativeCallError extends Error {
  constructor(readonly code: string, message: string, readonly orphanPath?: string) { super(message) }
}

let adapter: NativeAdapter | undefined
/** Browser harnesses explicitly install an adapter before mounting the app. */
export function installNativeAdapter(value: NativeAdapter): void { adapter = value }
export const isDesktop = isTauri

export async function nativeCall<T = void>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    if (adapter) return await adapter.call<T>(operation, args)
    if (!isTauri()) throw new Error('请从 SealShell 桌面应用打开；浏览器预览需要测试适配器。')
    return await invoke<T>('native_call', { operation, args })
  } catch (error) {
    if (error instanceof Error) throw error
    const value = error as { code?: string; message?: string; orphanPath?: string }
    throw new NativeCallError(value?.code ?? 'native_error', value?.message ?? String(error), value?.orphanPath)
  }
}

export async function nativeEvents(handler: (event: NativeEvent) => void): Promise<() => void> {
  if (adapter) return adapter.subscribe(handler)
  if (!isTauri()) return () => {}
  return listen<NativeEvent>('native-event', event => handler(event.payload))
}
