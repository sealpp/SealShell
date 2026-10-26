import { computed, onBeforeUnmount, ref, watch, type WatchSource } from 'vue'

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'error'
const statusLabels: Record<AutosaveState, string> = {
  idle: '修改后自动保存', pending: '等待自动保存…', saving: '正在保存…', saved: '已自动保存', invalid: '输入未完成', error: '保存失败',
}

/** Validate a complete draft, coalesce typing, and serialize durable writes. */
export function useAutosave<T>(source: WatchSource<T>, validate: (value: T) => void, persist: (value: T) => Promise<void>, delay = 300) {
  const error = ref('')
  const state = ref<AutosaveState>('idle')
  const status = computed(() => statusLabels[state.value])
  let pending: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  let revision = 0

  async function flush(): Promise<boolean> {
    clearTimeout(timer)
    if (pending === undefined) { await queue; return !error.value || state.value === 'invalid' }
    const value = pending
    const savingRevision = revision
    pending = undefined
    state.value = 'saving'
    let success = true
    queue = queue.then(async () => {
      try {
        await persist(value)
        if (savingRevision === revision) { error.value = ''; state.value = 'saved' }
      } catch (reason) {
        success = false
        if (savingRevision === revision) {
          pending = value
          error.value = reason instanceof Error ? reason.message : String(reason)
          state.value = 'error'
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
    catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); state.value = 'invalid'; return }
    error.value = ''
    pending = value
    state.value = 'pending'
    timer = setTimeout(() => { void flush() }, delay)
  }, { deep: true, flush: 'sync' })

  onBeforeUnmount(() => { void flush() })
  return { error, state, status, flush }
}
