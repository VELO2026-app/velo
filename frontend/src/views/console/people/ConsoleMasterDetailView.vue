<!--
  VELO Frontend -- ConsoleMasterDetailView (FE-262, slice 1)

  The master's card in the web console (console-masters-detail,
  /console/masters/:id): the web layout of AdminMasterReviewView.

    left   -- who the master is: avatar, name, email, directions and the
              counters the list carries (schools, practices, students, payout);
    right  -- the verdict card while the application is pending (approve /
              reject with a reason), the profile as editable rows, and for a
              verified master the rights and the revoke card.

  DATA IS REAL: GET /admin/masters/{id}, always fetched (no instant paint
  from the list). Not on the backend yet, so not here: sessions and rating,
  accrued and paid totals, the per-session rate, the "publishes without
  moderation" right, the master's practices and finance tabs, history and
  documents.

  A verdict (verify, reject) leaves for the "under review" tab, the queue the
  admin works through; a revoke stays and the card shows the new status.
  "Back" returns to the list it was opened from (its tab and page are in the
  URL), or to the masters list when the card was opened by a link.
-->

<template>
  <ConsolePage
    :title="master ? masterDisplayName(master) : t('console.modules.masters')"
    :crumbs="crumbs"
    testid="console-master-detail"
  >
    <template v-if="master" #title-extra>
      <ConsoleBadge :tone="masterStatusTone(master.master_status)">{{
        masterStatusLabel(master.master_status)
      }}</ConsoleBadge>
    </template>
    <template #actions>
      <VButton variant="ghost" @click="back">{{ t('console.masters.detail.back') }}</VButton>
    </template>

    <div v-if="loading" class="master-detail__state"><VLoader size="lg" /></div>

    <!-- A failed load is told with a retry; a missing master is a dead end of its own. -->
    <VEmptyState
      v-else-if="notFound"
      icon="notfound"
      :title="t('adminScreens.adminMasterReview.notFound')"
      :description="t('adminScreens.adminMasterReview.notFoundHint')"
    />
    <VEmptyState
      v-else-if="failed"
      icon="warning"
      :title="t('common.loadError')"
      :description="errorText"
    >
      <VButton size="sm" variant="outline" @click="query.refetch()">{{
        t('common.retry')
      }}</VButton>
    </VEmptyState>

    <div v-else-if="master" class="master-detail">
      <aside class="master-detail__side">
        <ConsoleCard>
          <div class="master-summary">
            <VAvatar
              :name="masterDisplayName(master)"
              :url="master.avatar_url ?? undefined"
              size="xl"
            />
            <div class="master-summary__who">
              <span class="master-summary__name">{{ masterDisplayName(master) }}</span>
            </div>
          </div>
          <div class="master-summary__chips">
            <template v-if="chips.length">
              <ConsoleBadge
                v-for="(chip, i) in chips"
                :key="`${chip.label}-${i}`"
                :tone="chip.muted ? 'muted' : 'info'"
              >
                {{ chip.label }}
              </ConsoleBadge>
            </template>
            <span v-else class="master-summary__muted">{{
              t('adminScreens.adminMasters.directionsMissing')
            }}</span>
          </div>
          <dl class="master-summary__stats">
            <div v-for="stat in stats" :key="stat.key" class="master-summary__stat">
              <dt>{{ stat.label }}</dt>
              <dd>{{ stat.value }}</dd>
            </div>
          </dl>
        </ConsoleCard>
      </aside>

      <div class="master-detail__main">
        <MasterReviewCard v-if="isPending" :master="master" @decided="toQueue" />
        <ConsoleCard v-else :title="t('console.masters.detail.review')">
          <p class="master-summary__processed">
            {{ t('adminScreens.adminMasterReview.alreadyProcessed')
            }}<strong>{{ masterStatusLabel(master.master_status) }}</strong>
          </p>
        </ConsoleCard>
        <MasterProfileForm :master="master" />
        <MasterRightsCard v-if="isVerified" :master="master" />
      </div>
    </div>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { host } from '@/platform/host'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { VAvatar, VButton, VEmptyState, VLoader } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import MasterProfileForm from '@/components/console/people/MasterProfileForm.vue'
