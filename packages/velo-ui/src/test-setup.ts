// =============================================================================
// @velo/ui -- Vitest global setup (FE-116, tz-ui-package.md §3.2)
// =============================================================================
//
// Mirrors the discipline of the frontend's src/test-setup.ts. Two laws:
//
// 1. SKIN-BLIND (frontend commit b91e259f): the frontend suite pins the
//    golden brand stub so it never depends on which skin the working tree
//    happens to carry. This package needs no alias -- it owns NO theme
//    values at all (principle 2: no tokens leave the host) -- and the same blindness
//    holds by construction: the token contract test (styles/token-contract)
//    reads the GOLDEN variables.css through a pinned relative path, never a
//    materialized skin.
// 2. happy-dom limits (tz-whitelabel §3): tokens ride var(), which happy-dom
//    does not meaningfully resolve -- tests assert DOM shape and events,
//    never computed styles.
//
// Package-wide test plumbing lands together with the seams that need it:
// P3 injects the i18n translator here (configureUi({ t })); P5 wires the
// toast provider. The package has owned ONE piece of module state since
// FE-143 -- the body-scroll lock's reference count (src/useBodyScrollLock).
// No reset hook for it: that suite pairs every lock/unlock so the count
// returns to zero on its own (order-independent), the same discipline the
// file carried in the application.
// =============================================================================

export {}
