<!--
  VELO Frontend -- ConsoleFinanceView (FE-262, slice 4, FE-267)

  The Finance module of the web console. Two tabs on what the API has today:
  Payouts (the withdrawal queue -- only on an instance with the payments
  option) and Promo codes. The month report, the invoice list, the master
  accruals and the prices wait for the backend (FE-269); their tabs are not
  shown until they exist.

  The tab rides the URL (`?tab=withdrawals|promos`, the first available tab by
  default), so a reload and the back button land where the admin was. The
  number on the Payouts tab is the count of requests awaiting a verdict.
-->

<template>
  <ConsolePage
    :title="t('console.modules.finance')"
    :crumbs="t('console.groups.money')"
    testid="console-finance"
  >
    <template v-if="tabs.length > 1" #tabs>
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
import { useUrlChoice } from '@/components/console/finance/useUrlChoice'
import { adminPendingWithdrawalsQuery } from '@/composables/queries/admin'
import { isOptionEnabled } from '@/platform/instance'

type FinanceTab = 'withdrawals' | 'promos'

// The payout queue is the payments option's surface: an instance without the
// option has no such tab. The option is fixed for the life of the page.
const paymentsOn = isOptionEnabled('payments')
const tabs: readonly [FinanceTab, ...FinanceTab[]] = paymentsOn
  ? ['withdrawals', 'promos']
  : ['promos']

// A new tab drops the status, the filter and the page of the old one.
const { value: tab, set: setTab } = useUrlChoice('tab', tabs, ['status', 'filter', 'page'])

// The pending count is its own request, asked only where the tab exists.
const pendingQuery = useQuery(() => adminPendingWithdrawalsQuery(paymentsOn))

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
