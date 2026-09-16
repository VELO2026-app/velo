/**
 * VELO Frontend -- useToast Composable (Phase F2.1)
 *
 * Global toast notification system. Renders via VToast component
 * mounted once in App.vue.
 *
 * Usage:
 *   import { useToast } from '@/composables/useToast'
 *   const toast = useToast()
 *   toast.success('Сохранено!')
 *   toast.error('Ошибка сети')
 *   toast.info('Обновлено')
 */

import { ref, readonly } from 'vue'

export type ToastVariant = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

// Module-level singleton state (shared across all useToast() calls)
let _nextId = 0
const _toasts = ref<Toast[]>([])

const TOAST_DURATION_MS = 3000
/** F-06: max simultaneous toasts -- oldest is dropped when exceeded. */
const MAX_TOASTS = 3

function _push(message: string, variant: ToastVariant) {
  // F-06: drop oldest toast if at capacity to prevent stack overflow.
  if (_toasts.value.length >= MAX_TOASTS) {
    _toasts.value.shift()
  }
  const id = ++_nextId
  _toasts.value.push({ id, message, variant })
  setTimeout(() => {
    _toasts.value = _toasts.value.filter((t) => t.id !== id)
  }, TOAST_DURATION_MS)
}

export function useToast() {
  /** Show a success toast */
  const success = (message: string): void => {
    _push(message, 'success')
  }

  /** Show an error toast */
  const error = (message: string): void => {
    _push(message, 'error')
  }

  /** Show an info toast */
  const info = (message: string): void => {
    _push(message, 'info')
  }

  /** Dismiss a toast by id */
  const dismiss = (id: number): void => {
    _toasts.value = _toasts.value.filter((t) => t.id !== id)
  }

  return {
    /** Reactive list of active toasts (for VToast component) */
    toasts: readonly(_toasts),
    success,
    error,
    info,
    dismiss,
  }
}
