import { computed, shallowReactive } from 'vue'

/** Activity owners declare blockers; exit adapters decide how to present them. */
export class CloseProtection {
  private readonly sources = shallowReactive(new Map<symbol, { reason: string; isActive: () => boolean }>())

  readonly reasons = computed(() => [...this.sources.values()].filter(source => source.isActive()).map(source => source.reason))
  readonly blocked = computed(() => this.reasons.value.length > 0)

  register(reason: string, isActive: () => boolean): () => void {
    const token = Symbol(reason)
    this.sources.set(token, { reason, isActive })
    return () => { this.sources.delete(token) }
  }

  /** Hold across the entire operation, including queued work and async cleanup. */
  acquire(reason: string): () => void {
    return this.register(reason, () => true)
  }
}

export const closeProtection = new CloseProtection()
