<!--
  VELO Frontend -- AdminMastersView (Admin DS rebuild 2026-06-14, operator SVGs "1 Masters" all/under-review/verified)

  The «Мастера» tab (admin-masters). Rebuilt to the operator design: header (back +
  count badge) + VSegment status filter (F3: Все / Проверка / Верифиц. / Отклонены /
  Заблок. / Удалены — compact + horizontally scrollable) + master cards.
  A fog-feed tab screen (mandala background, the admin tab bar stays). Tapping a card
  opens the master review (admin-master-review) where verify / reject live.

  DATA IS REAL: GET /admin/masters/list (all masters) -> avatar + name + status badge;
  the 3 filter counts are derived client-side from the fetched list. (The list is
  small; very large lists would need server-side filtering -> Zod.)

  R8 (batch R): the rich card is REAL — направление+вид (methods, chip language
  matching MethodTaxonomyPicker readonly) + Практик / Ученики / К выводу, all
  computed additively in list_masters (admin/users/service.py, 2 bounded
  GROUP-BY queries for the whole page, no N+1). generated.ts now carries these
  fields natively (regenerated at deploy c1dbe08). STUB «—»: only if a field is
  genuinely null (should not happen for a master returned in this page). Опыт / Заявка (applied-at) were dropped from
  the list card in R8 — they never carried real data (always «—»); the detail
  screen (AdminMasterReviewView) already shows Опыт for real.
-->

<template>
  <div class="admin-list">
    <header class="admin-list__top">
      <VBackButton @click="router.back()" />
      <span class="admin-list__title">Мастера</span>
      <span class="admin-list__count">{{ headerCount }}</span>
    </header>

    <VSegment v-model="filter" :options="segOptions" compact scrollable />

    <!-- Batch-INVITE (№258): entry to the one-time invite link screen. -->
    <VButton variant="secondary" block @click="router.push({ name: 'admin-master-invite' })">
      Пригласить мастера
    </VButton>

    <!-- Loading -->
    <div v-if="loading" class="admin-list__loader"><VLoader size="lg" /></div>

    <!-- Fetch error -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить мастеров"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action><VButton variant="primary" @click="load">Повторить</VButton></template>
    </VEmptyState>

    <!-- List -->
    <div v-else-if="filtered.length" class="admin-list__items">
      <button v-for="m in filtered" :key="m.id" type="button" class="mcard" @click="openReview(m)">
        <div class="mcard__head">
          <VAvatar :name="nameOf(m)" :url="m.avatar_url ?? undefined" size="md" />
          <div class="mcard__id">
            <span class="mcard__name">{{ nameOf(m) }}</span>
            <VBadge :variant="masterStatusVariant(m.master_status)" class="mcard__badge">
              <component :is="badgeIcon(m.master_status)" :size="14" />
              {{ badgeLabel(m.master_status) }}
            </VBadge>
          </div>
        </div>

        <!-- R8: направление+вид -- chip language matches MethodTaxonomyPicker
             readonly (filled direction chip + muted style chips), computed via
             the shared methodTaxonomy utils so it never drifts from the
             review-screen parsing. Legacy/unparsed methods fall back to
             verbatim chips (mirrors AdminMasterReviewView hasParsedMethods). -->
        <div class="mcard__taxonomy">
          <template v-if="taxonomyChips(m).length">
            <VChip
              v-for="(c, i) in taxonomyChips(m)"
              :key="`${c.label}-${i}`"
              size="sm"
              :active="!c.muted"
            >
              {{ c.label }}
            </VChip>
          </template>
          <span v-else class="mcard__muted">Направления не указаны</span>
        </div>

        <!-- R8: stats footer -- Практик / Ученики / К выводу, real backend
             aggregates (list_masters, admin/users/service.py). null -> «—»
             (honest stub; should not happen for a master in this page). -->
        <div class="mcard__stats">
          <div class="mcard__stat">
            <span class="mcard__stat-key">Практик</span>
            <span class="mcard__stat-val">{{ statVal(m.practices_count) }}</span>
          </div>
          <div class="mcard__stat">
            <span class="mcard__stat-key">Ученики</span>
            <span class="mcard__stat-val">{{ statVal(m.students_count) }}</span>
          </div>
          <div class="mcard__stat">
            <span class="mcard__stat-key">К выводу</span>
            <span class="mcard__stat-val">{{ payoutVal(m.available_cents) }}</span>
          </div>
        </div>
      </button>
    </div>

    <!-- Empty (filter has no masters) -->
    <VCard v-else
      ><p class="admin-list__empty">{{ emptyText }}</p></VCard
    >
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, type Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  VBackButton,
  VSegment,
  VAvatar,
  VBadge,
  VChip,
  VCard,
  VLoader,
  VEmptyState,
  VButton,
} from '@/components/ui'
import type { SegmentOption } from '@/components/ui/VSegment.vue'
import { IconCheck, IconPending, IconClose } from '@/components/icons'
import { getMastersList } from '@/api/admin'
import type { AdminMasterListItem } from '@/api/admin'
import { masterDisplayName, masterStatusVariant } from '@/utils/adminHelpers'
import { parseMethods, directionLabel, resolveStyleLabel, primeMethodTaxonomyCatalog } from '@/utils/methodTaxonomy'
import { formatMoney } from '@/utils/format'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

/** направление+вид as chip-language entries: filled (active) for the
 *  direction, muted for its styles -- same visual vocabulary as
 *  MethodTaxonomyPicker readonly. Legacy/unparsed methods (no taxonomy match)
 *  fall back to verbatim muted-off chips so nothing silently vanishes. */
