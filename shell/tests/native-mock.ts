import { installNativeAdapter, type NativeEvent } from '../src/native/bridge'

// Explicit browser-only fixture. Never imported by the shipped application.
const key = 'sealshell-browser-test-records'
const listeners = new Set<(event: NativeEvent) => void>()
const records: Record<string, Record<string, any>> = JSON.parse(localStorage.getItem(key) ?? '{}')
export const nativeFixture = {
  handlers: {} as Record<string, (args: any) => any>,
  emit(event: NativeEvent) { listeners.forEach(handler => handler(event)) },
}
installNativeAdapter({
  async subscribe(handler) { listeners.add(handler); return () => { listeners.delete(handler) } },
  async call<T>(operation: string, args: any): Promise<T> {
    if (nativeFixture.handlers[operation]) return nativeFixture.handlers[operation](args)
    let result: unknown
    if (operation === 'store_get') result = records[args.collection]?.[args.key] ?? null
    else if (operation === 'store_list') result = Object.values(records[args.collection] ?? {})
    else if (operation === 'store_write') {
      if (args.requireHost && !records.hosts?.[args.requireHost]) return false as T
      for (const change of args.changes) {
        const collection = records[change.collection] ??= {}
        if (change.value === undefined || change.value === null) delete collection[change.key]
        else collection[change.key] = structuredClone(change.value)
      }
      localStorage.setItem(key, JSON.stringify(records)); result = true
    } else if (operation === 'credential_protect') result = { id: args.id, ciphertext: JSON.stringify(args.value) }
    else if (operation === 'credential_unprotect') result = JSON.parse(args.record.ciphertext)
    else if (operation === 'transfer_list') result = []
    else if (operation === 'transfer_concurrency') result = args.value
    else if (operation.endsWith('_close') || operation.endsWith('_cancel') || operation === 'host_key_decision') result = undefined
    else if (operation === 'http_request') {
      const response = await fetch(args.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.apiKey}` }, body: JSON.stringify(args.body) })
      if (!response.ok) throw new Error(`云端推荐失败（HTTP ${response.status}）`)
      result = await response.text()
    } else throw new Error(`Native browser fixture unavailable: ${operation}`)
    return result as T
  },
})
