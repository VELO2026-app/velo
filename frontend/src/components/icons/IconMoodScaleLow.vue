<!--
  VELO Frontend -- IconMoodScaleLow (mood-scale "Не очень")

  Approved mood-scale face (FE-85, tz-mood-scale.md §6): kept 1:1 from the approved source art: geometry, colors and gradients
  exactly as delivered. This component is the in-repo source of truth (raw
  svg sources are not kept).
  F2.0 (tz-whitelabel §3.1, batch (в)): the pale paints carry tokens with the
  source hex as fallback -- same pixels, skin-themable. The hex fallback is
  load-bearing: the view tests tell the faces apart by the fallback hex in
  the rendered art. Full-color illustrative asset, not
  a currentColor glyph. Gradient id is unique per instance.
-->
<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 356 356"
    fill="none"
  >
    <rect width="355.037" height="355.037" rx="177.518" :fill="`url(#${gid})`" />
    <circle cx="67.452" cy="208.32" r="17.7518" style="fill: var(--velo-primary-dark, #4c6589)" />
    <circle cx="280.473" cy="208.32" r="17.7518" style="fill: var(--velo-primary-dark, #4c6589)" />
    <path
      d="M224.198 261.459C193.863 241.958 154.937 241.958 124.603 261.459"
      style="stroke: var(--velo-primary-dark, #4c6589)"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <defs>
      <linearGradient
        :id="gid"
        x1="0"
        y1="177.518"
        x2="355.037"
        y2="177.518"
        gradientUnits="userSpaceOnUse"
      >
        <stop style="stop-color: var(--velo-mood-fill-teal, #bdecf1)" />
        <stop offset="1" style="stop-color: var(--velo-mood-fill-rose, #f9cbd1)" />
      </linearGradient>
    </defs>
  </svg>
</template>

<script setup lang="ts">
import { useId } from 'vue'

withDefaults(defineProps<{ size?: number | string }>(), { size: 40 })

// Unique gradient id per component instance (avoids duplicate-id clashes
// when several mood-scale faces render on the same screen).
const gid = `mood-scale-low-${useId()}`
</script>
