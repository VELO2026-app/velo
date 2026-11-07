/**
 * VELO Frontend -- UI Components barrel export (Phase F2.1 + F4.1)
 *
 * FE-117 batch A + FE-140 (tail of A, batch B) + FE-118 P3: migrated kit
 * components are re-exported from `@velo/ui` (tz-ui-package.md §4 P2/P3 --
 * the barrel flips component-by-component; consumers never change an
 * import). The app resolves `@velo/ui` to the package SOURCES (vite/vitest
 * alias + tsconfig paths) -- see the package README "CSS strategy" for
 * the resolution decision.
 *
 * Usage:
 *   `import { VButton, VInput, VCard, VModal } from '@/components/ui'`
 */

import { h, type FunctionalComponent } from 'vue'

import { VLoader as VLoaderKit, configureUi } from '@velo/ui'

import { t } from '@/locales'

// The kit's i18n seam (FE-118, tz-ui-package.md §4 P3), wired HERE as this
// module's init on purpose: this barrel is the app's one door to the kit,
// so every runtime AND every test that renders a kit component has the
// host translator in place before the first render -- no caller-side
// wiring to forget, and no test-setup import of this barrel either (a
// setup-time import would materialize the component chain before a test
// file's vi.mock registration could intercept it -- the EntryView.voice
// lesson of FE-118). The dictionary stays app-side: t is the same
// '@/locales' singleton composer the kit components used to import.

configureUi({ t })

// VLoader (FE-140, tail of batch A): the kit component cut the i18n seam --
// it is pure and the loading label arrives through attrs on the root (§7.2).
// The localized default is re-anchored here, at the app's one door to the
// kit: common.loading is app vocabulary outside the kit registry
// (UI_I18N_KEYS), so even after P3 the wrapper -- not the seam -- carries
// it; every consumer keeps the exact rendered aria-label it had before the
// flip (pinned by VLoader.localized.test.ts).
const VLoader: FunctionalComponent<{ size?: 'sm' | 'md' | 'lg' }> = (props, { attrs }) =>
  h(VLoaderKit, {
    ...attrs,
    ...props,
    'aria-label': (attrs['aria-label'] as string | undefined) ?? t('common.loading'),
  })

export { VButton } from '@velo/ui'
export { default as VBackButton } from './VBackButton.vue'
export { default as VMoreLink } from './VMoreLink.vue'
export { default as VInput } from './VInput.vue'
export { default as VFieldError } from './VFieldError.vue'
export { default as VTextarea } from './VTextarea.vue'
export { default as VSelect } from './VSelect.vue'
export { VSwitch } from '@velo/ui'
export { VDayPicker } from '@velo/ui'
export { default as VCheckbox } from './VCheckbox.vue'
export { default as VRadioGroup } from './VRadioGroup.vue'
export { VWheel } from '@velo/ui'
export { default as VBottomSheet } from './VBottomSheet.vue'
export { VCard } from '@velo/ui'
export { VBadge } from '@velo/ui'
export { VAvatar } from '@velo/ui'
export { VLoader }
export { default as VSkeleton } from './VSkeleton.vue'
export { default as VSkeletonPracticeCard } from './VSkeletonPracticeCard.vue'
export { default as VSkeletonRow } from './VSkeletonRow.vue'
export { default as VSkeletonBubbles } from './VSkeletonBubbles.vue'
export { default as VLoadingSwap } from './VLoadingSwap.vue'
export { default as VEmptyState } from './VEmptyState.vue'
export { default as VToast } from './VToast.vue'
export { VStatCard } from '@velo/ui'
export { default as VProgressRow } from './VProgressRow.vue'
export { VMetricHero } from '@velo/ui'
export { VBarChart } from '@velo/ui'
export { VRatingBar } from '@velo/ui'
export { default as VRatingBadges } from './VRatingBadges.vue'
export { VListRow } from '@velo/ui'
export { default as VeloLogo } from './VeloLogo.vue'
export { default as VModal } from './VModal.vue'
export { default as VConfirmDialog } from './VConfirmDialog.vue'
export { VTag } from '@velo/ui'
export { VSegment } from '@velo/ui'
export { VSegmentTrack } from '@velo/ui'
export { default as VMenuRow } from './VMenuRow.vue'
export { VChip } from '@velo/ui'
export { VPaginationDots } from '@velo/ui'
export { VAccordion } from '@velo/ui'
export { default as VMenu } from './VMenu.vue'
export { default as VMenuItem } from './VMenuItem.vue'

// FE-143: the kit's shared composable surface travels the same door as the
// components. The ref-counted body-scroll lock moved into @velo/ui with its
// tests (the P6 overlays VModal/VBottomSheet -- still app residents until
// P6 -- keep their lock through this barrel; the class name SCROLL_LOCK_CLASS
// stays exported because the host layout CSS freezes on it). The keyboard
// field-scroll seam lives behind its own door instead: see
// composables/useKeyboardFieldScroll.ts (the app half of the seam).
export { lockBodyScroll, unlockBodyScroll, SCROLL_LOCK_CLASS } from '@velo/ui'

// Types re-exported for barrel consumers (verbatimModuleSyntax-aware).
export type { SegmentOption } from '@velo/ui'
