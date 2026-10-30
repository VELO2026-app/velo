// Host history access lives in the platform seam: views must not touch
// window.history directly (eslint no-restricted-globals). vue-router writes
// { back, forward, ... } into history.state on every navigation; reading it
// raw yields `any`, so the shape is declared here once.
export function historyHasBack(): boolean {
  const state = window.history.state as { back?: unknown } | null
  return state?.back != null
}

/** vue-router's index of the current entry in the history stack (null before
 * the router wrote its state). Stable for an entry across back/forward, so it
 * keys per-entry UI memory such as scroll positions. */
export function historyPosition(): number | null {
  const state = window.history.state as { position?: unknown } | null
  return typeof state?.position === 'number' ? state.position : null
}
