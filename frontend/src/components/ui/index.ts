/**
 * VELO Frontend -- UI Components barrel export (Phase F2.1 + F4.1)
 *
 * FE-117 batch A + FE-140 (tail of A, batch B) + FE-118 P3 + FE-145 P6b (the
 * modal family): migrated kit components are re-exported from `@velo/ui`
 * (tz-ui-package.md §4 P2/P3/P6 -- the barrel flips component-by-component;
 * consumers never change an import). The app resolves `@velo/ui` to the
 * package SOURCES (vite/vitest alias + tsconfig paths) -- see the package
 * README "CSS strategy" for the resolution decision.
 *
 * Usage:
 *   `import { VButton, VInput, VCard, VModal } from '@/components/ui'`
 */

import { h, type FunctionalComponent } from 'vue'

import {
  VConfirmDialog as VConfirmDialogKit,
  VLoader as VLoaderKit,
  configureUi,
  VModal as VModalKit,
} from '@velo/ui'

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

// The label seams below read their key in BOTH spellings. A functional
// component without declared runtime props never camelizes what a compiled
// template hands it -- a `<VModal :close-label="...">` caller arrives as
// attrs['close-label'], while an h(VModal, { closeLabel }) render function
// arrives camelized (measured; the VLoader wrapper only ever saw kebab-case
// 'aria-label' and never tripped this).
function labelAttr(attrs: Record<string, unknown>, camel: string): string | undefined {
  return (attrs[camel] ?? attrs[camel.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())]) as
    string | undefined
}

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

// VModal (FE-145 P6b): the same seam, now through a prop instead of an
// attr -- the kit's × button reads the pure `closeLabel` prop (undefined =
// no aria-label), and the localized t('ui.close') default is re-anchored
// here until P3. The wrapper re-runs t() on every render, so the tz-i18n
// 1.3 locale-switch re-render contract survives the flip; the §7.2 attrs
// fallthrough the kit component now handles explicitly (inheritAttrs:false
// + v-bind on the teleported overlay) keeps working through it -- the
// wrapper spreads attrs untouched (pinned app-side by
// VModal.localized.test.ts).
const VModal: FunctionalComponent<{
  open: boolean
  closeOnOverlay?: boolean
  showClose?: boolean
  closeLabel?: string
}> = (props, { attrs, slots }) =>
  h(
    VModalKit,
    {
      ...attrs,
      ...props,
      closeLabel: labelAttr(attrs, 'closeLabel') ?? t('ui.close'),
    },
    slots,
  )

// VConfirmDialog (FE-145 P6b): the kit renders its button labels pure and
// this wrapper anchors the localized t('ui.cancel')/t('ui.confirm')
// defaults the component itself used to resolve at render time. An explicit
// consumer label always wins; the wrapper runs t() per render, so a locale
// switch re-renders the defaults (pinned app-side by
// VConfirmDialog.localized.test.ts).
const VConfirmDialog: FunctionalComponent<{
  open: boolean
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  loading?: boolean
  compactActions?: boolean
  warningPanel?: boolean
  warningPanelIcon?: boolean
  cancelVariant?: 'ghost' | 'primary' | 'danger'
  titleStrong?: boolean
}> = (props, { attrs, slots }) =>
  h(
    VConfirmDialogKit,
    {
      ...attrs,
      ...props,
      cancelLabel: labelAttr(attrs, 'cancelLabel') ?? t('ui.cancel'),
      confirmLabel: labelAttr(attrs, 'confirmLabel') ?? t('ui.confirm'),
    },
    slots,
  )

export { VButton } from '@velo/ui'
export { default as VBackButton } from './VBackButton.vue'
export { default as VMoreLink } from './VMoreLink.vue'
export { VInput } from '@velo/ui'
export { VFieldError } from '@velo/ui'
export { default as VTextarea } from './VTextarea.vue'
export { VSelect } from '@velo/ui'
export { VSwitch } from '@velo/ui'
export { VDayPicker } from '@velo/ui'
export { VCheckbox } from '@velo/ui'
export { VRadioGroup } from '@velo/ui'
export { VWheel } from '@velo/ui'
export { VBottomSheet } from '@velo/ui'
export { VCard } from '@velo/ui'
export { VBadge } from '@velo/ui'
export { VAvatar } from '@velo/ui'
export { VLoader }
export { VSkeleton } from '@velo/ui'
export { VSkeletonPracticeCard } from '@velo/ui'
export { VSkeletonRow } from '@velo/ui'
export { VSkeletonBubbles } from '@velo/ui'
export { default as VLoadingSwap } from './VLoadingSwap.vue'
export { VEmptyState } from '@velo/ui'
export { default as VToast } from './VToast.vue'
export { VStatCard } from '@velo/ui'
export { VProgressRow } from '@velo/ui'
export { VMetricHero } from '@velo/ui'
export { VBarChart } from '@velo/ui'
export { VRatingBar } from '@velo/ui'
export { default as VRatingBadges } from './VRatingBadges.vue'
export { VListRow } from '@velo/ui'
export { default as VeloLogo } from './VeloLogo.vue'
export { VModal }
export { VConfirmDialog }
export { VTag } from '@velo/ui'
export { VSegment } from '@velo/ui'
export { VSegmentTrack } from '@velo/ui'
export { VMenuRow } from '@velo/ui'
export { VChip } from '@velo/ui'
export { VPaginationDots } from '@velo/ui'
export { VAccordion } from '@velo/ui'
export { default as VMenu } from './VMenu.vue'
export { default as VMenuItem } from './VMenuItem.vue'

// FE-143: the kit's shared composable surface travels the same door as the
// components. The ref-counted body-scroll lock moved into @velo/ui with its
// tests; since FE-145 the overlays VModal/VBottomSheet are kit residents
// themselves and import it straight from the kit, so no app TS consumer is
// left -- the re-export stays as the door for any future host consumer, and
// because the class name SCROLL_LOCK_CLASS is a host-layout freeze
// (MobileLayout's CSS keys its own scroller lock on velo-scroll-locked).
// The keyboard field-scroll seam lives behind its own door instead: see
// composables/useKeyboardFieldScroll.ts (the app half of the seam).
export { lockBodyScroll, unlockBodyScroll, SCROLL_LOCK_CLASS } from '@velo/ui'

// Types re-exported for barrel consumers (verbatimModuleSyntax-aware).
export type { SegmentOption } from '@velo/ui'
