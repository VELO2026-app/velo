// =============================================================================
// @velo/ui -- package barrel (FE-116, tz-ui-package.md §3.5)
// =============================================================================
// Assembled from the per-component folder index.ts files. The application
// imports ONLY this barrel (the P8 eslint boundary bans deep imports); the
// P1 stub export is replaced component-by-component as batches A/B land.
// =============================================================================

export { default as VAccordion } from './components/VAccordion'
export { default as VAvatar } from './components/VAvatar'
export { default as VBadge } from './components/VBadge'
export { default as VBarChart } from './components/VBarChart'
export { default as VButton } from './components/VButton'
export { default as VCard } from './components/VCard'
export { default as VChip } from './components/VChip'
export { default as VDayPicker } from './components/VDayPicker'
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

// The i18n seam (FE-118, tz-ui-package.md §4 P3): the host injects its
// translator through configureUi({ t }); the dictionary stays app-side and
// UI_I18N_KEYS is the registry the app's key-audit gate resolves against
// every locale.
export { configureUi, UI_I18N_KEYS } from './i18n'
export type { UiMessageKey, UiTranslator } from './i18n'

// Types re-exported for barrel consumers (verbatimModuleSyntax-aware); the
// VSegment option contract travels with its component (FE-140 batch B).
export type { SegmentOption } from './components/VSegment'
