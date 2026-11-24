<!--
  VELO Frontend -- PeoplePager (FE-262)

  The foot of a console table: "Shown 20 of 38" on the left, numbered pages
  on the right (the first, the last and the neighbours of the current one).
  With one page only the count shows. The page change goes out as
  `update:page`; the screen owns the page (the URL, useRouteListState).
-->

<template>
  <footer class="people-pager" data-testid="people-pager">
    <span class="people-pager__shown">{{ t('console.pager.shown', { shown, total }) }}</span>
    <nav v-if="items.length" class="people-pager__pages" :aria-label="t('console.pager.nav')">
      <template v-for="(item, i) in items" :key="`${item}-${i}`">
        <span v-if="item === 'gap'" class="people-pager__gap" aria-hidden="true">…</span>
        <button
          v-else
          type="button"
          class="people-pager__page"
          :class="{ 'people-pager__page--active': item === page }"
          :aria-current="item === page ? 'page' : undefined"
          :aria-label="t('console.pager.page', { n: item })"
          @click="item !== page && emit('update:page', item)"
        >
          {{ item }}
        </button>
      </template>
    </nav>
  </footer>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { pagerItems } from '@/components/console/people/peopleTable'

const props = defineProps<{
  /** The current 1-based page. */
  page: number
  /** Rows per page. */
  pageSize: number
  /** Rows in the whole list. */
  total: number
  /** Rows on the current page. */
  shown: number
}>()

const emit = defineEmits<{
  'update:page': [page: number]
}>()

const items = computed(() => pagerItems(props.page, Math.ceil(props.total / props.pageSize)))
</script>

<style scoped>
.people-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4) var(--space-2);
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.people-pager__pages {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.people-pager__page {
  min-width: 32px;
  height: 32px;
  padding: 0 var(--space-2);
  box-sizing: border-box;
  border: 0;
  border-radius: var(--velo-radius-pill);
  background: transparent;
  font: inherit;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  cursor: pointer;
}

.people-pager__page:hover {
  background: var(--velo-bg-subtle);
}

.people-pager__page:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 1px;
}

.people-pager__page--active,
.people-pager__page--active:hover {
  background: var(--velo-primary);
  color: var(--velo-on-accent);
  cursor: default;
}

.people-pager__gap {
  min-width: 24px;
  text-align: center;
  color: var(--velo-text-muted);
}
</style>
