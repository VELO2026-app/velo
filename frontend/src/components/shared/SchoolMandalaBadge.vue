<!--
  VELO Frontend -- SchoolMandalaBadge (tz-curator.md §5.3 / §7.2)

  Квадратный логотип-мандала школы, детерминированно собранный из хэша
  (utils/schoolBranding). Лёгкий -- для строки списка (§1.4), hero страницы
  (§1.6) и карточки практики. SVG генератора отдаётся через data-URL <img>:
  без v-html/innerHTML (правило фронта), фильтры внутри SVG в <img> работают.
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
    /** Хэш школы: branding_hash с бэка (§5.2 B) или schoolHashFromName (A). */
    hash: string
    size?: number
    monogram?: boolean
    letter?: string
    /** Плоский рендер: без drop-shadow (owner 2026-09-19). */
    flat?: boolean
    /** Масштаб мандалы внутри плашки (0.8 -- прототип; больше -- крупнее). */
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
