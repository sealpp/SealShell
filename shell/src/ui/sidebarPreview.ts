import { onScopeDispose, ref, watch, type InjectionKey, type Ref } from 'vue'

export const sidebarMenuOpenKey: InjectionKey<(open: boolean) => void> = Symbol('sidebarMenuOpen')

export function useSidebarPreview(pinned: Ref<boolean>, blocked: Ref<boolean>) {
  const open = ref(false)
  let triggerHovered = false
  let panelHovered = false
  let menuOpen = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function closeLater() {
    clearTimer()
    if (!open.value || triggerHovered || panelHovered || menuOpen) return
    timer = setTimeout(() => {
      timer = undefined
      open.value = false
    }, 200)
  }

  function enterTrigger(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    triggerHovered = true
    clearTimer()
    if (pinned.value || blocked.value || open.value) return
    timer = setTimeout(() => {
      timer = undefined
      open.value = true
    }, 350)
  }

  function leaveTrigger() {
    triggerHovered = false
    closeLater()
  }

  function enterPanel() {
    panelHovered = true
    clearTimer()
  }

  function leavePanel() {
    panelHovered = false
    closeLater()
  }

  function setMenuOpen(value: boolean) {
    menuOpen = value
    if (value) clearTimer()
    else closeLater()
  }

  function dismiss() {
    clearTimer()
    open.value = false
    triggerHovered = false
    panelHovered = false
  }

  watch([pinned, blocked], ([isPinned, isBlocked], [wasPinned]) => {
    clearTimer()
    open.value = !isPinned && !isBlocked && wasPinned && panelHovered
  })
  onScopeDispose(clearTimer)

  return { open, enterTrigger, leaveTrigger, enterPanel, leavePanel, setMenuOpen, dismiss }
}
