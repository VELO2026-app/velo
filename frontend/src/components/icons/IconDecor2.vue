<!--
  VELO Frontend -- IconDecor2 (Diary axis link "Decor 2")

  Source: icon-spec Group 3358.svg. Two vertical beaded connectors used on the
  diary thread. `part` selects which to render:
    - big   -> taller 3-bead connector (separates DAYS: above & below a date)
    - small -> shorter 2-bead connector (between actions WITHIN a day)
    - both  -> the original pair
  `size` is the rendered HEIGHT; width derives from the part's aspect.
  Colour via currentColor.
-->
<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="width"
    :height="height"
    :viewBox="viewBox"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      v-if="part !== 'small'"
      d="M101.5 0C122.763 1.85887e-06 140 17.237 140 38.5C140 58.1244 125.317 74.3177 106.338 76.6973V177.402C114.518 180.097 120.423 187.8 120.423 196.883C120.423 205.965 114.518 213.667 106.338 216.362V324.563C123.669 327.597 136.842 342.721 136.842 360.921C136.842 381.307 120.316 397.833 99.9297 397.833C79.5437 397.833 63.0177 381.307 63.0176 360.921C63.0176 342.727 76.181 327.607 93.5039 324.566V216.365C85.3191 213.673 79.4092 205.969 79.4092 196.883C79.4092 187.797 85.319 180.092 93.5039 177.399V76.165C76.0788 72.484 63 57.0209 63 38.5C63 17.2371 80.2371 3.68293e-05 101.5 0Z"
    />
    <path
      v-if="part !== 'big'"
      d="M260.383 66.4473C248.996 66.4473 239.766 75.678 239.766 87.0645C239.766 97.1295 246.979 105.508 256.518 107.317V298.751C246.979 300.56 239.766 308.94 239.766 319.005C239.766 330.391 248.996 339.622 260.383 339.622C271.769 339.622 281 330.391 281 319.005C281 308.94 273.787 300.56 264.248 298.751V107.317C273.787 105.508 281 97.1295 281 87.0645C281 75.678 271.769 66.4473 260.383 66.4473Z"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type Decor2Part = 'both' | 'big' | 'small'

const props = withDefaults(defineProps<{ size?: number; part?: Decor2Part }>(), {
  size: 24,
  part: 'both',
})

const VIEWBOX: Record<Decor2Part, string> = {
  both: '39.13 -23.87 265.74 445.57',
  big: '55 -6 92 410',
  small: '233 60 55 286',
}
const ASPECT: Record<Decor2Part, number> = {
  both: 265.74 / 445.57,
  big: 92 / 410,
  small: 55 / 286,
}

const viewBox = computed(() => VIEWBOX[props.part])
const height = computed(() => props.size)
const width = computed(() => Math.max(1, Math.round(props.size * ASPECT[props.part])))
</script>
