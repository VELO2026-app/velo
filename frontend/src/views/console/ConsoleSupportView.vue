<!--
  VELO Frontend -- ConsoleSupportView (FE-262, slice 2)

  The Support module of the web console. Tabs: open tickets, the ones this
  admin holds, closed ones, and the statistics. A tickets tab is the list, the
  conversation and the person's panel side by side (TicketsPanel); the
  statistics tab is the month's figures (SupportStatsPanel).

  The tab rides the URL (`?tab=open|mine|closed|stats`, open by default).
  The bot's deep link still opens the mobile ticket screen
  (/admin/support/:id) -- it is not routed here.
-->

<template>
  <ConsolePage
    :title="isStats ? t('adminScreens.adminSupportStats.title') : t('console.modules.support')"
    :crumbs="
      isStats
        ? `${t('console.groups.requests')} · ${t('console.modules.support')}`
        : t('console.groups.requests')
    "
    :fill="!isStats"
    testid="console-support"
  >
    <template #tabs>
      <VSegment v-model="tabModel" compact :options="tabOptions" />
    </template>

    <SupportStatsPanel v-if="tab === 'stats'" />
    <TicketsPanel v-else :scope="tab" />
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VSegment } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import SupportStatsPanel from '@/components/console/requests/SupportStatsPanel.vue'
import TicketsPanel from '@/components/console/requests/TicketsPanel.vue'
import { TICKET_FILTER_PARAMS } from '@/components/console/requests/ticketFilters'
import { useUrlTab } from '@/composables/console/useUrlTab'

// The filters stay when the tab changes: they apply to all three ticket tabs.
const { tab, tabModel } = useUrlTab(['open', 'mine', 'closed', 'stats'], TICKET_FILTER_PARAMS)
const isStats = computed(() => tab.value === 'stats')

const tabOptions = computed(() => [
  { value: 'open', label: t('console.support.tabs.open') },
  { value: 'mine', label: t('console.support.tabs.mine') },
  { value: 'closed', label: t('console.support.tabs.closed') },
  { value: 'stats', label: t('console.support.tabs.stats') },
])
</script>
