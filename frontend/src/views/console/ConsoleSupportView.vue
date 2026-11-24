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
import { useRoute, useRouter } from 'vue-router'
import { VSegment } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import SupportStatsPanel from '@/components/console/requests/SupportStatsPanel.vue'
import TicketsPanel from '@/components/console/requests/TicketsPanel.vue'

type SupportTab = 'open' | 'mine' | 'closed' | 'stats'

const route = useRoute()
const router = useRouter()

const tab = computed<SupportTab>(() => {
  const asked = route.query.tab
  return asked === 'mine' || asked === 'closed' || asked === 'stats' ? asked : 'open'
})
const isStats = computed(() => tab.value === 'stats')
// A tab change drops the open ticket: it belongs to the tab it was opened in.
const tabModel = computed<string>({
  get: () => tab.value,
  set: (next) => void router.replace({ query: { tab: next } }),
})

const tabOptions = computed(() => [
  { value: 'open', label: t('console.support.tabs.open') },
  { value: 'mine', label: t('console.support.tabs.mine') },
  { value: 'closed', label: t('console.support.tabs.closed') },
  { value: 'stats', label: t('console.support.tabs.stats') },
])
</script>
