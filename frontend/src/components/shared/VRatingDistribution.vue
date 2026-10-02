<!--
  VELO Frontend -- VRatingDistribution (shared, WS-3b T2; five zones since BE-77)

  Rating-distribution bars, one per zone of the shared 1..10 scale
  (Огонь .. Плохо, best first), on a VCard plate.

  API = COUNTS-IN: the caller passes the server's per-zone counts
  (ScoreZoneCounts, keyed like utils/moodScale.ts); the component owns the
  bar config (approved face + label from moodScale/ratingIcons, fill from
  MOOD_SCALE_FILLS), the percentage maths and the bar markup/CSS. Bars render
  even at 0% (empty distribution).

  Usage:
    <VRatingDistribution :counts="insights.feedbacks" />
-->

<template>
  <VCard class="v-rating-dist">
    <div v-for="bar in bars" :key="bar.key" class="v-rating-dist__row">
      <span class="v-rating-dist__head">
        <component :is="bar.icon" :size="22" />
        {{ bar.label }}
      </span>
      <div class="v-rating-dist__track">
        <div
          class="v-rating-dist__fill"
          :style="{ width: `${bar.pct}%`, background: bar.barColor }"
        />
      </div>
      <span class="v-rating-dist__meta">{{ bar.pct }}% ({{ bar.count }})</span>
    </div>
  </VCard>
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import { VCard } from '@/components/ui'
import { MOOD_SCALE_FILLS } from '@/utils/displayHelpers'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, zoneTotal, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'

const props = defineProps<{
  /** Per-zone feedback counts, exactly as the server sends them. */
  counts: Record<MoodScaleKey, number>
}>()

interface RatingBar {
  key: MoodScaleKey
  icon: Component
  label: string
  count: number
  pct: number
  barColor: string
}

// Best zone first, as the three-bar version read (Огонь on top).
const ZONES_BEST_FIRST: readonly MoodScaleKey[] = [...MOOD_SCALE_KEYS].reverse()

const bars = computed((): RatingBar[] => {
  const total = zoneTotal(props.counts)
  return ZONES_BEST_FIRST.map((key) => ({
    key,
    icon: MOOD_SCALE_ICON[key],
    label: MOOD_SCALE_LABELS[key],
    barColor: MOOD_SCALE_FILLS[key],
    count: props.counts[key],
    pct: total > 0 ? Math.round((props.counts[key] / total) * 100) : 0,
  }))
})
</script>

<style scoped>
.v-rating-dist {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.v-rating-dist__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.v-rating-dist__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.v-rating-dist__track {
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
  overflow: hidden;
}

.v-rating-dist__fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s ease;
}

.v-rating-dist__meta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}
</style>
