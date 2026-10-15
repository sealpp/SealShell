import { onBeforeUnmount, ref, watch, type WatchSource } from 'vue'

/** Validate a complete draft, coalesce typing, and serialize durable writes. */
export function useAutosave<T>(source: WatchSource<T>, validate: (value: T) => void, persist: (value: T) => Promise<void>, delay = 300) {
  const error = ref('')
  const status = ref('修改后自动保存')
  let pending: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  let revision = 0

  async function flush(): Promise<boolean> {
    clearTimeout(timer)
    if (pending === undefined) { await queue; return !error.value || status.value === '输入未完成' }
    const value = pending
    const savingRevision = revision
    pending = undefined
    status.value = '正在保存…'
    let success = true
    queue = queue.then(async () => {
      try {
        await persist(value)
        if (savingRevision === revision) { error.value = ''; status.value = '已自动保存' }
      } catch (reason) {
        success = false
        if (savingRevision === revision) {
          pending = value
          error.value = reason instanceof Error ? reason.message : String(reason)
          status.value = '保存失败'
        }
      }
    })
    await queue
    return success
  }

  watch(source, value => {
    revision++
    clearTimeout(timer)
    pending = undefined
    try { validate(value) }
    catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); status.value = '输入未完成'; return }
    error.value = ''
    pending = value
    status.value = '等待自动保存…'
    timer = setTimeout(() => { void flush() }, delay)
  }, { deep: true, flush: 'sync' })

  onBeforeUnmount(() => { void flush() })
  return { error, status, flush }
}
