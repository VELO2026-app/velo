<!--
  VELO Frontend -- AdminReportsView (Admin DS rebuild 2026-06-14, operator SVGs
  «1 Moderation» + «2 Filter» + «Дата заявки»)

  The «Модерация» tab (admin-reports). Rebuilt to the operator design, replacing the
  F8.3 layout (VHeader + two VSelects): header (back + count badge) + «Фильтр» pill →
  ModerationFilterModal + «Все» label + report cards (warning glyph + reason + relative
  time), on the fog feed with the admin tab bar. Tapping a card opens the report detail.

  DATA. Real: GET /admin/reports (paginated) → reason (title) + created_at (relative
  time); verify/resolve live in the detail. Status filter is wired (Открытая → pending,
  Закрытая → resolved). STUB «honest» (build-full-design-now): the card category glyph
  (single warning — ReportResponse has no category) and the reporter name (no name in the
  payload) are honest placeholders; Категория / Приоритет / date filters have no backend.
  Roadmap (Zod): extend GET /admin/reports — category (ticket/complaint/payment) + priority
  (P0–P3) + date filtering + reporter name. Recorded in master-ds-zod-roadmap.
-->

<template>
  <div class="admin-reports">
    <header class="admin-reports__top">
      <VBackButton @click="router.back()" />
      <span class="admin-reports__title">Модерация</span>
      <span class="admin-reports__count">{{ headerCount }}</span>
    </header>

    <!-- Filter trigger (label echoes the active category, operator variants) -->
    <button type="button" class="admin-reports__filter" @click="showFilter = true">
      <span>{{ pillLabel }}</span>
      <IconFilter :size="22" />
    </button>

    <div v-if="!filter.categories.length" class="admin-reports__active">Все</div>

    <!-- Loading: initial -->
    <div v-if="loading && items.length === 0" class="admin-reports__loader">
      <VLoader size="lg" />
    </div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action
        ><VButton variant="primary" @click="loadInitial">Повторить</VButton></template
      >
    </VEmptyState>

    <!-- Empty -->
    <VEmptyState
      v-else-if="items.length === 0"
      icon="success"
      title="Обращений нет"
      description="По выбранным фильтрам ничего не найдено"
    />

    <template v-else>
      <div class="admin-reports__list">
        <VCard
          v-for="item in items"
          :key="item.id"
          class="rcard"
          clickable
          padding="none"
          @click="openDetail(item)"
        >
          <span v-if="isPayments" class="rcard__icon rcard__icon--pay">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.9" />
              <path
                d="M12 6.5v11M14.6 9c-.5-.8-1.5-1.3-2.6-1.3-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.1 0-2.1-.5-2.6-1.3"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <span v-else class="rcard__icon"><IconWarning :size="34" /></span>
          <div class="rcard__text">
            <div class="rcard__title">{{ item.reason }}</div>
            <div class="rcard__sub">{{ formatRelative(item.created_at) }}</div>
          </div>
        </VCard>
      </div>

      <div v-if="hasMore" class="admin-reports__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          Показать ещё
        </VButton>
      </div>
    </template>

    <ModerationFilterModal
      :open="showFilter"
      :value="filter"
      @apply="onApply"
      @close="showFilter = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VButton, VLoader, VEmptyState, VCard } from '@/components/ui'
import { IconFilter, IconWarning } from '@/components/icons'
import ModerationFilterModal from '@/components/shared/ModerationFilterModal.vue'
import type { ModerationFilter } from '@/components/shared/ModerationFilterModal.vue'
import { useToast } from '@/composables/useToast'
import { getReports } from '@/api/admin'
import type { ReportResponse, ReportStatusFilter } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatRelative } from '@/utils/adminHelpers'

const LIMIT = 20

const router = useRouter()
const toast = useToast()

const items = ref<ReportResponse[]>([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const error = ref(false)

const showFilter = ref(false)
const filter = ref<ModerationFilter>({
  categories: [],
  priorities: [],
  statuses: [],
  date: '',
})

const CATEGORY_LABELS: Record<string, string> = {
  tickets: 'Тикеты',
  complaints: 'Жалобы',
  payments: 'Платежи',
}

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

// Section label reflects the active category filter (honest stub: category has no
// backend yet, so this is a display-only echo of the chosen chips).
const categoryLabel = computed<string>(() => {
  const cats = filter.value.categories
  if (cats.length === 0) return 'Все'
  return cats.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')
})

// The filter pill echoes the active category (operator «payments»/«complaints»
// variants); the «Платежи» selection swaps the card glyph to the payment $.
const pillLabel = computed<string>(() =>
  filter.value.categories.length ? categoryLabel.value : 'Фильтр',
)
const isPayments = computed<boolean>(() => filter.value.categories.includes('payments'))

// Only «Статус» maps to the backend (Открытая → pending, Закрытая → resolved). Both or
// none selected = no status filter (all). The rest of the filter is a Zod stub.
const apiStatus = computed<ReportStatusFilter | undefined>(() => {
  const s = filter.value.statuses
  if (s.length === 1) {
    if (s[0] === 'open') return 'pending'
    if (s[0] === 'closed') return 'resolved'
  }
  return undefined
})

// W-3: generation counter discards stale responses from rapid filter changes.
let generation = 0

async function loadInitial(): Promise<void> {
  generation += 1
  const myGeneration = generation

  loading.value = true
  error.value = false
  items.value = []
  total.value = 0
  hasMore.value = false

  try {
    const res = await getReports(apiStatus.value, undefined, LIMIT, 0)
    if (myGeneration !== generation) return
    items.value = res.items
    total.value = res.total
    hasMore.value = res.items.length < res.total
  } catch (e) {
    if (myGeneration !== generation) return
    error.value = true
    toast.error(extractApiError(e, 'Ошибка загрузки обращений'))
  } finally {
    if (myGeneration === generation) loading.value = false
  }
}

async function loadMore(): Promise<void> {
  loadingMore.value = true
  try {
    const res = await getReports(apiStatus.value, undefined, LIMIT, items.value.length)
    items.value.push(...res.items)
    hasMore.value = items.value.length < res.total
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка загрузки'))
  } finally {
    loadingMore.value = false
  }
}

function onApply(next: ModerationFilter): void {
  filter.value = next
  loadInitial()
}

function openDetail(item: ReportResponse): void {
  router.push({
    name: 'admin-report-detail',
    params: { id: item.id },
    state: { report: JSON.parse(JSON.stringify(item)) },
  })
}

onMounted(loadInitial)
</script>

<style scoped>
.admin-reports {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title + count badge -- */
.admin-reports__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-reports__title {
  flex: 1;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-reports__count {
  min-width: var(--velo-size-38);
  height: var(--velo-size-36);
  padding: 0 var(--velo-inset-12);
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-body);
  font-size: var(--text-base);
  letter-spacing: 0.02em;
}

/* -- Filter pill -- */
.admin-reports__filter {
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

.admin-reports__active {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: calc(-1 * var(--space-1)) var(--velo-gap-2);
}

.admin-reports__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-reports__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* -- Report card -- */
.rcard {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.rcard:active {
  opacity: 0.85;
}

.rcard__icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--velo-pink-300);
}

.rcard__icon--pay {
  color: var(--velo-peach-300);
}

.rcard__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.rcard__title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rcard__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.admin-reports__more {
  padding-top: var(--space-1);
}
</style>
