// =============================================================================
// VELO Frontend -- account scope: one reset for every store (FE-157 stage 3)
// =============================================================================
//
// Everything a store holds belongs to the account that loaded it. Before
// FE-157 the account boundary (logout, and a 401 that ends the session) reset
// stores from two hand-kept, different and incomplete lists in stores/auth.ts,
// so most stores carried the previous account's data into the next one; only
// the full page reload around every sign-in hid it.
//
// accountScopePlugin is a Pinia plugin: every store created in a Pinia that
// has it registers itself, and resetAccountScope() calls `$reset()` on all of
// them -- a new store joins without anyone editing a list. The contract for a
// store is to own a `$reset()` that returns it to its initial state (setup
// stores have no built-in one) and makes answers still in flight for the
// previous account land nowhere. stores/session-reset.test.ts holds every
// store in src/stores to that contract.
//
// This module imports no store, which is what lets stores/auth.ts call it
// without the dynamic imports that used to break auth -> store -> auth cycles.
// =============================================================================

import type { Pinia, PiniaPluginContext, StoreGeneric } from 'pinia'

/** The stores registered per Pinia instance (an app has one; tests make many). */
const scopes = new WeakMap<Pinia, Map<string, StoreGeneric>>()

/**
 * Whether the store has a working `$reset()`: an options store gets one from
 * Pinia, a setup store only when its setup returns one (Pinia's default for
 * setup stores throws in dev and does nothing in production).
 */
function ownsReset(options: PiniaPluginContext['options']): boolean {
  const definition = options as { state?: unknown; actions?: Record<string, unknown> }
  return typeof definition.state === 'function' || typeof definition.actions?.$reset === 'function'
}

/**
 * Pinia plugin that enrolls every store with a `$reset()` in the account
 * scope of its Pinia.
 *
 * @remarks
 * Install with `createPinia().use(accountScopePlugin)` BEFORE `app.use(pinia)`.
 * Pinia applies plugins only once the instance is installed in an app, so a
 * bare `setActivePinia(createPinia())` in a test enrolls nothing. A setup
 * store without its own `$reset()` is left out rather than called: Pinia's
 * placeholder would throw in dev in the middle of a logout.
 */
export function accountScopePlugin({ pinia, store, options }: PiniaPluginContext): void {
  if (!ownsReset(options)) return
  let scope = scopes.get(pinia)
  if (!scope) {
    scope = new Map()
    scopes.set(pinia, scope)
  }
  // Keyed by id: a store disposed and created again replaces its old entry.
  scope.set(store.$id, store)
}

/**
 * Return every enrolled store of `pinia` to its initial state, except the
 * store that owns the session itself.
 *
 * @remarks
 * Called by stores/auth.ts whenever the session ends (`_clearSession`: logout,
 * a 401 for the current token, a refused restore, a discarded session). The
 * session owner clears its own state there and is skipped here. One store's
 * reset that throws does not stop the rest -- a half-reset scope is the leak
 * this exists to prevent; the error is rethrown on a microtask so the global
 * error handlers still report it.
 *
 * @param keepId - The id of the session owner store (`auth`).
 */
export function resetAccountScope(pinia: Pinia, keepId: string): void {
  const scope = scopes.get(pinia)
  if (!scope) return
  for (const [id, store] of scope) {
    if (id === keepId) continue
    try {
      store.$reset()
    } catch (error) {
      queueMicrotask(() => {
        throw error
      })
    }
  }
}
