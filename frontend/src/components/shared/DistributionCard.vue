<!--
  VELO Frontend -- DistributionCard (shared, extracted 2026-10-02)

  The analytics distribution block, generalized from PracticeMoodDistribution
  (tz-practice-analytics.md, the 30-Sep reference): the title and the count
  label share ONE heading line, below it the stacked colored strip with every
  non-zero category's percentage INSIDE its segment, an expandable
  «Расшифровка» with one labeled bar per category (zero-count categories keep
  their place there), and an honest empty state when nothing was answered.

  API = COUNTS-IN: the caller passes bars with raw counts and each bar's fill
  color (a CSS color or var()). The card owns the percentage maths, the
  «<1% / >99%» edge rounding (formatPercent, tz mandatory rule) and the
  strip/details/empty markup. Zero-count bars take no strip space but stay in
  the details; the segment's min-width yields to its label, never the other
  way around.

  Usage:
    <DistributionCard
      title="Процент фидбеков"
      count-label="14% · 1 из 7"
      empty-text="Пока нет отзывов"
      :bars="[{ key: 'fire', label: 'Огонь!', count: 1, fill: 'var(--velo-peach-300)' }]"
    />
-->
<template>
  <VCard class="distribution" role="region" :aria-labelledby="titleId">
    <div class="distribution__heading">
      <h2 :id="titleId">{{ title }}</h2>
      <span class="distribution__count">
        <IconGroup :size="18" aria-hidden="true" /> {{ countLabel }}
      </span>
    </div>

    <p v-if="total === 0" class="distribution__empty">{{ emptyText }}</p>
    <template v-else>
      <div class="distribution__stack" role="list" :aria-label="title">
        <div
          v-for="bar in visibleBars"
          :key="bar.key"
          class="distribution__segment"
          role="listitem"
          :style="{ flex: `${bar.count} 1 0`, background: bar.fill }"
          :aria-label="`${bar.label}: ${bar.count}, ${formatPercent(bar.percent)}`"
        >
          <span aria-hidden="true">{{ formatPercent(bar.percent) }}</span>
        </div>
      </div>

      <div v-show="expanded" :id="detailsId" class="distribution__details">
        <div v-for="bar in details" :key="bar.key">
          <div class="distribution__label">
            <component :is="bar.icon" v-if="bar.icon" :size="22" aria-hidden="true" />
            <span>{{ bar.label }}</span>
            <span class="distribution__value"
              >({{ bar.count }}) {{ formatPercent(bar.percent) }}</span
            >
          </div>
          <div class="distribution__track" aria-hidden="true">
            <div
              class="distribution__fill"
              :style="{ width: `${bar.percent}%`, background: bar.fill }"
            />
          </div>
        </div>
      </div>
      <VShowMore
        :label="expanded ? 'Скрыть' : 'Расшифровка'"
        :aria-expanded="expanded"
        :aria-controls="detailsId"
        @click="expanded = !expanded"
      />
    </template>
  </VCard>
</template>

<script setup lang="ts">
import { computed, ref, useId, type Component } from 'vue'
import { VCard } from '@/components/ui'
import { IconGroup } from '@/components/icons'
import VShowMore from '@/components/shared/VShowMore.vue'
import { formatPercent } from '@/utils/format'

export interface DistributionBar {
  /** Stable identity for the strip's list items and details rows. */
  key: string
  /** Category label, shown in the details («Огонь!», «Хорошо»...). */
  label: string
  /** Raw answer count; the card derives shares from these. */
  count: number
  /** Segment/fill color: a CSS color or var() reference. */
  fill: string
  /** Optional leading glyph in the details row (mood scale faces). */
  icon?: Component
}

const props = withDefaults(
  defineProps<{
    title: string
    /** Right side of the heading line, e.g. «14% · 1 из 7» or «4 из 9». */
    countLabel: string
    bars: ReadonlyArray<DistributionBar>
    emptyText: string
    initiallyExpanded?: boolean
  }>(),
  { initiallyExpanded: false },
)

const expanded = ref(props.initiallyExpanded)
const detailsId = useId()
const titleId = useId()
const total = computed(() => props.bars.reduce((sum, bar) => sum + bar.count, 0))

function withPercent(bar: DistributionBar): DistributionBar & { percent: number } {
  return { ...bar, percent: total.value ? (bar.count / total.value) * 100 : 0 }
}
// Zero-count bars take no strip space; the details keep every category, in
// descending scale order like the reference mockup.
const visibleBars = computed(() =>
  props.bars.filter((bar) => bar.count > 0).map((bar) => withPercent(bar)),
)
const details = computed(() => [...props.bars].reverse().map((bar) => withPercent(bar)))
</script>

<style scoped>
.distribution {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.distribution__heading,
.distribution__label,
.distribution__count {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.distribution__heading {
  justify-content: space-between;
  flex-wrap: wrap;
}
.distribution h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.distribution__count {
  white-space: nowrap;
  font-size: var(--text-xs);
}
.distribution__stack {
  display: flex;
  gap: 3px;
  height: 28px;
  font-size: var(--text-12);
}
.distribution__segment {
  /* Подпись важнее пропорций: узкий сегмент расширяется под текст. */
  min-width: max-content;
  padding-inline: var(--space-1);
  white-space: nowrap;
  display: grid;
  place-items: center;
  border-radius: var(--velo-radius-badge);
  font-size: var(--text-12);
}
.distribution__details {
  display: grid;
  gap: var(--space-3);
}
.distribution__label {
  margin-bottom: var(--space-1);
  font-size: var(--text-base);
  flex-wrap: wrap;
}
.distribution__label svg {
  flex-shrink: 0;
}
.distribution__value {
  margin-left: auto;
  color: var(--velo-text-secondary);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.distribution__track {
  height: 11px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
}
.distribution__fill {
  height: 100%;
  border-radius: inherit;
}
.distribution__empty {
  margin: 0;
  color: var(--velo-text-secondary);
}
.distribution :deep(.v-show-more) {
  min-height: 44px;
}
.distribution :deep(.v-show-more:focus-visible) {
  outline: 2px solid var(--velo-primary);
  outline-offset: 3px;
}
</style>
