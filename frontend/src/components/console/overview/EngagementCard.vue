<!--
  VELO Frontend -- EngagementCard (FE-268)

  The dashboard's engagement block: check-in, feedback and return, each a
  rate with its change against the period before and a bar. A row opens
  that metric in the analytics module for the same period.
-->

<template>
  <ConsoleCard :title="t('console.dashboard.engagement.title')" data-testid="engagement-card">
    <ConsoleLoading v-if="loading" data-testid="engagement-loading" />
    <OverviewEmpty
      v-else-if="error"
      icon="warning"
      :title="t('console.dashboard.figures.loadFailed')"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="emit('retry')">{{ t('common.retry') }}</VButton>
    </OverviewEmpty>
    <ul v-else class="engagement">
      <li v-for="row in rows" :key="row.key">
        <RouterLink class="engagement__row" :to="row.to" :data-testid="`engagement-${row.key}`">
          <span class="engagement__head">
            <span class="engagement__label">{{ row.label }}</span>
            <span class="engagement__rate" data-testid="engagement-rate">{{
              formatRate(row.rate)
            }}</span>
          </span>
          <span class="engagement__track" aria-hidden="true">
            <span class="engagement__fill" :style="{ width: `${fillOf(row.rate)}%` }" />
          </span>
          <DeltaLine :value="row.delta" unit="points" />
        </RouterLink>
      </li>
    </ul>
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleLoading from '@/components/console/content/ConsoleLoading.vue'
import DeltaLine from '@/components/console/overview/DeltaLine.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import { formatRate } from '@/components/console/overview/engagement'
import type { EngagementRow } from '@/components/console/overview/types'

defineProps<{
  /** The three rates. */
  rows: EngagementRow[]
  /** The window's overview is still on its way. */
  loading: boolean
  /** Why the overview could not be read; null -- it was. */
  error: string | null
}>()

const emit = defineEmits<{
  /** The Retry of the error state. */
  retry: []
}>()

function fillOf(rate: number | null): number {
  return rate === null ? 0 : Math.min(100, Math.max(0, Math.round(rate)))
}
</script>

<style scoped>
.engagement {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.engagement__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--velo-text-primary);
  text-decoration: none;
}

.engagement__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.engagement__label {
  font-size: var(--velo-fs-16);
}

.engagement__rate {
  font-size: var(--velo-fs-20);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.engagement__track {
  display: block;
  height: var(--space-2);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--velo-border-light);
}

.engagement__fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
}
</style>
