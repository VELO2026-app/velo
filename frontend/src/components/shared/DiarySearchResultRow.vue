<!--
  VELO Frontend -- DiarySearchResultRow (diary live search, 2026-09-09)

  One Telegram-style compact search result: kind glyph, title, preview with
  the match SEGMENTS emphasised (splitHighlight -- rendered as real DOM
  nodes, never v-html), and the day + time at the right rail. Title/preview/
  icon derivation comes from the shared useDiaryCardModel (single source of
  truth for DiaryFeedItem presentation), not a private copy of the mappings.

  Used only by DiarySearchResults (one component per row so the composable
  runs in each row's own setup, not in a v-for).
-->

<template>
  <button type="button" class="dsr-row" @click="emit('jump', item)">
    <span class="dsr-row__icon" aria-hidden="true">
      <component :is="glyph" :size="24" />
    </span>

    <span class="dsr-row__texts">
      <span class="dsr-row__title">
        <template v-for="(seg, i) in titleSegments" :key="i">
          <mark v-if="seg.hit" class="dsr-row__hit">{{ seg.text }}</mark>
          <template v-else>{{ seg.text }}</template>
        </template>
      </span>
      <span v-if="previewSegments.length > 0" class="dsr-row__preview">
        <template v-for="(seg, i) in previewSegments" :key="i">
          <mark v-if="seg.hit" class="dsr-row__hit">{{ seg.text }}</mark>
          <template v-else>{{ seg.text }}</template>
        </template>
      </span>
    </span>

    <span class="dsr-row__date">{{ dateLabel }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDiaryCardModel } from '@/composables/useDiaryCardModel'
import { splitHighlight } from '@/utils/textHighlight'
import { dayLabelOf, formatTime } from '@/utils/format'
import type { DiaryFeedItem } from '@/api/types'

const props = defineProps<{
  item: DiaryFeedItem
  timezone?: string
  /** The active search query -- drives the match emphasis. */
  query: string
}>()

const emit = defineEmits<{
  jump: [item: DiaryFeedItem]
}>()

const model = useDiaryCardModel(
  () => props.item,
  () => props.timezone,
)

// One glyph slot per row: the practice direction glyph for practice cards,
// the shared standard glyph for everything else.
const glyph = computed(() =>
  model.form.value === 'practice' ? model.directionIcon.value : model.standardIcon.value,
)

// The practice card's identity IS its title; for banners the matched text
// (text_search carries the practice title) must stay visible, so it becomes
// the preview line.
const rowTitle = computed(() =>
  model.form.value === 'practice' ? model.practiceTitle.value : model.title.value,
)
const rowPreview = computed(() => {
  if (model.preview.value) return model.preview.value
  if (model.form.value === 'banner') return model.practiceTitle.value
  if (model.form.value === 'practice') return model.masterName.value
  return null
})

const titleSegments = computed(() => splitHighlight(rowTitle.value, props.query))
const previewSegments = computed(() =>
  rowPreview.value ? splitHighlight(rowPreview.value, props.query) : [],
)

// Rows carry their own day (no timeline date-nodes in the results list), so
// the label is the day + the time, like Telegram's search rows.
const dateLabel = computed(
  () =>
    `${dayLabelOf(props.item.occurred_at, props.timezone ?? 'UTC')}, ${formatTime(
      props.item.occurred_at,
      props.timezone ?? 'UTC',
    )}`,
)
</script>

<style scoped>
.dsr-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 64px;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  font-family: var(--font-body);
  color: var(--velo-text-primary);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.dsr-row:hover {
  background: var(--velo-glass-blue-15);
}

.dsr-row__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-primary);
}

.dsr-row__texts {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dsr-row__title {
  font-size: var(--text-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsr-row__preview {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The match emphasis: Telegram bolds the needle; the mark element carries
   the semantics, the DS tokens carry the look (no UA yellow). */
mark.dsr-row__hit {
  background: var(--velo-glass-blue-15);
  color: inherit;
  font-weight: 700;
  border-radius: 4px;
  padding: 0 1px;
}

.dsr-row__date {
  flex-shrink: 0;
  align-self: flex-start;
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  white-space: nowrap;
}
</style>
