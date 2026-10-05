<!--
  VELO Frontend -- VRatingBadges (DS, extracted 2026-06-17; five zones since BE-77)

  The rating-distribution badge row: one chip per zone of the shared 1..10
  scale (Огонь .. Плохо, best first), each the zone's approved face + its
  percentage. Used by AnalyticsView (past-practice cards), MasterPracticesView
  (past cards) and MasterPracticeDetailView (PAST hero).

  Five chips instead of the former three: the face carries the zone (full-
  colour artwork, no accent colour), so every chip shares one neutral plate
  and the row stays narrow enough for a list card.

  size:
    'sm' (default) -- list / analytics cards (icon 14).
    'lg'           -- practice-detail hero (icon 16).

  Usage:
    <VRatingBadges :pcts="{ bad: 5, low: 10, neutral: 15, good: 30, fire: 40 }" />
    <VRatingBadges :pcts="pcts" size="lg" />
-->

<template>
  <div class="v-rating-badges" :class="`v-rating-badges--${size}`">
    <span
      v-for="key in ZONES_BEST_FIRST"
      :key="key"
      class="v-rating-badges__badge"
      :class="`v-rating-badges__badge--${key}`"
      :aria-label="`${MOOD_SCALE_LABELS[key]}: ${pcts[key]}%`"
    >
      <component :is="MOOD_SCALE_ICON[key]" :size="iconSize" />{{ pcts[key] }}%
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'

const props = withDefaults(
  defineProps<{
    /** Percent of the feedbacks per zone (server ScoreZoneCounts turned into %). */
    pcts: Record<MoodScaleKey, number>
    /** 'sm' (list/analytics cards, icon 14) or 'lg' (practice-detail hero, icon 16). */
    size?: 'sm' | 'lg'
  }>(),
  { size: 'sm' },
)

// Best zone first, as the three-chip version read (Огонь leftmost).
const ZONES_BEST_FIRST: readonly MoodScaleKey[] = [...MOOD_SCALE_KEYS].reverse()

const iconSize = computed((): number => (props.size === 'lg' ? 16 : 14))
</script>

<style scoped>
.v-rating-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.v-rating-badges__badge {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-card-gap-icon-title);
  border-radius: var(--velo-radius-badge);
  font-size: var(--text-xs);
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-primary);
}

.v-rating-badges--sm .v-rating-badges__badge {
  padding: 4px 6px;
}

.v-rating-badges--lg .v-rating-badges__badge {
  padding: 3px 8px;
}
</style>
