<!--
  VELO Frontend -- SchoolMandalaBadge (tz-curator.md §5.3 / §7.2)

  The school's square mandala logo, deterministically assembled from the
  hash (utils/schoolBranding). Lightweight -- for the list row (§1.4), the
  page hero (§1.6) and the practice card. The generator's SVG goes through
  a data-URL <img>: no v-html/innerHTML (frontend rule), and filters inside
  an SVG in <img> keep working.
-->

<template>
  <img
    v-if="src"
    class="school-mandala-badge"
    :src="src"
    :width="size"
    :height="size"
    alt=""
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { brandingParams, logoSvg } from '@/utils/schoolBranding'

const props = withDefaults(
  defineProps<{
    /** School hash: the branding_hash from the backend (§5.2 B) or schoolHashFromName (A). */
    hash: string
    size?: number
    monogram?: boolean
    letter?: string
    /** Flat render: no drop-shadow (owner 2026-09-19). */
    flat?: boolean
    /** Mandala scale inside the plate (0.8 -- the prototype; larger values scale it up). */
    mandalaScale?: number
  }>(),
  { size: 40, monogram: false, letter: '', flat: false, mandalaScale: 0.8 },
)

const src = computed((): string => {
  const svg = logoSvg(brandingParams(props.hash), {
    monogram: props.monogram,
    letter: props.letter,
    flat: props.flat,
    mandalaScale: props.mandalaScale,
  })
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
})
</script>

<style scoped>
.school-mandala-badge {
  display: block;
  flex-shrink: 0;
}
</style>
