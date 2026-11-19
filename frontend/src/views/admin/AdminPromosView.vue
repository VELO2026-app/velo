<!--
  VELO Frontend -- AdminPromosView (T5, PROMPT №418)

  Admin sees + deactivates EVERY master's promos, plus its own company-wide
  ones (operator ask, 2026-07-14: "the admin must see and deactivate the
  promocodes of ALL masters"). Built in the AdminMastersView / AdminWithdrawalsView
  family: header (back + count) + VSegment type/status tabs + card list +
  loader/error/empty states + load-more (AdminWithdrawalsView's pattern).

  DATA IS REAL: GET /api/v1/admin/promos (getAdminPromos) already returned
  company + master promos with type/is_active filters before this batch; the
  only backend addition was the master's name on each item (see
  AdminPromoResponse — TEMP local type in api/admin.ts, pre-regen) and
  widening PATCH .../deactivate to accept master promos too (T5).

  Create (POST /admin/promos, company-only) is out of this batch's scope --
  operator asked for see + deactivate, not a creation screen.

  Each tab is a Pinia Colada infinite query; deactivation runs through
  useAdminMutation (composables/queries/admin.ts, FE-181).
-->

<template>
  <div class="admin-promos">
    <header class="admin-promos__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-promos__title">{{ t('adminScreens.adminPromos.title') }}</h1>
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
      :title="t('adminScreens.adminPromos.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <template #action
        ><VButton variant="primary" @click="retry">{{ t('common.retry') }}</VButton></template
      >
    </VEmptyState>

    <!-- Empty (filter has no promos) -->
    <VEmptyState v-else-if="items.length === 0" icon="list" :title="emptyTitle" />

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
              <span class="pcard__owner-label">{{
                p.type === 'company'
                  ? t('adminScreens.adminPromos.typeCompany')
                  : t('adminScreens.adminPromos.typeMaster')
              }}</span>
              <span class="pcard__owner-name">{{ ownerName(p) }}</span>
            </div>
            <VBadge :variant="p.is_active ? 'success' : 'muted'">
              {{
                p.is_active
                  ? t('adminScreens.adminPromos.active')
                  : t('adminScreens.adminPromos.inactive')
              }}
            </VBadge>
          </div>

          <div class="pcard__body">
            <span class="pcard__icon"><IconPromo :size="32" /></span>
            <span class="pcard__divider" aria-hidden="true"></span>
            <div class="pcard__info">
              <div class="pcard__code">{{ p.code }}</div>
              <div class="pcard__meta">
                {{
                  t('adminScreens.adminPromos.discountLine', {
                    n: p.discount_percent,
                    used: usedLabel(p),
                  })
                }}<br />
                {{ t('promos.untilLabel', { label: untilLabel(p) }) }}
              </div>
            </div>
          </div>

          <div v-if="p.is_active" class="pcard__actions">
            <VButton variant="outline" :loading="deactivatingId === p.id" @click="askDeactivate(p)">
              {{ t('ui.deactivate') }}
            </VButton>
          </div>
        </VCard>
      </div>

      <div v-if="hasMore" class="admin-promos__more">
        <VButton variant="outline" block :loading="loadingMore" @click="loadMore">
          {{ t('common.showMore') }}
        </VButton>
      </div>
    </template>

    <VConfirmDialog
      :open="confirmTarget !== null"
      :message="confirmMessage"
      :confirm-label="t('ui.deactivate')"
      danger
      :loading="deactivatingId !== null"
      @confirm="onConfirmDeactivate"
      @cancel="confirmTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useInfiniteQuery, useQueryCache } from '@pinia/colada'
import {
  VBackButton,
  VButton,
  VLoader,
  VEmptyState,
  VCard,
  VAvatar,
  VBadge,
  VSegment,
  VConfirmDialog,
} from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import { IconPromo } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { deactivateAdminPromo } from '@/api/admin'
import {
  type AdminPromoFilter,
  adminPromosQuery,
  markPromoInactive,
  usePagedListFailures,
  useAdminMutation,
} from '@/composables/queries/admin'
import type { AdminPromoResponse } from '@/api/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { formatShortDate } from '@/utils/format'

const router = useRouter()
const toast = useToast()

const filter = ref<AdminPromoFilter>('all')

const segOptions: SegmentOption[] = [
  { value: 'all', label: t('common.all') },
  { value: 'master', label: t('adminScreens.adminPromos.filterMasters') },
  { value: 'company', label: t('adminScreens.adminPromos.companies') },
  { value: 'inactive', label: t('adminScreens.adminPromos.deactivatedShort') },
]

// One entry per tab (server-side filtered by type / is_active). A tab
// switch starts from the loader: another tab's promos never stand in.
const promosQuery = useInfiniteQuery(() => adminPromosQuery(filter.value))
const items = computed<AdminPromoResponse[]>(
  () => promosQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
)
const total = computed(() => promosQuery.data.value?.pages.at(-1)?.total ?? 0)
const { loading, failed: error } = screenQueryState(promosQuery)
const hasMore = promosQuery.hasNextPage

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

const emptyTitle = computed<string>(() => {
  if (filter.value === 'master') return t('adminScreens.adminPromos.empty.master')
  if (filter.value === 'company') return t('adminScreens.adminPromos.empty.company')
  if (filter.value === 'inactive') return t('adminScreens.adminPromos.empty.inactive')
  return t('adminScreens.adminPromos.empty.title')
})

/** Owner display: master's "First Last" (falls back to t('adminScreens.adminPromos.ownerFallback') like
 *  masterDisplayName), or "VELO" for a company promo (master_id=null). */
function ownerName(p: AdminPromoResponse): string {
  if (p.type === 'company') return t('common.brandName')
  const parts = [p.master_first_name, p.master_last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : t('adminScreens.adminPromos.ownerFallback')
}

function usedLabel(p: AdminPromoResponse): string {
  return t('adminScreens.adminPromos.usedOf', { used: p.used_count, max: p.max_uses ?? '∞' })
}
function untilLabel(p: AdminPromoResponse): string {
  return p.valid_until ? formatShortDate(p.valid_until) : t('adminScreens.adminPromos.noExpiry')
}

// -- Fetch. Every failed request is told: a next page with its own fallback,
//    the list itself (its first load, a refetch) with the list's. --
const { loadingMore, loadMore } = usePagedListFailures(promosQuery, (e, nextPage) =>
  toast.error(
    extractApiError(
      e,
      nextPage ? t('common.loadError') : t('adminScreens.adminPromos.promocodesLoadError'),
    ),
  ),
)

function retry(): void {
  void promosQuery.refetch()
}

// -- Deactivate + confirm --
const confirmTarget = ref<AdminPromoResponse | null>(null)
const deactivatingId = ref<string | null>(null)

// The card flips to inactive in every tab held at once; the invalidation
// (ADMIN_INVALIDATES.deactivatePromo) then refetches the tab on screen --
// the "inactive" tab, server-filtered, picks the promo up on its next read.
const queryCache = useQueryCache()
const deactivate = useAdminMutation(
  'deactivatePromo',
  (promoId: string) => deactivateAdminPromo(promoId),
  {
    write: (_promo, promoId) => markPromoInactive(queryCache, promoId),
    waitForRefetch: false,
  },
)

const confirmMessage = computed<string>(() =>
  confirmTarget.value
    ? t('adminScreens.adminPromos.deactivateConfirm', { code: confirmTarget.value.code })
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
    await deactivate.mutateAsync(target.id)
    toast.success(t('adminScreens.adminPromos.promocodeDeactivated'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminPromos.deactivateFailedToast')))
  } finally {
    deactivatingId.value = null
    confirmTarget.value = null
  }
}
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
  font-weight: 400;
  font-size: var(--velo-fs-16);
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
  font-size: var(--velo-fs-18);
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
  gap: var(--velo-gap-2);
}

.pcard__owner-label {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.pcard__owner-name {
  font-size: var(--velo-fs-16);
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
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pcard__meta {
  margin-top: var(--space-2);
  font-size: var(--velo-fs-16);
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
