// =============================================================================
// @velo/ui -- package barrel (FE-116, tz-ui-package.md §3.5)
// =============================================================================
// Assembled from the per-component folder index.ts files (plus the flat
// icon family barrel, FE-119 P4). The application imports ONLY this barrel
// (the P8 eslint boundary bans deep imports); the P1 stub export is
// replaced component-by-component as batches A/B land.
// =============================================================================

export { default as VAvatar } from './components/VAvatar'
export { default as VBadge } from './components/VBadge'
export { default as VButton } from './components/VButton'
export { default as VCard } from './components/VCard'
export { default as VChip } from './components/VChip'
export { default as VListRow } from './components/VListRow'
export { default as VLoader } from './components/VLoader'
export { default as VMetricHero } from './components/VMetricHero'
export { default as VPaginationDots } from './components/VPaginationDots'
export { default as VRatingBar } from './components/VRatingBar'
export { default as VSegment } from './components/VSegment'
export { default as VSegmentTrack } from './components/VSegmentTrack'
export { default as VStatCard } from './components/VStatCard'
export { default as VSwitch } from './components/VSwitch'
export { default as VTag } from './components/VTag'
export { default as VWheel } from './components/VWheel'

// Icons (FE-119, tz-ui-package.md §4 P4): the 12 cross-cutting glyphs (UI
// chrome + the VEmptyState ICON_MAP family), a flat family under src/icons/
// with its own barrel; the domain icons stay in the application. The star
// re-export keeps ONE explicit name list (the family barrel) -- the
// application's icons barrel re-exports it until the P6/P8 component moves
// switch their consumers.
export * from './icons'

// Seams & shared composables (FE-143, tz-ui-package.md §4 P5 -- the P6
// prerequisites): the ref-counted body-scroll lock moved from the app
// (VModal/VBottomSheet import it from here; its document writes go through
// the kit's own document seam, src/platform/dom.ts, which stays
// package-internal until a kit resident needs it), and the keyboard
// field-scroll INVERSION -- the injection key the host provides at its
// root (the app: provideKeyboardFieldScroll() in App.vue) plus the
// consumer door with a no-op default. Kit fields (VInput/VTextarea, P6)
// and host views resolve the same key.
export { lockBodyScroll, unlockBodyScroll, SCROLL_LOCK_CLASS } from './useBodyScrollLock'
export { KEYBOARD_FIELD_SCROLL_INJECTION_KEY, useKeyboardFieldScroll } from './keyboardFieldScroll'
export type { KeyboardFieldScrollApi, KeyboardFieldScrollFactory } from './keyboardFieldScroll'

// Types re-exported for barrel consumers (verbatimModuleSyntax-aware); the
// VSegment option contract travels with its component (FE-140 batch B).
export type { SegmentOption } from './components/VSegment'
