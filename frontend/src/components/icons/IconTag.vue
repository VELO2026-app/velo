<template>
  <!-- Tag / label glyph (T24-10): no owner-supplied source, drawn by logic
       from three neighbours (IconCheck/IconPlus/IconPen) to match this set's
       stroke-based family -- viewBox 0 0 24 24, stroke-width 2, round
       cap/join, currentColor. A classic price-tag silhouette (pointed corner
       + a punched hole) rather than the huge-viewBox traced-path family
       (IconTrash/IconEdit) -- those are a separate, older style this new
       icon does not follow. -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path
      d="M11 3H19C19.5523 3 20 3.4477 20 4V12C20 12.2652 19.8946 12.5196 19.7071 12.7071L12.7071 19.7071C12.3166 20.0976 11.6834 20.0976 11.2929 19.7071L3.29289 11.7071C2.90237 11.3166 2.90237 10.6834 3.29289 10.2929L10.2929 3.29289C10.4804 3.10536 10.7348 3 11 3Z"
    />
    <circle cx="16" cy="7" r="1.4" fill="currentColor" stroke="none" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
