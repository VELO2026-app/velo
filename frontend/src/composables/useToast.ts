/**
 * VELO Frontend -- useToast Composable (Phase F2.1; FE-141 provide/inject seam)
 *
 * Global toast notification system. Renders via VToast component
 * mounted once in App.vue.
 *
 * FE-141: the state sits behind a provide/inject seam so VToast can move to
 * `@velo/ui` (P6c) without the package importing this app module -- the host
 * provides the API once (provideToast() in App.vue), consumers read it via
 * useToast(). Missing-provider handling follows the FE-118 i18n seam
 * (packages/velo-ui/src/i18n.ts): dev builds warn once and fall back to the
 * old module singleton, so components mounted outside App.vue (standalone
 * test mounts) keep working instead of breaking.
 *
 * Usage:
 *   `import { useToast } from '@/composables/useToast'`
 *   const toast = useToast()
 *   toast.success('Saved!')
 *   toast.error('Network error')
 *   toast.info('Updated')
 */

import { getCurrentInstance, inject, provide, readonly, ref, type InjectionKey } from 'vue'

/** Visual kind of a toast: success, error or info. */
export type ToastVariant = 'success' | 'error' | 'info'

/** One toast in the global queue: id, message, variant. */
export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

const TOAST_DURATION_MS = 3000
/** F-06: max simultaneous toasts -- oldest is dropped when exceeded. */
const MAX_TOASTS = 3

/**
 * One isolated toast store. All state lives per instance (no module refs),
 * so a provided instance and the singleton fallback never share a list.
 */
function createToastApi() {
  const toasts = ref<Toast[]>([])
  let nextId = 0

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

/** FE-141: the injection key -- provideToast() provides, useToast() injects. */
export const TOAST_INJECTION_KEY: InjectionKey<ToastApi> = Symbol('useToast')

/**
 * The module singleton -- the pre-FE-141 state shared by every useToast()
 * call. Now only the no-provider fallback: the live app reads the instance
 * provided in App.vue; this keeps standalone (test) mounts on the old
 * behavior.
 */
const fallbackToastApi = createToastApi()

/**
 * Host wiring -- App.vue calls this once in its setup. Creates a fresh toast
 * state and provides it to the whole tree; VToast and every useToast() call
 * below inject that one instance. Returns the instance for hosts that also
 * push toasts themselves.
 */
export function provideToast(): ToastApi {
  const api = createToastApi()
  provide(TOAST_INJECTION_KEY, api)
  return api
}

let warnedNoProvider = false

/**
 * Read the toast API from the enclosing provider. Without a provider (or
 * outside any component), dev builds warn once -- loud, not fatal, the
 * FE-118 seam pattern -- and the module singleton keeps the old behavior.
 */
export function useToast(): ToastApi {
  // inject() only resolves inside a component setup; a non-component caller
  // (composable invoked from a plain test scope) would trip Vue's own
  // out-of-setup warning for nothing -- route it straight to the fallback.
  const api = getCurrentInstance() ? inject(TOAST_INJECTION_KEY, null) : null
  if (api) return api
  if (import.meta.env.DEV && !warnedNoProvider) {
    warnedNoProvider = true
    console.warn(
      '[useToast] no toast provider above this call -- using the module ' +
        'singleton fallback. Call provideToast() once in App.vue (FE-141).',
    )
  }
  return fallbackToastApi
}
