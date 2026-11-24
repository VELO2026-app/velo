<!--
  VELO Frontend -- FinancePager (FE-267)

  The page row under a finance table: a summary on the left ("Shown 1-20 of
  64"), page buttons on the right. The buttons are hidden when there is a
  single page; the summary stays. The screen owns the page number.
-->

<template>
  <nav class="finance-pager" :aria-label="t('console.finance.pager.nav')">
    <span class="finance-pager__summary" data-testid="finance-pager-summary">{{ summary }}</span>
    <div v-if="pageCount > 1" class="finance-pager__pages">
      <template v-for="(item, index) in items" :key="index">
        <span v-if="item === null" class="finance-pager__gap" aria-hidden="true">...</span>
        <button
          v-else
          type="button"
          class="finance-pager__page"
          :class="{ 'finance-pager__page--current': item === page }"
          :aria-label="t('console.finance.pager.page', { n: item })"
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
import { pageItems } from '@/components/console/finance/pageItems'

const props = defineProps<{
  /** Current page, 1-based. */
  page: number
  /** Number of pages. */
  pageCount: number
  /** The summary text on the left. */
  summary: string
}>()

const emit = defineEmits<{
  'update:page': [page: number]
}>()

const items = computed(() => pageItems(props.page, props.pageCount))
</script>

<style scoped>
.finance-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4) var(--space-2);
}

.finance-pager__summary {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.finance-pager__pages {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.finance-pager__page {
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

.finance-pager__page:hover {
  background: var(--velo-bg-subtle);
}

.finance-pager__page:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.finance-pager__page--current {
  background: var(--velo-primary);
  color: var(--velo-on-accent);
}

.finance-pager__page--current:hover {
  background: var(--velo-primary);
}

.finance-pager__gap {
  padding: 0 var(--space-1);
  color: var(--velo-text-secondary);
}
</style>