import MasterReviewCard from '@/components/console/people/MasterReviewCard.vue'
import MasterRightsCard from '@/components/console/people/MasterRightsCard.vue'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import {
  DASH,
  countText,
  masterStatusLabel,
  masterStatusTone,
  methodChips,
  payoutText,
} from '@/components/console/people/peopleTable'
import { ApiResponseError } from '@/api/client'
import { adminMasterQuery, onFailedRequest } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { routeParam } from '@/router/routeParam'
import { masterDisplayName } from '@/utils/adminHelpers'
import { consoleHasPayments } from '@/utils/console/options'

// The payout balance is the payments option's: without it the stat is not there.
const paymentsEnabled = consoleHasPayments()

const route = useRoute()
const router = useRouter()
const toast = useToast()

const masterId = routeParam(route, 'id')
const query = useQuery(() => adminMasterQuery(masterId))
const { loading, failed } = screenQueryState(query)
const master = computed(() => query.data.value ?? null)

const notFound = computed(
  () =>
    failed.value &&
    query.error.value instanceof ApiResponseError &&
    query.error.value.status === 404,
)
const errorText = computed(() =>
  extractApiError(query.error.value, t('adminScreens.adminMasterReview.dataLoadError')),
)
// A refresh failing on top of a card already shown stays a toast: a working
// page is not blanked over a secondary failure.
onFailedRequest(query, (e) => {
  if (master.value !== null) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.dataLoadError')))
  }
})

const crumbs = computed(() => `${t('console.groups.people')} · ${t('console.modules.masters')}`)
const isPending = computed(() => master.value?.master_status === 'pending')
const isVerified = computed(() => master.value?.master_status === 'verified')
const chips = computed(() => (master.value ? methodChips(master.value) : []))

// The summary: how to reach the master, then the counters the list carries.
const stats = computed(() => {
  const m = master.value
  if (!m) return []
  return [
    { key: 'phone', label: t('adminScreens.adminMasterReview.phone'), value: m.phone || DASH },
    { key: 'email', label: t('console.masters.detail.email'), value: m.email || DASH },
    {
      key: 'schools',
      label: t('console.masters.columns.schools'),
      value: countText(m.schools_count),
    },
    {
      key: 'practices',
      label: t('adminScreens.adminMasters.practicesStat'),
      value: countText(m.practices_count),
    },
    {
      key: 'students',
      label: t('adminScreens.adminMasters.studentsStat'),
      value: countText(m.students_count),
    },
    {
      key: 'payout',
      label: t('adminScreens.adminMasters.toWithdrawStat'),
      value: payoutText(m.available_cents),
    },
  ].filter((stat) => stat.key !== 'payout' || paymentsEnabled)
})

/** Back to the screen the card was opened from, or the masters list for a direct link. */
function back(): void {
  const previous = (host.history.state as { back?: string | null } | null)?.back
  if (previous && previous.startsWith('/console/')) router.back()
  else void router.push({ name: 'console-masters' })
}

/** After a verdict: the "under review" tab, the next application in the queue. */
function toQueue(): void {
  void router.push({ name: 'console-masters', query: { tab: 'pending' } })
}
</script>

<style scoped>
.master-detail__state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.master-detail {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.master-detail__side {
  flex: 0 0 320px;
  min-width: 0;
}

.master-detail__main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.master-summary {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.master-summary__who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.master-summary__name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
  overflow-wrap: anywhere;
}

.master-summary__muted {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  overflow-wrap: anywhere;
}

.master-summary__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.master-summary__stats {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.master-summary__stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--velo-border-light);
  font-size: var(--velo-fs-14);
}

.master-summary__stat dt {
  color: var(--velo-text-secondary);
}

.master-summary__stat dd {
  margin: 0;
  color: var(--velo-text-primary);
}

.master-summary__processed {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

/* Below 1200 px the menu is folded to icons (the breakpoint of ConsoleSidebar.vue,
   which every console screen keeps in step with): the summary goes on top of the
   cards instead of squeezing them into half a tablet. */
@media (max-width: 1199px) {
  .master-detail {
    flex-direction: column;
    align-items: stretch;
  }

  .master-detail__side {
    flex: 0 0 auto;
  }

  /* The summary rows in a grid, three to a line, instead of a tall list. */
  .master-summary__stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .master-summary__stat {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    overflow-wrap: anywhere;
  }
}
</style>
