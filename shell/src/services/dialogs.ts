import { store, type InteractionDialogState } from '../stores/app'

export interface CheckboxConfirmResult {
  confirmed: boolean
  checked: boolean
}

type DialogResult = boolean | string | null | undefined | CheckboxConfirmResult
let activeResolver: ((result: DialogResult) => void) | undefined

function open<T extends DialogResult>(state: InteractionDialogState, fallback: T): Promise<T> {
  if (store.interactionDialog || activeResolver) return Promise.resolve(fallback)
  return new Promise<T>((resolve) => {
    activeResolver = resolve as (result: DialogResult) => void
    store.interactionDialog = state
  })
}

export function confirmDialog(
  title: string,
  message: string,
  options: Partial<Pick<InteractionDialogState, 'confirmLabel' | 'cancelLabel' | 'danger'>> = {},
): Promise<boolean> {
  return open({
    kind: 'confirm',
    title,
    message,
    confirmLabel: options.confirmLabel ?? '确认',
    cancelLabel: options.cancelLabel ?? '取消',
    danger: options.danger ?? false,
    value: '',
    placeholder: '',
  }, false)
}

export function confirmCheckboxDialog(
  title: string,
  message: string,
  options: Partial<Pick<InteractionDialogState, 'confirmLabel' | 'cancelLabel' | 'danger' | 'checkboxLabel'>> = {},
): Promise<CheckboxConfirmResult> {
  return open({
    kind: 'confirm',
    title,
    message,
    confirmLabel: options.confirmLabel ?? '确认',
    cancelLabel: options.cancelLabel ?? '取消',
    danger: options.danger ?? false,
    checkboxLabel: options.checkboxLabel,
    value: '',
    placeholder: '',
  }, { confirmed: false, checked: false })
}

export function promptDialog(
  title: string,
  value = '',
  options: Partial<Pick<InteractionDialogState, 'message' | 'confirmLabel' | 'cancelLabel' | 'placeholder'>> = {},
): Promise<string | null> {
  return open({
    kind: 'prompt',
    title,
    message: options.message ?? '',
    confirmLabel: options.confirmLabel ?? '确认',
    cancelLabel: options.cancelLabel ?? '取消',
    danger: false,
    value,
    placeholder: options.placeholder ?? '',
  }, null)
}

export function alertDialog(title: string, message: string, confirmLabel = '确定'): Promise<void> {
  return open({
    kind: 'alert',
    title,
    message,
    confirmLabel,
    cancelLabel: '',
    danger: false,
    value: '',
    placeholder: '',
  }, undefined)
}

export function settleInteractionDialog(result: DialogResult): void {
  const resolve = activeResolver
  activeResolver = undefined
  store.interactionDialog = null
  resolve?.(result)
}
