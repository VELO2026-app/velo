<!--
  VELO Frontend -- SchoolBrandBanner (tz-curator.md §5.3 / §7.2)

  Детерминированный фирменный фон школы («роза-вихрь»). variant="hero" --
  полная сцена с фильтрами для страницы школы (§1.6); variant="row" --
  лёгкий декоративный crop правой трети карточки списка (§1.4): без тяжёлых
  фильтров, aria-hidden, pointer-events:none, мягкий fade в белый слева.
  Полный hero-SVG НЕ монтируется в каждой строке списка (§5.3).
  SVG идёт через data-URL <img> -- без v-html/innerHTML (правило фронта).
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
    /** Хэш школы: branding_hash с бэка (§5.2 B) или schoolHashFromName (A). */
    hash: string
    variant?: 'hero' | 'row'
    /** Плоский hero-рендер: без feDisplacementMap и grain (owner 2026-09-19). */
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

/* Row-crop: правая треть карточки списка (§1.4), мягкий fade в белый слева. */
.school-brand-banner--row {
  position: absolute;
  inset: 0 0 0 auto;
  width: 34%;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 42%);
  mask-image: linear-gradient(to right, transparent, #000 42%);
}
</style>
