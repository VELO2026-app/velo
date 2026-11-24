<!--
  VELO Frontend -- PeopleListCard (FE-262)

  The card of a console people table and the three states it has: nothing to
  show yet and a request in flight (a loader), nothing to show and the last
  request failed (an error with Retry), or the table itself (the default
  slot). The states follow screenQueryState: a refetch over data keeps the
  table on screen. The screens pass `loading` and `failed` from it.
-->

<template>
  <ConsoleCard flush>
    <div v-if="loading" class="people-list__state" data-testid="people-loading">
      <VLoader size="lg" />
    </div>
    <VEmptyState
      v-else-if="failed"
      icon="warning"
      :title="errorTitle"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="emit('retry')">{{
          t('common.retry')
        }}</VButton></template
      >
    </VEmptyState>
    <slot v-else />
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'

defineProps<{
  /** Nothing to show yet and a request is in flight. */
  loading: boolean
  /** Nothing to show and the last request failed. */
  failed: boolean
  /** The error state's title (what failed to load). */
  errorTitle: string
}>()

const emit = defineEmits<{
  /** Retry was pressed in the error state. */
  retry: []
}>()
</script>

<style scoped>
.people-list__state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}
</style>
