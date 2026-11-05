<!--
  @velo/ui -- VCard Component (Phase F2.1; padding variants 2026-06-06; migrated FE-117 batch A)

  The single white card canon: opaque white + 1px --velo-border-card +
  --radius-md. Slot container for ALL of the app's white cards/sections
  (DS-governance).

  Usage:
    <VCard>Content</VCard>                     padding md (--space-4, default)
    <VCard padding="sm">Compact</VCard>        padding --space-3
    <VCard padding="none">Edge-to-edge</VCard> padding 0 (own padding on the class)
    <VCard clickable @click="open(id)">…</VCard>
  Extra layout (flex/gap/cursor and the like) is set by a class on the
  <VCard> itself — Vue merges the class onto the .v-card root.
-->

<template>
  <div
    class="v-card"
    :class="{
      'v-card--clickable': clickable,
      'v-card--pad-sm': padding === 'sm',
      'v-card--no-padding': padding === false || padding === 'none',
    }"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    :data-velo-clickable="clickable || undefined"
    @click="clickable ? $emit('click', $event) : undefined"
    @keydown.enter.space.prevent="clickable ? $emit('click', $event) : undefined"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    clickable?: boolean
    /** md (--space-4, default) | sm (--space-3) | none/false (0, own padding) | true=md */
    padding?: boolean | 'sm' | 'md' | 'none'
  }>(),
  {
    clickable: false,
    padding: true,
  },
)

defineEmits<{
  click: [event: MouseEvent | KeyboardEvent]
}>()
</script>

<style scoped>
.v-card {
  /* White surface standard (Figma 2026-06): opaque white fill + 1px white
     border + radius-md. Replaces the old glass fill (--velo-bg-card) + blue
     border (--velo-border), which no longer match the design. */
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

.v-card--clickable {
  cursor: pointer;
  transition:
    transform var(--transition-fast),
    opacity var(--transition-fast);
  -webkit-tap-highlight-color: transparent;
}

/* Press: the card sinks a little under the finger, releases softly. */
.v-card--clickable:active {
  transform: scale(0.985);
  opacity: 0.92;
  transition-duration: var(--velo-dur-press);
}

.v-card--pad-sm {
  padding: var(--space-3);
}

.v-card--no-padding {
  padding: 0;
}
</style>
