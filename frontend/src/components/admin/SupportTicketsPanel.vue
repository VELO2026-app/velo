<!--
  VELO Frontend -- SupportTicketsPanel (B34 PROMPT №713; tickets FE-100 A; «Модерация» FE-100 B)

  The «Обращения» side of «Модерация» (AdminReportsView, owner ruling 25.10):
  every support ticket (BE-162 -- each appeal through a form is its own),
  newest appeal first, from velo's own table (GET /api/v1/support/tickets).
  Was the standalone admin-support screen reached from the dashboard; the
  route is gone, the list lives here (FE-100).

  SHAPE follows «Жалобы» next to it (filter pill -> sheet, «Все» echo label,
  VCard rows, loading/error/empty ladder, «Показать ещё»), plus a «Все | Спам»
  segment: without a status the backend returns every ticket but spam, so
  spam is a tab of its own (owner ruling). The filter is
  SupportTicketsFilterModal -- category (five chips over six categories),
  status, the day of the appeal.

  ONE ROW (owner's mockup 25.10): the category glyph (utils/supportTopics.ts,
  the one table), the topic as the title, «name • time» under it, who took it,
  and the status badge. A row carries no last message: the list does not pay
  a feed call per ticket (known gap, BE-162).

  Tapping a row opens the ticket card with the row as a state hand-off.
  Stale answers from fast filter or tab changes are dropped by a generation
  counter (same as AdminReportsView).
-->

<template>
  <div class="tickets">
    <VSegment v-model="tab" compact :options="tabOptions" />

    <button type="button" class="tickets__filter" @click="showFilter = true">
      <span>{{ pillLabel }}</span>
      <IconFilter :size="22" />
    </button>

    <!-- FE-107: the period statistics of the appeals -- the gate decides
         where it lives (dashboard or its own screen); until then it is its
         own, one hop from the list it sums. -->
    <button type="button" class="tickets__stats" @click="openStats">
      {{ t('adminScreens.adminSupportStats.title') }}
    </button>

    <div class="tickets__active">{{ activeLabel }}</div>

    <div v-if="loading && items.length === 0" class="tickets__loader">
      <VLoader size="lg" />
    </div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="loadInitial">{{ t('common.retry') }}</VButton></template
      >
    </VEmptyState>

    <VEmptyState
      v-else-if="items.length === 0"
      icon="empty"
      :title="t('adminScreens.adminSupport.empty.title')"
      :description="t('adminScreens.adminSupport.empty.text')"
    />

    <template v-else>
      <div class="tickets__list">
        <VCard
          v-for="item in items"
          :key="item.id"
          class="scard"
          clickable
          padding="none"
          @click="openDetail(item)"
        >
          <span
            class="scard__icon"
            :data-category="item.category"
            :style="{ color: supportCategoryIcon(item.category).color }"
          >
            <component :is="supportCategoryIcon(item.category).icon" :size="34" />
          </span>
          <div class="scard__text">
            <div class="scard__title">{{ supportTopicLabel(item.topic) }}</div>
            <div class="scard__sub">
              {{ openerName(item) }} • {{ formatRelative(item.created_at) }}
            </div>
            <div class="scard__claim">{{ claimText(item) }}</div>
            <!-- FE-107: the person's rating, when there is one -- five small
                 stars, filled to the score. No rating shows nothing (the
                 filter's «Без оценки» is how those are found). -->
            <div v-if="item.rating" class="scard__rating" :data-testid="`ticket-rating`">
              <IconStar
                v-for="n in STAR_VALUES"
                :key="n"
                :size="14"
                :filled="n <= item.rating.stars"
                :class="{ 'scard__star--on': n <= item.rating.stars }"
              />
            </div>
          </div>
          <VBadge :variant="supportStatusBadge(item.status)" class="scard__badge">
            {{ supportStatusLabel(item.status) }}
          </VBadge>
        </VCard>
      </div>

      <div v-if="nextCursor" class="tickets__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          {{ t('common.showMore') }}
        </VButton>
      </div>
    </template>

    <SupportTicketsFilterModal
      :open="showFilter"
      :value="filter"
      :show-status="tab === 'all'"
      @apply="onApply"
      @close="showFilter = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { toHistoryState } from '@/utils/historySnapshot'
import { computed, ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VButton, VLoader, VEmptyState, VCard, VBadge, VSegment } from '@/components/ui'
import { IconFilter, IconStar } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { listAdminTickets, type AdminSupportTicket, type SupportRatingFilter } from '@/api/support'
import { extractApiError } from '@/composables/useApiError'
import { formatRelative } from '@/utils/adminHelpers'
import {
  supportCategoryGroupLabel,
  supportCategoryIcon,
  supportStatusBadge,
  supportStatusLabel,
  supportTopicLabel,
} from '@/utils/supportTopics'
import SupportTicketsFilterModal from './SupportTicketsFilterModal.vue'
import {
  EMPTY_SUPPORT_FILTER,
  supportTicketQuery,
  type SupportTicketsFilter,
  type SupportTicketsTab,
} from './supportTicketsFilter'

const LIMIT = 20

/** The rating's five stars, one row value at a time. */
const STAR_VALUES = [1, 2, 3, 4, 5] as const

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const tab = ref<SupportTicketsTab>('all')
const tabOptions = computed(() => [
  { value: 'all', label: t('common.all') },
  { value: 'spam', label: t('adminScreens.adminSupport.statuses.spam') },
])

const filter = ref<SupportTicketsFilter>({ ...EMPTY_SUPPORT_FILTER })
const showFilter = ref(false)

const items = ref<AdminSupportTicket[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref(false)

/** The pill echoes the chosen category (as «Жалобы» does); «Фильтр» without. */
const pillLabel = computed<string>(() =>
  filter.value.group
    ? supportCategoryGroupLabel(filter.value.group)
    : t('adminScreens.adminReports.filter'),
)

/** The label above the list repeats the active filter (owner's mockup):
 *  «Все» without one, else the category, status, rating and day that
 *  apply. */
const activeLabel = computed<string>(() => {
  const parts: string[] = []
  if (filter.value.group) parts.push(supportCategoryGroupLabel(filter.value.group))
  if (tab.value === 'all' && filter.value.status) {
    parts.push(supportStatusLabel(filter.value.status))
  }
  if (filter.value.rating.length) parts.push(ratingFilterLabel(filter.value.rating))
  if (filter.value.date) parts.push(formatDay(filter.value.date))
  return parts.length ? parts.join(' · ') : t('common.all')
})

/** The chosen rating chips as one label: «4 ★, 5 ★» / «4 ★, без оценки». */
function ratingFilterLabel(values: readonly SupportRatingFilter[]): string {
  return values
    .map((v) => (v === 'none' ? t('adminScreens.adminSupport.rating.none') : `${v} ★`))
    .join(', ')
}

function formatDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
  })
}

