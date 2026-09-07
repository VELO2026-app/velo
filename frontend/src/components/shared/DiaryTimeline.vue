<!--
  VELO Frontend -- DiaryTimeline (Diary redesign, screen 40 "map")

  The unified feed rendered as a vertical "thread": a central axis with cards
  strung along it as compact beads (DiaryThreadCard), split into day groups by
  date-nodes. Aligned to the Figma map screens (2026-05-29):
    - cards are CENTERED on the axis (no left/right alternation);
    - date-nodes are a centered label flanked by ornament flourishes;
    - the thread is carried by DISCRETE decor connectors -- no continuous
      background line (operator decision 2026-06-08).

  ORDER (chat-mode): oldest at the TOP, newest at the BOTTOM. The feed arrives
  newest-first; we render a chronological copy so the newest entry sits at the
  bottom, next to the composer (see DiaryFeedView for the scroll handling).

  Cards themselves are delegated to DiaryThreadCard; this component only owns
  the axis/date-node layout and the day grouping. The flat-column view uses
  DiaryList + DiaryFeedCard instead (toggled in DiaryFeedView).
-->

<template>
  <div class="timeline">
    <template v-for="(group, gi) in dayGroups" :key="group.dayKey">
      <!-- Day separator: big decor link above the date node (Декор 2 / big).
           The FIRST group carries none: a connector hanging from nothing read
           as a dead gap above the thread's very first entry (owner request). -->
      <div v-if="gi > 0" class="timeline__link">
        <IconDecor2 part="big" :size="30" />
      </div>

      <!-- Date node: a decor flourish on each side of the label (Декор). -->
      <div class="timeline__date-node">
        <IconDecor part="left" :size="39" />
        <span class="timeline__date-label">{{ group.label }}</span>
        <IconDecor part="right" :size="39" />
      </div>

      <!-- Big decor link from the date node down to the day's first card. -->
      <div class="timeline__link">
        <IconDecor2 part="big" :size="30" />
      </div>

      <!-- Cards of this day, centered, joined by the small decor link (Декор 2
           / small) — shown between cards, not before the first one. -->
      <template v-for="(item, i) in group.items" :key="item.id">
        <div v-if="i > 0" class="timeline__link">
          <IconDecor2 part="small" :size="18" />
        </div>
        <div class="timeline__row">
          <DiaryThreadCard :item="item" :timezone="timezone" @tap="(p) => emit('tap', p)" />
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DiaryThreadCard from '@/components/shared/DiaryThreadCard.vue'
import { IconDecor, IconDecor2 } from '@/components/icons'
import { dayKeyOf, dayLabelOf } from '@/utils/format'
import type { DiaryFeedItem } from '@/api/types'

const props = defineProps<{
  items: DiaryFeedItem[]
  timezone?: string
}>()

const emit = defineEmits<{
  tap: [payload: { item: DiaryFeedItem; editable: boolean }]
}>()

const tz = computed(() => props.timezone ?? 'UTC')

// -- group into days ---------------------------------------------------------

interface DayGroup {
  dayKey: string
  label: string
  items: DiaryFeedItem[]
}

const dayGroups = computed<DayGroup[]>(() => {
  const groups: DayGroup[] = []
  let current: DayGroup | null = null

  // Chat-mode: the feed arrives newest-first; render a chronological copy so
  // the newest entry is at the bottom. reverse() runs on a shallow copy;
  // props.items is not mutated.
  const chronological = [...props.items].reverse()

  for (const item of chronological) {
    const key = dayKeyOf(item.occurred_at, tz.value)
    if (!current || current.dayKey !== key) {
      current = { dayKey: key, label: dayLabelOf(item.occurred_at, tz.value), items: [] }
      groups.push(current)
    }
    current.items.push(item)
  }

  return groups
})
</script>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  width: 100%;
  /* No top padding: the body's own top padding (the shared headerless token)
     is already the clearance under the floating header, and anything extra
     above the first date node read as a big gap before the thread's first
     entry (owner request). */
  padding: 0 0 var(--space-3);
}

/* Date node: decor flourish + label + decor flourish. No axis line — the
   decor links carry the thread (operator decision 2026-06-08). */
.timeline__date-node {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--velo-text-primary);
}

.timeline__date-label {
  /* Strong date node (thread-events reference): big bold label, one line. */
  font-family: var(--font-body);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  color: var(--velo-text-primary);
  white-space: nowrap;
}

/* Decor links on the thread: big = day separator (above & below the date),
   small = between cards within a day. Tight breathing room around them. */
.timeline__link {
  display: flex;
  justify-content: center;
  color: var(--velo-text-primary);
  padding: 1px 0;
}

/* -- Card rows (all centered) -- */
.timeline__row {
  display: flex;
  justify-content: center;
  width: 100%;
}
</style>
