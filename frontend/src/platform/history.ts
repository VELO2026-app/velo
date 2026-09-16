// Host history access lives in the platform seam: views must not touch
// window.history directly (eslint no-restricted-globals). vue-router writes
// { back, forward, ... } into history.state on every navigation; reading it
// raw yields `any`, so the shape is declared here once.
export function historyHasBack(): boolean {
  const state = window.history.state as { back?: unknown } | null
  return state?.back != null
}
