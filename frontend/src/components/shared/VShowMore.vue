<!--
  VELO Frontend -- VShowMore (shared, WS-3b T3)

  «+ ещё N <noun>» reveal pill — the shared replacement for the three hand-rolled
  pills (AnalyticsView .analytics__more-pill, MasterPracticeDetailView .pd-more-pill,
  AttendanceRosterView .roster__more-btn).

  Canonical look (WS-3b): transparent, 1.5px primary border, radius-full,
  text-base, primary text, padding --space-2 --space-5 (8/24), NO hover fill.
  Self-centres with a --space-1 top margin — drop it straight into a flex-column
  section (no wrapper needed); the roster's old centring wrapper is removed.

  Usage:
    <VShowMore :count="hiddenCount" noun="практик" @click="expand" />
    <VShowMore label="посмотреть еще" @click="expand" />   (verbatim override)
-->

<template>
  <button type="button" class="v-show-more" @click="$emit('click')">
    <template v-if="label">{{ label }}</template>
    <template v-else>+ ещё {{ count }} {{ noun }}</template>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  /** Hidden-items count shown in the default label. Omit when `label` is set. */
  count?: number
  /** Trailing noun, already in the correct case ("практик" / "участников" / "отзывов"). Omit when `label` is set. */
  noun?: string
  /** Verbatim label override; when set, replaces the «+ ещё {count} {noun}» default. */
  label?: string
}>()

defineEmits<{ click: [] }>()
</script>

<style scoped>
.v-show-more {
  align-self: center;
  margin-top: var(--space-1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2) var(--space-5);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-primary);
  background: transparent;
  border: 1.5px solid var(--velo-primary);
  border-radius: var(--radius-full);
  cursor: pointer;
}
</style>
