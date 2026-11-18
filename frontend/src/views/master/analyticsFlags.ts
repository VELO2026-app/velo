// =============================================================================
// VELO Frontend -- the Analytics screen's feature flag, in ONE place (FE-201)
// =============================================================================
//
// Owner 2026-10-01: payments are not live yet -- the Reviews/Payments slider is
// parked and AnalyticsView renders the Reviews tab only. Flip to true to
// restore the slider, the Payments pane and its data loads. AnalyticsView.test.ts
// reads the SAME constant, so the describes that exercise the parked UI wake up
// with the screen instead of staying skipped on a stale copy.
//
// Annotation is deliberate: a literal-false const would let TS narrow every
// `if (PAYMENTS_TAB_ENABLED)` into provably-dead code.
// =============================================================================

export const PAYMENTS_TAB_ENABLED: boolean = false
