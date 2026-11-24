<!--
  VELO Frontend -- AttentionQueues (FE-268)

  The dashboard's "needs attention" row: one tile per queue, each a number
  and a way into the module that works the queue. A queue whose count is not
  known (still loading, or its request failed) reads a dash, never a zero:
  a zero would say "nothing waits".
-->

<template>
  <ul class="attention" :aria-label="t('console.dashboard.attention.queuesLabel')">
    <li v-for="queue in queues" :key="queue.key" class="attention__item">
      <RouterLink class="attention__tile" :to="queue.to" :data-testid="`attention-${queue.key}`">
        <span class="attention__head">
          <component :is="queue.icon" class="attention__icon" :size="20" aria-hidden="true" />
          <span class="attention__label">{{ queue.label }}</span>
        </span>
        <span class="attention__foot">
          <span
            class="attention__count"
            :class="{ 'attention__count--idle': queue.count === 0 }"
            data-testid="attention-count"
          >
            <template v-if="queue.count === null">
              <span aria-hidden="true">—</span>
              <span class="velo-sr-only">{{ t('console.dashboard.attention.unknown') }}</span>
            </template>
            <template v-else>{{ formatCount(queue.count) }}{{ queue.more ? '+' : '' }}</template>
          </span>
          <IconArrowRight class="attention__arrow" :size="20" aria-hidden="true" />
        </span>
      </RouterLink>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { IconArrowRight } from '@/components/icons'
import type { AttentionQueue } from '@/components/console/overview/types'
import { formatCount } from '@/utils/format'

defineProps<{
  queues: AttentionQueue[]
}>()
</script>

<style scoped>
.attention {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.attention__item {
  display: flex;
  min-width: 0;
}

.attention__tile {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-subtle);
  color: var(--velo-text-primary);
  text-decoration: none;
}

.attention__tile:hover {
  border-color: var(--velo-border-light);
}

.attention__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--velo-fs-14);
}

.attention__icon {
  flex: 0 0 auto;
}

.attention__label {
  overflow-wrap: anywhere;
}

.attention__foot {
  display: flex;
  margin-top: auto;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.attention__count {
  font-size: var(--velo-fs-28);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

/* An empty queue is quiet: nothing waits for the admin there. */
.attention__count--idle {
  color: var(--velo-text-secondary);
  -webkit-text-stroke: 0;
}

.attention__arrow {
  flex: 0 0 auto;
  color: var(--velo-text-secondary);
}
</style>
