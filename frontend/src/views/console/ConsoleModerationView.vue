<!--
  VELO Frontend -- ConsoleModerationView (FE-262, slice 2)

  The Moderation module of the web console: three tabs over what needs a
  human decision. Complaints -- the pending ones, a list and the open
  complaint side by side, to resolve or dismiss with a text. Method changes
  -- the masters' requests to change their methods, to approve (adding a
  custom method to the catalog on the way) or reject with a reason. Decided
  -- the complaints already resolved or dismissed.

  The tab rides the URL (`?tab=complaints|methods|decided`, complaints by
  default), so a reload and the back button land where the admin was. The
  counters on the tabs are the admin stats the menu already reads.
-->

<template>
  <ConsolePage
    :title="t('console.modules.moderation')"
    :crumbs="t('console.groups.requests')"
    :fill="tab !== 'methods'"
    testid="console-moderation"
  >
    <template #tabs>
      <VSegment v-model="tabModel" compact :options="tabOptions" />
    </template>

    <ReportsPanel v-if="tab === 'complaints'" mode="pending" />
    <MethodRequestsPanel v-else-if="tab === 'methods'" />
    <ReportsPanel v-else mode="decided" />
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VSegment } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import MethodRequestsPanel from '@/components/console/requests/MethodRequestsPanel.vue'
import ReportsPanel from '@/components/console/requests/ReportsPanel.vue'
import { useUrlTab } from '@/composables/console/useUrlTab'
import { useAdminStats } from '@/composables/queries/admin'

const { pendingModeration, pendingMethodChanges } = useAdminStats()
const { tab, tabModel } = useUrlTab(['complaints', 'methods', 'decided'])

const tabOptions = computed(() => [
  {
    value: 'complaints',
    label: t('adminScreens.adminReports.tabComplaints'),
    badge: pendingModeration.value || undefined,
  },
  {
    value: 'methods',
    label: t('console.moderation.tabs.methods'),
    badge: pendingMethodChanges.value || undefined,
  },
  { value: 'decided', label: t('console.moderation.tabs.decided') },
])
</script>
