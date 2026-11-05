// =============================================================================
// @velo/ui -- icon family barrel (FE-119, tz-ui-package.md §4 P4)
// =============================================================================
// The 12 cross-cutting glyphs: UI chrome (arrow, check, close, dots,
// required markers, warning) + the VEmptyState ICON_MAP family (calendar,
// list, group, success, file). A flat family, not folder-per-component
// (§3.5): a glyph is one template-only SFC on the shared `size` contract
// (default 24, currentColor). The domain icons (IconBrain, IconBreathwork,
// IconMoodScale*, ...) stay in the application's components/icons -- the
// P4 audit line; the application's icons barrel re-exports this family
// until the P6/P8 component moves switch their consumers.
// =============================================================================

export { default as IconArrowRight } from './IconArrowRight.vue'
export { default as IconCalendar } from './IconCalendar.vue'
export { default as IconCheck } from './IconCheck.vue'
export { default as IconClose } from './IconClose.vue'
export { default as IconDots } from './IconDots.vue'
export { default as IconFile } from './IconFile.vue'
export { default as IconGroup } from './IconGroup.vue'
export { default as IconList } from './IconList.vue'
export { default as IconRequired } from './IconRequired.vue'
export { default as IconRequiredDone } from './IconRequiredDone.vue'
export { default as IconSuccess } from './IconSuccess.vue'
export { default as IconWarning } from './IconWarning.vue'
