// =============================================================================
// @velo/ui -- the toast seam (FE-141; tz-ui-package.md §4 P5/P8 batch 6)
// =============================================================================
//
// VToast is the single rendering surface for the host's toast.error() /
// success() / info() calls, but the kit has no opinions about WHERE those
// calls come from: the STATE lives behind a provide/inject seam the host
// wires once (provideToast() in the host root, next to its other
// provideXxx() wiring). This module carries that seam: the api factory,
// the injection key, and the contract types. The host application keeps
// its `useToast()` push-side composable (its own door + fallback shape)
// and builds it on these exports -- the key is the same object, so a
// host-provided instance is exactly what the kit VToast injects.
//
// Without a provider the kit VToast renders NOTHING (an overlay surface
// with no queue is empty by definition); a dev build warns once so a host
// that forgot the wiring fails loudly instead of silently swallowing every
// toast -- the FE-118 i18n-seam discipline.
// =============================================================================

import { provide, readonly, ref, type InjectionKey } from 'vue'

/** Visual kind of a toast: success, error or info. */
export type ToastVariant = 'success' | 'error' | 'info'

/** One toast in the global queue: id, message, variant. */
export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

/** One isolated toast store. All state lives per instance (no module refs),
 * so a provided instance and any fallback never share a list. */
export function createToastApi() {
  const toasts = ref<Toast[]>([])
  let nextId = 0

  /** F-06: max simultaneous toasts -- oldest is dropped when exceeded. */
  const MAX_TOASTS = 3
  /** F-02: a toast self-dismisses after this long (ms). */
  const TOAST_DURATION_MS = 3000

  function push(message: string, variant: ToastVariant) {
    // F-06: drop oldest toast if at capacity to prevent stack overflow.
    if (toasts.value.length >= MAX_TOASTS) {
      toasts.value.shift()
    }
    const id = ++nextId
    toasts.value.push({ id, message, variant })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, TOAST_DURATION_MS)
  }

  return {
    /** Reactive list of active toasts (for VToast component) */
    toasts: readonly(toasts),
    /** Show a success toast */
    success: (message: string): void => {
      push(message, 'success')
    },
    /** Show an error toast */
    error: (message: string): void => {
      push(message, 'error')
    },
    /** Show an info toast */
    info: (message: string): void => {
      push(message, 'info')
    },
    /** Dismiss a toast by id */
    dismiss: (id: number): void => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    },
  }
}

/** The toast surface every useToast() caller receives. */
export type ToastApi = ReturnType<typeof createToastApi>

/** FE-141: the injection key -- provideToast() provides, VToast injects. */
export const TOAST_INJECTION_KEY: InjectionKey<ToastApi> = Symbol('useToast')

/**
 * Host wiring -- the host root calls this once in its setup. Creates a
 * fresh toast state and provides it to the whole tree; VToast and every
 * host-side useToast() call below inject that one instance. Returns the
 * instance for hosts that also push toasts themselves.
 */
export function provideToast(): ToastApi {
  const api = createToastApi()
  provide(TOAST_INJECTION_KEY, api)
  return api
}
