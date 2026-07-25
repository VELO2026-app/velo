<!--
  VELO Frontend -- AdminPromosView (T5, ПРОМТ №418)

  Admin sees + deactivates EVERY master's promos, plus its own company-wide
  ones (operator ask, 2026-07-14: "админ должен видеть и деактивировать
  промокоды ВСЕХ мастеров"). Built in the AdminMastersView / AdminWithdrawalsView
  family: header (back + count) + VSegment type/status tabs + card list +
  loader/error/empty states + load-more (AdminWithdrawalsView's pattern).

  DATA IS REAL: GET /api/v1/admin/promos (getAdminPromos) already returned
  company + master promos with type/is_active filters before this batch; the
  only backend addition was the master's name on each item (see
  AdminPromoResponse — TEMP local type in api/admin.ts, pre-regen) and
  widening PATCH .../deactivate to accept master promos too (T5).

  Create (POST /admin/promos, company-only) is out of this batch's scope --
  operator asked for see + deactivate, not a creation screen.
-->

<template>
  <div class="admin-promos">
    <header class="admin-promos__top">
      <VBackButton @click="router.back()" />
      <span class="admin-promos__title">Промокоды</span>
      <span class="admin-promos__count">{{ headerCount }}</span>
    </header>

    <VSegment v-model="filter" :options="segOptions" compact scrollable />

    <!-- Loading: initial -->
    <div v-if="loading && items.length === 0" class="admin-promos__loader">
      <VLoader size="lg" />
    </div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить промокоды"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action
        ><VButton variant="primary" @click="loadInitial">Повторить</VButton></template
      >
    </VEmptyState>

    <!-- Empty (filter has no promos) -->
    <VEmptyState
      v-else-if="items.length === 0"
      icon="list"
      :title="emptyTitle"
    />

    <template v-else>
      <div class="admin-promos__list">
        <VCard
          v-for="p in items"
          :key="p.id"
          class="pcard"
          :class="{ 'pcard--inactive': !p.is_active }"
        >
          <div class="pcard__head">
            <VAvatar :name="ownerName(p)" size="md" />
            <div class="pcard__owner">
              <span class="pcard__owner-label">{{ p.type === 'company' ? 'Компания' : 'Мастер' }}</span>
              <span class="pcard__owner-name">{{ ownerName(p) }}</span>
            </div>
            <VBadge :variant="p.is_active ? 'success' : 'muted'">
              {{ p.is_active ? 'Активен' : 'Деактивирован' }}
            </VBadge>
          </div>

          <div class="pcard__body">
            <span class="pcard__icon"><IconPromo :size="32" /></span>
            <span class="pcard__divider" aria-hidden="true"></span>
            <div class="pcard__info">
              <div class="pcard__code">{{ p.code }}</div>
              <div class="pcard__meta">
                Скидка: {{ p.discount_percent }}% · Использовано: {{ usedLabel(p) }}<br />
                Действует до: {{ untilLabel(p) }}
              </div>
            </div>
          </div>

          <div v-if="p.is_active" class="pcard__actions">
            <VButton
              variant="outline"
              :loading="deactivatingId === p.id"
              @click="askDeactivate(p)"
            >
              Деактивировать
            </VButton>
          </div>
        </VCard>
      </div>

      <div v-if="hasMore" class="admin-promos__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          Показать ещё
        </VButton>
      </div>
    </template>

    <VConfirmDialog
      :open="confirmTarget !== null"
      :message="confirmMessage"
      confirm-label="Деактивировать"
      danger
      :loading="deactivatingId !== null"
      @confirm="onConfirmDeactivate"
      @cancel="confirmTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VButton, VLoader, VEmptyState, VCard, VAvatar, VBadge, VSegment, VConfirmDialog } from '@/components/ui'
import type { SegmentOption } from '@/components/ui/VSegment.vue'
import { IconPromo } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { getAdminPromos, deactivateAdminPromo } from '@/api/admin'
import type { AdminPromoResponse, AdminPromoTypeFilter } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatShortDate } from '@/utils/format'

const LIMIT = 20

const router = useRouter()
const toast = useToast()

type Filter = 'all' | 'master' | 'company' | 'inactive'
const filter = ref<Filter>('all')

const segOptions: SegmentOption[] = [
  { value: 'all', label: 'Все' },
  { value: 'master', label: 'Мастеров' },
  { value: 'company', label: 'Компании' },
  { value: 'inactive', label: 'Деактивир.' },
]

