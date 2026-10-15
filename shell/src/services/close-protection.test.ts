import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { CloseProtection } from './close-protection'
import { attachBrowserCloseProtection } from './browser-close-protection'

function browser() {
  const target = new EventTarget()
  return { target, add: vi.spyOn(target, 'addEventListener'), remove: vi.spyOn(target, 'removeEventListener') }
}

function attemptExit(target: EventTarget): Event {
  const event = new Event('beforeunload', { cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('close protection', () => {
  it('listens only while reactive activity exists and changes synchronously', () => {
    const protection = new CloseProtection()
    const active = ref(false)
    const unregister = protection.register('connection', () => active.value)
    const { target, add, remove } = browser()
    const detach = attachBrowserCloseProtection(protection, target)
    expect(add).not.toHaveBeenCalled()
    expect(attemptExit(target).defaultPrevented).toBe(false)
    active.value = true
    expect(add).toHaveBeenCalledTimes(1)
    expect(attemptExit(target).defaultPrevented).toBe(true)
    active.value = false
    expect(remove).toHaveBeenLastCalledWith('beforeunload', add.mock.calls[0][1])
    expect(attemptExit(target).defaultPrevented).toBe(false)
    active.value = true
    unregister()
    expect(attemptExit(target).defaultPrevented).toBe(false)
    detach()
  })

  it('keeps other activity protected when one same-kind lease is released twice', () => {
    const protection = new CloseProtection()
    const { target, add } = browser()
    const detach = attachBrowserCloseProtection(protection, target)
    const first = protection.acquire('monitoring')
    const second = protection.acquire('monitoring')
    const transfer = protection.acquire('transfer')
    first()
    first()
    expect(protection.reasons.value).toEqual(['monitoring', 'transfer'])
    second()
    expect(attemptExit(target).defaultPrevented).toBe(true)
    expect(add).toHaveBeenCalledTimes(1)
    transfer()
    expect(attemptExit(target).defaultPrevented).toBe(false)
    detach()
  })

  it('does not release work when exit is attempted repeatedly', () => {
    const protection = new CloseProtection()
    const release = protection.acquire('unsaved-editor')
    const { target } = browser()
    const detach = attachBrowserCloseProtection(protection, target)
    expect(attemptExit(target).defaultPrevented).toBe(true)
    expect(attemptExit(target).defaultPrevented).toBe(true)
    expect(protection.reasons.value).toEqual(['unsaved-editor'])
    detach()
    expect(attemptExit(target).defaultPrevented).toBe(false)
    release()
  })

  it('stops observing on detach and can attach again with pre-existing activity', () => {
    const protection = new CloseProtection()
    const { target, add } = browser()
    const detach = attachBrowserCloseProtection(protection, target)
    detach()
    const release = protection.acquire('connection')
    expect(add).not.toHaveBeenCalled()
    const nextDetach = attachBrowserCloseProtection(protection, target)
    expect(attemptExit(target).defaultPrevented).toBe(true)
    nextDetach()
    nextDetach()
    expect(attemptExit(target).defaultPrevented).toBe(false)
    release()
  })
})
