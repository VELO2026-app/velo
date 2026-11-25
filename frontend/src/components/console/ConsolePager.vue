<!--
  VELO Frontend -- ConsolePager (FE-262)

  The page row under a console table: a summary on the left ("Showing 1-20
  of 64"), page buttons on the right. The buttons are hidden when there is a
  single page; the summary stays. The screen owns the page number.
-->

<template>
  <nav class="console-pager" :aria-label="t('console.pager.nav')">
    <span class="console-pager__summary" data-testid="console-pager-summary">{{
      summaryText
    }}</span>
    <div v-if="pageCount > 1" class="console-pager__pages">
      <template v-for="(item, index) in items" :key="index">
        <span v-if="item === null" class="console-pager__gap" aria-hidden="true">...</span>
        <button
          v-else
          type="button"
          class="console-pager__page"
          :class="{ 'console-pager__page--current': item === page }"
          :aria-label="t('console.pager.page', { n: item })"
          :aria-current="item === page ? 'page' : undefined"
          @click="emit('update:page', item)"
        >
          {{ item }}
        </button>
      </template>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { pagerItems } from '@/utils/console/pagerItems'

const props = defineProps<{
  /** Current page, 1-based. */
  page: number
  /** Number of pages. */
  pageCount: number
  /** The summary text on the left; none -- «Showing from-to of total» from
   *  the counts below. */
  summary?: string | undefined
  /** Rows per page (for the default summary). */
  pageSize?: number | undefined
  /** Rows in the whole list (for the default summary). */
  total?: number | undefined
  /** Rows on the current page (for the default summary). */
  shown?: number | undefined
}>()

const emit = defineEmits<{
  'update:page': [page: number]
}>()

const items = computed(() => pagerItems(props.page, props.pageCount))

// "Showing 21-40 of 70": the rows of this page by their place in the list
// (an empty list reads 0-0).
const summaryText = computed(() => {
  if (props.summary !== undefined) return props.summary
  const shown = props.shown ?? 0
  const size = props.pageSize ?? 0
  const from = shown === 0 ? 0 : (props.page - 1) * size + 1
  const to = shown === 0 ? 0 : from + shown - 1
  return t('console.pager.shown', { from, to, total: props.total ?? 0 })
})
</script>

<style scoped>
.console-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4) var(--space-2);
}

.console-pager__summary {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.console-pager__pages {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.console-pager__page {
  min-width: var(--velo-size-36);
  height: var(--velo-size-36);
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  font-family: inherit;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  cursor: pointer;
}

.console-pager__page:hover {
  background: var(--velo-bg-subtle);
}

.console-pager__page:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.console-pager__page--current {
  background: var(--velo-primary);
  color: var(--velo-on-accent);
}

.console-pager__page--current:hover {
  background: var(--velo-primary);
}

.console-pager__gap {
  padding: 0 var(--space-1);
  color: var(--velo-text-secondary);
}
</style>
