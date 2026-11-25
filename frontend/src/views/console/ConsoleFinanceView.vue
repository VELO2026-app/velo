<!--
  VELO Frontend -- ConsoleFinanceView (FE-262, slice 4, FE-267)

  The Finance module of the web console. Two tabs on what the API has today:
  Payouts (the withdrawal queue) and Promo codes. The month report, the
  invoice list, the master accruals and the prices wait for the backend
  (FE-269); their tabs are not shown until they exist.

  The module is the payments option's (utils/console/modules.ts): an instance
  without the option has no Finance in the menu, and the router sends a typed
  address to the "section unavailable" screen -- so this screen always has
  both tabs.

  The tab rides the URL (`?tab=withdrawals|promos`, Payouts by default), so a
  reload and the back button land where the admin was. The number on the
  Payouts tab is the count of requests awaiting a verdict.
-->

<template>
  <ConsolePage
    :title="t('console.modules.finance')"
    :crumbs="t('console.groups.money')"
    testid="console-finance"
  >
    <template #tabs>
      <VSegment
        compact
        :model-value="tab"
        :options="tabOptions"
        :aria-label="t('console.finance.tabs.label')"
        @update:model-value="setTab"
      />
    </template>

    <WithdrawalsPanel v-if="tab === 'withdrawals'" />
    <PromosPanel v-else />
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useQuery } from '@pinia/colada'
import { VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import PromosPanel from '@/components/console/finance/PromosPanel.vue'
import WithdrawalsPanel from '@/components/console/finance/WithdrawalsPanel.vue'
import { countedLabel } from '@/components/console/finance/financeFormat'
import { useUrlChoice } from '@/composables/console/useUrlChoice'
import { adminPendingWithdrawalsQuery } from '@/composables/queries/admin'

type FinanceTab = 'withdrawals' | 'promos'

const tabs: readonly [FinanceTab, ...FinanceTab[]] = ['withdrawals', 'promos']

// A new tab drops the status, the filter and the page of the old one.
const { value: tab, set: setTab } = useUrlChoice('tab', tabs, ['status', 'filter', 'page'])

const pendingQuery = useQuery(() => adminPendingWithdrawalsQuery(true))

const tabOptions = computed<SegmentOption[]>(() =>
  tabs.map((value) => {
    const label = t(`console.finance.tabs.${value}`)
    return {
      value,
      label: value === 'withdrawals' ? countedLabel(label, pendingQuery.data.value ?? 0) : label,
    }
  }),
)
</script>