function openerName(item: AdminSupportTicket): string {
  return item.opener?.name ?? t('adminScreens.adminSupport.userFallback')
}

/** Who took the ticket: nobody, me, or another admin by name. */
function claimText(item: AdminSupportTicket): string {
  const taker = item.claimed_by
  if (!taker) return t('adminScreens.adminSupport.claimedBy.none')
  if (taker.user_id === authStore.user?.id) return t('adminScreens.adminSupport.claimedBy.mine')
  const name = taker.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback')
  return t('adminScreens.adminSupport.claimedBy.other', { name })
}

function query() {
  return supportTicketQuery(tab.value, filter.value, authStore.user?.timezone)
}

// Fast tab/filter changes: only the newest request may write the list.
let generation = 0

async function loadInitial(): Promise<void> {
  generation += 1
  const mine = generation
  loading.value = true
  error.value = false
  items.value = []
  nextCursor.value = null
  try {
    const res = await listAdminTickets({ ...query(), limit: LIMIT })
    if (mine !== generation) return
    items.value = res.tickets
    nextCursor.value = res.next_cursor
  } catch (e) {
    if (mine !== generation) return
    error.value = true
    toast.error(extractApiError(e, t('adminScreens.adminSupport.ticketsLoadError')))
  } finally {
    if (mine === generation) loading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return
  const mine = generation
  loadingMore.value = true
  try {
    const res = await listAdminTickets({ ...query(), limit: LIMIT, cursor: nextCursor.value })
    if (mine !== generation) return
    items.value.push(...res.tickets)
    nextCursor.value = res.next_cursor
  } catch (e) {
    if (mine === generation) toast.error(extractApiError(e, t('common.loadError')))
  } finally {
    loadingMore.value = false
  }
}

function onApply(next: SupportTicketsFilter): void {
  filter.value = next
  void loadInitial()
}

watch(tab, () => void loadInitial())

function openDetail(item: AdminSupportTicket): void {
  void router.push({
    name: 'admin-support-detail',
    params: { id: item.id },
    state: { ticket: toHistoryState(item) },
  })
}

function openStats(): void {
  void router.push({ name: 'admin-support-stats' })
}

onMounted(loadInitial)
</script>

<style scoped>
.tickets {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Filter pill -- the same as «Жалобы» (AdminReportsView .admin-reports__filter). */
.tickets__filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: var(--velo-size-50);
  padding: 0 var(--space-5);
  border: var(--velo-border-width) solid var(--velo-glass-border);
  border-radius: var(--radius-xl);
  background: var(--velo-primary);
  color: var(--velo-white);
  font-family: var(--font-body);
  font-size: var(--text-lg);
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: var(--velo-shadow-glow);
}

.tickets__active {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: calc(-1 * var(--space-1)) var(--velo-gap-2);
}

/* The statistics link (FE-107): a quiet text row right-aligned under the
   filter pill -- an offer, not a competing action. */
.tickets__stats {
  align-self: flex-end;
  margin: calc(-1 * var(--space-3)) 0;
  background: none;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-primary);
  letter-spacing: 0.02em;
  cursor: pointer;
  padding: var(--space-1) var(--space-2);
}

.tickets__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.tickets__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.scard {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.scard:active {
  opacity: 0.85;
}

.scard__icon {
  display: inline-flex;
  flex-shrink: 0;
}

.scard__text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.scard__title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scard__sub,
.scard__claim {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scard__claim {
  color: var(--velo-text-muted);
}

/* The person's rating: five small stars -- empty outlines muted, the
   filled ones to the score in the warm star tone. */
.scard__rating {
  display: flex;
  gap: var(--space-1);
  color: var(--velo-text-muted);
}

.scard__star--on {
  color: var(--velo-peach-500);
}

.scard__badge {
  flex-shrink: 0;
}

.tickets__more {
  margin-top: var(--space-2);
}
</style>
