// =============================================================================
// VELO Frontend -- lazy @tma.js seam (viewport)
// =============================================================================
//
// The ONLY door to `@tma.js/sdk-vue` (an ESLint rule bans the import
// everywhere else). The SDK is loaded with a dynamic import() and only inside
// Telegram, so a standalone session never downloads or parses it (~80 KB raw
// with its fp-ts / valibot / bridge dependencies).
//
// Consumers get two shapes, both safe BEFORE the SDK has loaded:
//   - `tmaViewportState`: reactive refs for template/computed use;
//   - `getTmaViewport()`: the live viewport object for synchronous reads,
//     or null while the SDK is not loaded (always null outside Telegram).
// =============================================================================

import { ref, type Ref } from 'vue'

type TmaSdk = typeof import('@tma.js/sdk-vue')

/** The live SDK viewport object (signals are callable: `viewport.height()`). */
export type TmaViewport = TmaSdk['viewport']

let _sdk: TmaSdk | null = null
let _loading: Promise<TmaSdk> | null = null

/**
 * Reactive mirror of the viewport signals the layout consumes. Idle defaults
 * (not mounted, zero insets) are exactly what the SDK reports before mount,
 * so a consumer cannot tell "not loaded yet" from "not mounted yet".
 */
export const tmaViewportState: {
  isMounted: Ref<boolean>
  safeAreaInsetTop: Ref<number | undefined>
  contentSafeAreaInsetTop: Ref<number | undefined>
} = {
  isMounted: ref(false),
  safeAreaInsetTop: ref<number | undefined>(0),
  contentSafeAreaInsetTop: ref<number | undefined>(0),
}

/** Synchronous viewport access; null until the SDK has been loaded. */
export function getTmaViewport(): TmaViewport | null {
  return _sdk?.viewport ?? null
}

/** Copy a signal's current value into a ref and keep it in sync. */
function mirror<T>(signal: { (): T; sub: (fn: (v: T) => void) => unknown }, to: Ref<T>): void {
  to.value = signal()
  signal.sub((v) => {
    to.value = v
  })
}

/**
 * Load the SDK once (memoized) and start mirroring its viewport signals into
 * `tmaViewportState`. Rejects when the chunk cannot be fetched.
 */
export function loadTmaSdk(): Promise<TmaSdk> {
  _loading ??= import('@tma.js/sdk-vue').then((sdk) => {
    _sdk = sdk
    const vp = sdk.viewport
    mirror(vp.isMounted, tmaViewportState.isMounted)
    mirror(vp.safeAreaInsetTop, tmaViewportState.safeAreaInsetTop)
    mirror(vp.contentSafeAreaInsetTop, tmaViewportState.contentSafeAreaInsetTop)
    return sdk
  })
  // A failed chunk fetch must not stay cached: the next call retries.
  _loading.catch(() => {
    _loading = null
  })
  return _loading
}
