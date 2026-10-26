<!--
  VELO Frontend -- IconMoodScaleGood (mood-scale "Хорошо")

  Approved mood-scale face (FE-85, tz-mood-scale.md §6): kept 1:1 from the approved source art: geometry, colors and gradients
  exactly as delivered. This component is the in-repo source of truth (raw
  svg sources are not kept). Full-color illustrative asset, not
  a currentColor glyph. Gradient id is unique per instance.

  F2.0 step-0 (tz-whitelabel §3.1): the gradient stops carry the fill colors
  as tokens with the source hex as fallback -- same pixels, but a skin can
  now retheme them. The remaining mood-scale icons follow in step 1(в)
  AFTER this probe is visually accepted.
-->
<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 356 356"
    fill="none"
  >
    <rect width="355.699" height="355.699" rx="177.85" :fill="`url(#${gid})`" />
    <path
      d="M128.055 206.305C158.39 225.806 197.316 225.806 227.651 206.305"
      style="stroke: var(--velo-primary-dark, #4c6589)"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <path
      d="M42.6741 163.622C54.7736 180.907 80.3725 180.907 92.472 163.622"
      style="stroke: var(--velo-primary-dark, #4c6589)"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <path
      d="M256.104 163.622C268.204 180.907 293.803 180.907 305.902 163.622"
      style="stroke: var(--velo-primary-dark, #4c6589)"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <defs>
      <linearGradient
        :id="gid"
        x1="0"
        y1="177.85"
        x2="355.699"
        y2="177.85"
        gradientUnits="userSpaceOnUse"
      >
        <!-- F2.0 step-0 probe (tz-whitelabel §3.1): the pale fills route
             through the tokens; the hex fallback keeps the render byte-for-byte
             identical even where var() cannot resolve. var() in a presentation
             ATTRIBUTE does not resolve -- it lives in style, which does. -->
        <stop style="stop-color: var(--velo-mood-fill-rose, #f9cbd1)" />
        <stop offset="1" style="stop-color: var(--velo-mood-fill-peach, #fddfc4)" />
      </linearGradient>
    </defs>
  </svg>
</template>

<script setup lang="ts">
import { useId } from 'vue'

withDefaults(defineProps<{ size?: number | string }>(), { size: 40 })

// Unique gradient id per component instance (avoids duplicate-id clashes
// when several mood-scale faces render on the same screen).
const gid = `mood-scale-good-${useId()}`
</script>
