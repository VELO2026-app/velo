<!--
  VELO Frontend -- VChip Component (Phase B4.3)

  Glass pill chip. Two roles:
    - static tag (default): non-interactive label (e.g. master methods).
    - selectable (clickable + active): filter chips inside modals.

  Sizes: sm (default, compact tag) | md (roomier, filter chips).

  Usage:
    <VChip>Медитация</VChip>
    <VChip size="md" clickable :active="on" @click="toggle">Заметки</VChip>

  Optional `existing` (T24-35, PROMPT №634): a second, DARKER selected state
  meaning "already a member of this" -- distinct from `active` ("selected
  right now, about to be added"). The owner's own example: a student
  already in four groups, and nothing on screen said so. Colour derived
  from the existing scale (--velo-primary-dark, the same token VButton's
  own primary hover already uses) -- not a new colour. Takes precedence
  over `active` when both are true (a chip already-in is not "newly
  selected", it is its own state). Default false = byte-identical to
  every pre-existing caller.
-->

<template>
  <component
    :is="clickable ? 'button' : 'span'"
    :type="clickable ? 'button' : undefined"
    class="v-chip"
    :class="{
      'v-chip--md': size === 'md',
      'v-chip--clickable': clickable,
      'v-chip--active': active && !existing,
      'v-chip--existing': existing,
    }"
    @click="clickable && $emit('click', $event)"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: 'sm' | 'md'
    active?: boolean
    clickable?: boolean
    /** "Already a member" darker state (T24-35) -- see the file header. */
    existing?: boolean
  }>(),
  {
    size: 'sm',
    active: false,
    clickable: false,
    existing: false,
  },
)

defineEmits<{
  click: [event: MouseEvent]
}>()
</script>

<style scoped>
.v-chip {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-3);
  background: var(--velo-glass-blue-15);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-primary);
  white-space: nowrap;
}

.v-chip--md {
  padding: var(--space-2) var(--space-4);
}

.v-chip--clickable {
  /* Selectable (filter) chips read as muted until active. */
  color: var(--velo-text-secondary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.v-chip--clickable:hover {
  opacity: 0.85;
}

.v-chip--active {
  background: var(--velo-primary);
  border-color: var(--velo-primary);
  color: var(--velo-white);
}

/* T24-35 (PROMPT №634): darker "already a member" state -- --velo-primary-dark,
   the existing hover-state token for --velo-primary (VButton), not a new
   colour. Deliberately not just a heavier active: this chip did not become
   selected because of THIS interaction, it already was true before the
   sheet opened. */
.v-chip--existing {
  background: var(--velo-primary-dark);
  border-color: var(--velo-primary-dark);
  color: var(--velo-white);
}
</style>