const items = ref<AdminPromoResponse[]>([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const error = ref(false)

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

const emptyTitle = computed<string>(() => {
  if (filter.value === 'master') return 'Нет промокодов мастеров'
  if (filter.value === 'company') return 'Нет промокодов компании'
  if (filter.value === 'inactive') return 'Нет деактивированных промокодов'
  return 'Промокодов пока нет'
})

/** Query params for the current tab -- server-side filtered (type/is_active),
 *  mirroring getAdminWithdrawals' approach rather than AdminMastersView's
 *  client-side filter (a promo list can grow past one page per master). */
function currentParams(): { type?: AdminPromoTypeFilter; isActive?: boolean } {
  if (filter.value === 'master') return { type: 'master' }
  if (filter.value === 'company') return { type: 'company' }
  if (filter.value === 'inactive') return { isActive: false }
  return {}
}

/** Owner display: master's "First Last" (falls back to "Пользователь" like
 *  masterDisplayName), or "VELO" for a company promo (master_id=null). */
function ownerName(p: AdminPromoResponse): string {
  if (p.type === 'company') return 'VELO'
  const parts = [p.master_first_name, p.master_last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Пользователь'
}

function usedLabel(p: AdminPromoResponse): string {
  return `${p.used_count} из ${p.max_uses ?? '∞'}`
}
function untilLabel(p: AdminPromoResponse): string {
  return p.valid_until ? formatShortDate(p.valid_until) : 'бессрочно'
}

// -- Fetch (generation counter discards stale responses on rapid tab-switch,
//    same pattern as AdminWithdrawalsView/AdminReportsView). --
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
    const { type, isActive } = currentParams()
    const res = await getAdminPromos(type, isActive, LIMIT, 0)
    if (myGeneration !== generation) return
    items.value = res.items
    total.value = res.total
    hasMore.value = res.items.length < res.total
  } catch (e) {
    if (myGeneration !== generation) return
    error.value = true
    toast.error(extractApiError(e, 'Ошибка загрузки промокодов'))
  } finally {
    if (myGeneration === generation) loading.value = false
  }
}

async function loadMore(): Promise<void> {
  loadingMore.value = true
  try {
    const { type, isActive } = currentParams()
    const res = await getAdminPromos(type, isActive, LIMIT, items.value.length)
    items.value.push(...res.items)
    hasMore.value = items.value.length < res.total
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка загрузки'))
  } finally {
    loadingMore.value = false
  }
}

// -- Deactivate + confirm --
const confirmTarget = ref<AdminPromoResponse | null>(null)
const deactivatingId = ref<string | null>(null)

const confirmMessage = computed<string>(() =>
  confirmTarget.value
    ? `Деактивировать промокод ${confirmTarget.value.code}? Мастер и участники больше не смогут им воспользоваться.`
    : '',
)

function askDeactivate(p: AdminPromoResponse): void {
  confirmTarget.value = p
}

async function onConfirmDeactivate(): Promise<void> {
  const target = confirmTarget.value
  if (!target || deactivatingId.value) return
  deactivatingId.value = target.id
  try {
    await deactivateAdminPromo(target.id)
    const item = items.value.find((p) => p.id === target.id)
    if (item) item.is_active = false
    // The "inactive" tab is server-filtered on is_active=false -- a promo
    // deactivated while that tab is open already satisfies the filter, so no
    // removal needed there. Any other tab just flips the badge in place.
    toast.success('Промокод деактивирован')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось деактивировать промокод'))
  } finally {
    deactivatingId.value = null
    confirmTarget.value = null
  }
}

watch(filter, loadInitial)
onMounted(loadInitial)
</script>

<style scoped>
.admin-promos {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.admin-promos__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-promos__title {
  flex: 1;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-promos__count {
  min-width: var(--velo-size-48);
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

.admin-promos__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-promos__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.admin-promos__more {
  padding-top: var(--space-2);
}

/* -- Promo card -- */
.pcard {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pcard--inactive {
  opacity: 0.6;
}

.pcard__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.pcard__owner {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pcard__owner-label {
  font-size: 11px;
  color: var(--velo-text-muted);
}

.pcard__owner-name {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pcard__body {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.pcard__icon {
  flex-shrink: 0;
  color: var(--velo-primary);
  display: flex;
}

.pcard__divider {
  align-self: stretch;
  width: 0;
  border-left: var(--velo-divider-width) dashed var(--velo-divider);
}

.pcard__info {
  flex: 1;
  min-width: 0;
}

.pcard__code {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pcard__meta {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
}

.pcard__actions {
  display: flex;
}

.pcard__actions > * {
  flex: 1;
}
</style>
