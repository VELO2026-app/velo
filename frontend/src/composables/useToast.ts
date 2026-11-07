/**
 * VELO Frontend -- useToast Composable (Phase F2.1; FE-141 provide/inject seam)
 *
 * Global toast notification system. The STATE lives in `@velo/ui`
 * (src/toast.ts -- the factory, the injection key and the contract types
 * moved there in P8 batch 6 together with the kit VToast renderer); this
 * module is the app's push-side door over that seam.
 *
 * Renders via VToast (kit) mounted once in App.vue. App.vue calls
 * provideToast() here once in its setup; every useToast() call below
 * injects that one instance. Missing-provider handling follows the FE-118
 * i18n seam (packages/velo-ui/src/i18n.ts): dev builds warn once and fall
 * back to the old module singleton, so components mounted outside App.vue
 * (standalone test mounts) keep working instead of breaking.
 *
 * Usage:
 *   `import { useToast } from '@/composables/useToast'`
 *   const toast = useToast()
 *   toast.success('Saved!')
 *   toast.error('Network error')
 *   toast.info('Updated')
 */

import { getCurrentInstance, inject } from 'vue'
import {
  createToastApi,
  provideToast as provideKitToast,
  TOAST_INJECTION_KEY,
  type Toast,
  type ToastApi,
  type ToastVariant,
} from '@/components/ui'

export type { Toast, ToastApi, ToastVariant }
export { TOAST_INJECTION_KEY }

/**
 * Host wiring -- App.vue calls this once in its setup. Creates a fresh toast
 * state and provides it under the kit's injection key (the key the kit
 * VToast injects); returns the instance for hosts that also push toasts
 * themselves.
 */
export function provideToast(): ToastApi {
  return provideKitToast()
}

let warnedNoProvider = false

/**
 * Read the toast API from the enclosing provider. Without a provider (or
 * outside any component), dev builds warn once -- loud, not fatal, the
 * FE-118 seam pattern -- and a module singleton keeps the old behavior
 * (standalone test mounts keep pushing into a live queue).
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
  return fallbackToastApi()
}

/** The pre-FE-141 shared state, now just the no-provider fallback. */
let fallbackInstance: ToastApi | null = null
function fallbackToastApi(): ToastApi {
  if (!fallbackInstance) fallbackInstance = createToastApi()
  return fallbackInstance
}
