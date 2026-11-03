<!--
  VELO Frontend -- SchoolBrandBanner (tz-curator.md §5.3 / §7.2)

  The school's deterministic branded background (the "rose-vortex" pattern).
  variant="hero" is the full scene with filters for the school page (§1.6);
  variant="row" is a light decorative crop of the right third of the list-row
  card (§1.4): no heavy filters, aria-hidden, pointer-events:none, a soft
  fade to white on the left. The full hero SVG is NOT mounted in every list
  row (§5.3). The SVG goes through a data-URL <img> -- no v-html/innerHTML
  (frontend rule).
-->

<template>
  <img
    v-if="src"
    class="school-brand-banner"
    :class="`school-brand-banner--${variant}`"
    :src="src"
    alt=""
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { bannerSvg, brandingParams } from '@/utils/schoolBranding'

const props = withDefaults(
  defineProps<{
    /** School hash: the branding_hash from the backend (§5.2 B) or schoolHashFromName (A). */
    hash: string
    variant?: 'hero' | 'row'
    /** Flat hero render: no feDisplacementMap and no grain (owner 2026-09-19). */
    flat?: boolean
  }>(),
  { variant: 'hero', flat: false },
)

const src = computed((): string => {
  const params = brandingParams(props.hash)
  const svg =
    props.variant === 'row'
      ? bannerSvg(params, 600, 300, { lightweight: true })
      : bannerSvg(params, 1200, 600, { flat: props.flat })
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
})
</script>

<style scoped>
.school-brand-banner {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

/* Row-crop: the right third of the list-row card (§1.4), a soft fade to white on the left. */
.school-brand-banner--row {
  position: absolute;
  inset: 0 0 0 auto;
  width: 34%;
  -webkit-mask-image: linear-gradient(to right, transparent, var(--velo-fog-color) 42%);
  mask-image: linear-gradient(to right, transparent, var(--velo-fog-color) 42%);
}
</style>
