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
// P3 (FE-118) landed the i18n seam, but NO global injection happens here --
// each component test file calls configureUi with its own dictionary at
// the top of the file, which vitest's per-file module isolation makes
// deterministic (a fresh seam per file, the pre-configure behaviour even
// stays testable, see src/i18n.test.ts). P5 will wire the toast provider.
// The setup itself stays stateless on purpose.
// =============================================================================

export {}