function taxonomyChips(m: AdminMasterListItem): { label: string; muted: boolean }[] {
  const methods = m.methods ?? []
  if (!methods.length) return []
  const parsed = parseMethods(methods)
  if (!parsed.directions.length) {
    // Fully-legacy/custom: show verbatim (covers the surfaced customText too).
    return methods.map((label) => ({ label, muted: false }))
  }
  const chips: { label: string; muted: boolean }[] = []
  for (const dir of parsed.directions) {
    chips.push({ label: directionLabel(dir), muted: false })
    for (const st of parsed.styles[dir] ?? []) {
      chips.push({ label: resolveStyleLabel(dir, st), muted: true })
    }
  }
  if (parsed.customEnabled && parsed.customText) {
    chips.push({ label: parsed.customText, muted: false })
  }
  return chips
}

function statVal(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : String(n)
}

function payoutVal(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : formatMoney(cents, 'EUR', 'ru', true)
}

const router = useRouter()
const toast = useToast()

const filter = ref('all')
const masters = ref<AdminMasterListItem[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref(false)

function nameOf(m: AdminMasterListItem): string {
  return masterDisplayName(m)
}

// Filter counts derived from the fetched list (list is small). «Все» uses the API
// total so the header stays correct even if a cap is hit.
function statusCount(status: string): number | undefined {
  return masters.value.filter((m) => m.master_status === status).length || undefined
}

const headerCount = computed<string>(() => (total.value ? String(total.value) : '—'))

// F3: six status tabs. Values map 1:1 to data.account.status. «Заблокированы»
// populates from A1's `suspended`; «Удалены» stays empty until F4 writes
// `cancelled_by_user` (the tab exists, count 0 — expected). F5: short labels;
// the strip is compact + horizontally scrollable (VSegment scrollable).
const segOptions = computed<SegmentOption[]>(() => [
  { value: 'all', label: 'Все', badge: total.value || undefined },
  { value: 'pending', label: 'Проверка', badge: statusCount('pending') },
  { value: 'verified', label: 'Верифиц.', badge: statusCount('verified') },
  { value: 'rejected', label: 'Отклонены', badge: statusCount('rejected') },
  { value: 'suspended', label: 'Заблок.', badge: statusCount('suspended') },
  { value: 'cancelled_by_user', label: 'Удалены', badge: statusCount('cancelled_by_user') },
])

const filtered = computed<AdminMasterListItem[]>(() =>
  filter.value === 'all'
    ? masters.value
    : masters.value.filter((m) => m.master_status === filter.value),
)

const emptyText = computed<string>(() => {
  const byFilter: Record<string, string> = {
    pending: 'Нет мастеров на проверке',
    verified: 'Нет верифицированных мастеров',
    rejected: 'Нет отклонённых мастеров',
    suspended: 'Нет заблокированных мастеров',
    cancelled_by_user: 'Нет удалённых аккаунтов',
  }
  return byFilter[filter.value] ?? 'Мастеров пока нет'
})

// Status badge labels match the operator SVG (the shared helper uses shorter ones).
function badgeLabel(status: string): string {
  if (status === 'verified') return 'Верифицирован'
  if (status === 'pending') return 'Ожидает верификации'
  if (status === 'rejected') return 'Отклонён'
  if (status === 'suspended') return 'Заблокирован'
  if (status === 'cancelled_by_user') return 'Аккаунт удалён'
  return status
}

function badgeIcon(status: string): Component {
  if (status === 'verified') return IconCheck
  if (status === 'pending') return IconPending
  return IconClose
}

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    // Fetch all masters once; filter + count client-side (the list is small).
    // Limit is clamped to the backend page cap (le=100 on /admin/masters/list);
    // 200 was 422-rejected. Alpha: 100 is enough — add pagination when the
    // master count approaches 100 (operator ruling, ПРОМТ №289).
    // Bug 2 fix (ПРОМТ №405): prime the taxonomy catalog cache alongside the
    // masters fetch so a promoted custom method already resolves to a plain
    // chip on first render instead of flashing "custom".
    const [res] = await Promise.all([getMastersList(undefined, 100, 0), primeMethodTaxonomyCatalog()])
    masters.value = res.items
    total.value = res.total
  } catch (e) {
    error.value = true
    toast.error(extractApiError(e, 'Ошибка загрузки мастеров'))
  } finally {
    loading.value = false
  }
}

function openReview(m: AdminMasterListItem): void {
  router.push({
    name: 'admin-master-review',
    params: { id: m.id },
    state: { master: JSON.parse(JSON.stringify(m)) },
  })
}

onMounted(load)
</script>

<style scoped>
.admin-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title + count badge -- */
.admin-list__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-list__title {
  flex: 1;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-list__count {
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

.admin-list__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.admin-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.admin-list__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) var(--space-2);
}

/* -- Master card -- */
.mcard {
  width: 100%;
  background: var(--velo-bg-card-solid);
  border: var(--velo-border-width) solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-body);
  transition: opacity var(--transition-fast);
}

.mcard:active {
  opacity: 0.85;
}

.mcard__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.mcard__id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  align-items: flex-start;
}

.mcard__name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.mcard__badge :deep(svg) {
  flex-shrink: 0;
}

/* -- R8: направление+вид (chip row) -- */
.mcard__taxonomy {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mcard__muted {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.02em;
}

/* -- R8: stats footer (Практик / Ученики / К выводу) -- */
.mcard__stats {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--velo-border-width) solid var(--velo-border-light);
}

.mcard__stat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcard__stat + .mcard__stat {
  border-left: var(--velo-border-width) solid var(--velo-border-light);
  padding-left: var(--space-3);
}

.mcard__stat-key {
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mcard__stat-val {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
