<!--
  VELO Frontend -- DiarySearchResults (diary live search, 2026-09-09)

  The compact results list shown while a diary search is active: a count line
  ("Найдено: N" / "N+" while more pages remain -- the feed API returns no
  total, so N+ is the honest ceiling) and one DiarySearchResultRow per event,
  newest-first in the API's own order (rows are a jump list, not the
  timeline -- no day separators). The parent (DiaryFeedView) owns pagination
  (a sentinel element it places after this list) and the jump-on-tap.
-->

<template>
  <div class="dsr">
    <p class="dsr__count" aria-live="polite">Найдено: {{ items.length }}{{ hasMore ? '+' : '' }}</p>
    <DiarySearchResultRow
      v-for="item in items"
      :key="item.id"
      :item="item"
      :timezone="timezone"
      :query="query"
      @jump="(i) => emit('jump', i)"
    />
  </div>
</template>

<script setup lang="ts">
import DiarySearchResultRow from '@/components/shared/DiarySearchResultRow.vue'
import type { DiaryFeedItem } from '@/api/types'

defineProps<{
  items: DiaryFeedItem[]
  timezone?: string
  /** The active search query, passed through for the row emphasis. */
  query: string
  /** More result pages may exist behind the parent's sentinel. */
  hasMore: boolean
}>()

const emit = defineEmits<{
  jump: [item: DiaryFeedItem]
}>()
</script>

<style scoped>
.dsr {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.dsr__count {
  margin: 0 0 var(--space-1) var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}
</style>
