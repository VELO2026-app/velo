/**
 * VELO Frontend -- UI Components barrel export (Phase F2.1 + F4.1)
 *
 * FE-117 batch A: migrated kit components are re-exported from @velo/ui
 * (tz-ui-package.md §4 P2 -- the barrel flips component-by-component;
 * consumers never change an import). The app resolves @velo/ui to the
 * package SOURCES (vite/vitest alias + tsconfig paths) -- see the package
 * README "Стратегия CSS" for the resolution decision.
 *
 * Usage:
 *   import { VButton, VInput, VCard, VModal } from '@/components/ui'
 */

export { VButton } from '@velo/ui'
export { default as VBackButton } from './VBackButton.vue'
export { default as VMoreLink } from './VMoreLink.vue'
export { default as VInput } from './VInput.vue'
export { default as VFieldError } from './VFieldError.vue'
export { default as VTextarea } from './VTextarea.vue'
export { default as VSelect } from './VSelect.vue'
export { default as VSwitch } from './VSwitch.vue'
export { default as VDayPicker } from './VDayPicker.vue'
export { default as VCheckbox } from './VCheckbox.vue'
export { default as VRadioGroup } from './VRadioGroup.vue'
export { default as VWheel } from './VWheel.vue'
export { default as VBottomSheet } from './VBottomSheet.vue'
export { VCard } from '@velo/ui'
export { VBadge } from '@velo/ui'
export { VAvatar } from '@velo/ui'
export { default as VLoader } from './VLoader.vue'
export { default as VSkeleton } from './VSkeleton.vue'
export { default as VSkeletonPracticeCard } from './VSkeletonPracticeCard.vue'
export { default as VSkeletonRow } from './VSkeletonRow.vue'
export { default as VSkeletonBubbles } from './VSkeletonBubbles.vue'
export { default as VLoadingSwap } from './VLoadingSwap.vue'
export { default as VEmptyState } from './VEmptyState.vue'
export { default as VToast } from './VToast.vue'
export { default as VStatCard } from './VStatCard.vue'
export { default as VProgressRow } from './VProgressRow.vue'
export { default as VMetricHero } from './VMetricHero.vue'
export { default as VBarChart } from './VBarChart.vue'
export { default as VRatingBar } from './VRatingBar.vue'
export { default as VRatingBadges } from './VRatingBadges.vue'
export { VListRow } from '@velo/ui'
export { default as VeloLogo } from './VeloLogo.vue'
export { default as VModal } from './VModal.vue'
export { default as VConfirmDialog } from './VConfirmDialog.vue'
export { VTag } from '@velo/ui'
export { default as VSegment } from './VSegment.vue'
export { default as VSegmentTrack } from './VSegmentTrack.vue'
export { default as VMenuRow } from './VMenuRow.vue'
export { VChip } from '@velo/ui'
export { default as VPaginationDots } from './VPaginationDots.vue'
export { default as VAccordion } from './VAccordion.vue'
export { default as VMenu } from './VMenu.vue'
export { default as VMenuItem } from './VMenuItem.vue'

// Types re-exported for barrel consumers (verbatimModuleSyntax-aware).
export type { SegmentOption } from './VSegment.vue'
