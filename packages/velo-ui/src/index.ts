// =============================================================================
// @velo/ui -- package barrel (FE-116, tz-ui-package.md §3.5)
// =============================================================================
// Assembled from the per-component folder index.ts files (plus the flat
// icon family barrel, FE-119 P4). The application imports ONLY this barrel
// (the P8 eslint boundary bans deep imports); the P1 stub export is
// replaced component-by-component as batches A/B land.
// =============================================================================

export { default as VAccordion } from './components/VAccordion'
export { default as VAvatar } from './components/VAvatar'
export { default as VBackButton } from './components/VBackButton'
export { default as VBadge } from './components/VBadge'
export { default as VBarChart } from './components/VBarChart'
export { default as VBottomSheet } from './components/VBottomSheet'
export { default as VButton } from './components/VButton'
export { default as VCard } from './components/VCard'
export { default as VCheckbox } from './components/VCheckbox'
export { default as VChip } from './components/VChip'
export { default as VConfirmDialog } from './components/VConfirmDialog'
export { default as VDayPicker } from './components/VDayPicker'
export { default as VEmptyState } from './components/VEmptyState'
export { default as VFieldError } from './components/VFieldError'
export { default as VInput } from './components/VInput'
export { default as VListRow } from './components/VListRow'
export { default as VLoadingSwap } from './components/VLoadingSwap'
export { default as VLoader } from './components/VLoader'
export { default as VMenuRow } from './components/VMenuRow'
export { default as VMenu } from './components/VMenu'
export { VMenuItem } from './components/VMenu'
export { default as VMetricHero } from './components/VMetricHero'
export { default as VMoreLink } from './components/VMoreLink'
export { default as VModal } from './components/VModal'
export { default as VPaginationDots } from './components/VPaginationDots'
export { default as VProgressRow } from './components/VProgressRow'
export { default as VRadioGroup } from './components/VRadioGroup'
export { default as VRatingBar } from './components/VRatingBar'
export { default as VSegment } from './components/VSegment'
export { default as VSegmentTrack } from './components/VSegmentTrack'
export { default as VSelect } from './components/VSelect'
export { default as VSkeleton } from './components/VSkeleton'
export { default as VSkeletonBubbles } from './components/VSkeletonBubbles'
export { default as VSkeletonPracticeCard } from './components/VSkeletonPracticeCard'
export { default as VSkeletonRow } from './components/VSkeletonRow'
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
// (the FE-145 overlays VModal/VBottomSheet import it straight from here
// now that they are kit residents; its document writes go through the
// kit's own document seam, src/platform/dom.ts, which stays
// package-internal), and the keyboard field-scroll INVERSION -- the
// injection key the host provides at its root (the app:
// provideKeyboardFieldScroll() in App.vue) plus the consumer door with a
// no-op default. Kit fields (VInput/VTextarea, P6) and host views resolve
// the same key.
export { lockBodyScroll, unlockBodyScroll, SCROLL_LOCK_CLASS } from './useBodyScrollLock'
export { KEYBOARD_FIELD_SCROLL_INJECTION_KEY, useKeyboardFieldScroll } from './keyboardFieldScroll'
// The loading system's delayed-flag rule (P8 batch 5): the no-flash hold the
// swap component and host screens share -- nothing shows before LOADING_DELAY_MS,
// and once shown it stays at least LOADING_MIN_DURATION_MS.
export {
  useDelayedFlag,
  useLoadingHold,
  LOADING_DELAY_MS,
  LOADING_MIN_DURATION_MS,
} from './useLoadingHold'
export type { DelayedFlagOptions, LoadingHold } from './useLoadingHold'
export type { KeyboardFieldScrollApi, KeyboardFieldScrollFactory } from './keyboardFieldScroll'

// The i18n seam (FE-118, tz-ui-package.md §4 P3): the host injects its
// translator through configureUi({ t }); the dictionary stays app-side and
// UI_I18N_KEYS is the registry the app's key-audit gate resolves against
// every locale.
export { configureUi, UI_I18N_KEYS } from './i18n'
export type { UiMessageKey, UiTranslator } from './i18n'

// Types re-exported for barrel consumers (verbatimModuleSyntax-aware); the
// VSegment option contract travels with its component (FE-140 batch B).
export type { SegmentOption } from './components/VSegment'
