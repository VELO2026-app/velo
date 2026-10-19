<!--
  VELO Frontend -- VShowMore (shared, WS-3b T3)

  «+ ещё N <noun>» reveal pill — the shared replacement for the three hand-rolled
  pills (AnalyticsView .analytics__more-pill, MasterPracticeDetailView .pd-more-pill,
  AttendanceRosterView .roster__more-btn).

  Canonical look (WS-3b): transparent, 1.5px primary border, radius-full,
  text-base, primary text, padding --space-2 --space-5 (8/24), NO hover fill.
  Self-centres with a --space-1 top margin — drop it straight into a flex-column
  section (no wrapper needed); the roster's old centring wrapper is removed.

  tz-i18n contract (label-only): the component renders NO locale text of its
  own -- the caller passes the fully localized label. Count callers use the
  CLDR pipe form with the plural overload, t('...more', hiddenCount) (see
  masterScreens.*.more* keys, same recipe as shared.analytics.pairsMore); the
  old count+noun props pinned ONE genitive-plural noun form, which read wrong
  for 2-4 («+ ещё 2 практик») and left Russian fragments in every caller.
  aria-expanded and other attrs fall through to the root button.

  Usage:
    <VShowMore :label="t('masterScreens.analytics.morePractices', hiddenPastCount)" @click="expand" />
    <VShowMore :label="t('common.showMore')" @click="expand" />
-->

<template>
  <button type="button" class="v-show-more" @click="$emit('click')">
    {{ label }}
  </button>
</template>

<script setup lang="ts">
defineProps<{
  /** Fully localized label (caller-owned: pluralized t() or any verbatim string). */
  label: string
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
