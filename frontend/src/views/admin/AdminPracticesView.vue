<!--
  VELO Frontend -- AdminPracticesView (Admin DS, 2026-06-14, operator SVGs "2 Practices" + upcoming/past)

  Global practices list (all platform practices, across masters). Reached from the
  dashboard «Практик» stat card. Header (back + count badge) + VSegment filter
  (Все / Предстоящие / Прошедшие) + PracticeListCard rows. Tapping a card opens the
  admin practice detail (admin-practice-detail), handing the practice via router state.

  Card = the canonical PracticeListCard (operator reconciliation п.1=А): direction
  icon + title + master (+verified) + bottom meta (date under the icon · duration ·
  capacity in the #badge slot, rose when full). No status badge — capacity took its
  slot in the newer SVGs.

  WIRED (E9, 2026-06-16): GET /api/v1/admin/practices?scope=all|upcoming|past drives
  the list (loading/error/empty states). Header count = the fetched scope total; the
  «Все» segment badge keeps the platform total from /admin/stats. Tapping a card opens
  the detail, which re-fetches by id (GET /admin/practices/:id).
-->

<template>
  <div class="admin-list">
    <header class="admin-list__top">
      <VBackButton @click="router.back()" />
      <span class="admin-list__title">Практики</span>
      <span class="admin-list__count">{{ headerCount }}</span>
    </header>

    <VSegment v-model="filter" :options="segOptions" />

    <div v-if="loading" class="admin-list__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить практики"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
    </VEmptyState>

    <div v-else-if="practices.length" class="admin-list__items">
      <PracticeListCard
        v-for="p in practices"
        :key="p.id"
        :practice="p"
        :when="whenLabel(p)"
        :when-time="whenTime(p)"
        :duration="durationLabel(p)"
        :show-verified="p.master_verified"
        @click="openDetail(p)"
      >
        <template #badge>
          <span class="admin-cap" :class="{ 'admin-cap--full': isFull(p) }">
            <IconGroup :size="14" />{{ p.booked }}/{{ capacityText(p) }}
          </span>
        </template>
      </PracticeListCard>
    </div>

    <VCard v-else>
      <p class="admin-list__empty">Данных пока нет</p>
    </VCard>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VSegment, VCard, VLoader, VEmptyState, VButton } from '@/components/ui'
import type { SegmentOption } from '@/components/ui/VSegment.vue'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'
import { IconGroup } from '@/components/icons'
import { useAdminStore } from '@/stores/admin'
import { getAdminPractices, type AdminPracticeScope } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatDateShort, formatTime } from '@/utils/format'
import type { AdminPracticeListItem } from '@/api/types'

const router = useRouter()
const adminStore = useAdminStore()

const filter = ref('all')
const practices = ref<AdminPracticeListItem[]>([])
const total = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// Platform total from /admin/stats (loaded by AdminShell) — the «Все» badge.
const totalCount = computed<number | null>(() => adminStore.stats?.practices_count ?? null)
// Header count reflects the fetched scope total.
const headerCount = computed<string>(() => (total.value !== null ? String(total.value) : '—'))

const segOptions = computed<SegmentOption[]>(() => [
  { value: 'all', label: 'Все', badge: totalCount.value ?? undefined },
  { value: 'upcoming', label: 'Предстоящие' },
  { value: 'past', label: 'Прошедшие' },
])

function whenLabel(p: AdminPracticeListItem): string {
  // Day label in the practice's own timezone so «Сегодня/Завтра» agrees with
  // the local time shown alongside it (whenTime).
  return formatDateShort(p.scheduled_at, p.timezone)
}
function whenTime(p: AdminPracticeListItem): string {
  return formatTime(p.scheduled_at, p.timezone)
}
function durationLabel(p: AdminPracticeListItem): string {
  return `${p.duration_minutes} мин`
}
function capacityText(p: AdminPracticeListItem): string {
  return p.capacity != null ? String(p.capacity) : '∞'
}
function isFull(p: AdminPracticeListItem): boolean {
  return p.capacity != null && p.booked >= p.capacity
}

async function load(): Promise<void> {
  // Narrow the segment value to the backend scope without a cast.
  const scope: AdminPracticeScope =
    filter.value === 'upcoming' ? 'upcoming' : filter.value === 'past' ? 'past' : 'all'
  loading.value = true
  error.value = null
  try {
    const res = await getAdminPractices(scope, 100, 0)
    practices.value = res.items
    total.value = res.total
  } catch (e) {
    error.value = extractApiError(e, 'Ошибка загрузки')
  } finally {
    loading.value = false
  }
}

// Tap a card -> admin practice detail; it re-fetches by id (GET /admin/practices/:id).
function openDetail(p: AdminPracticeListItem): void {
  router.push({ name: 'admin-practice-detail', params: { id: p.id } })
}

watch(filter, load)
onMounted(load)
</script>

<style scoped>
.admin-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title + real-total count badge -- */
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
  padding: var(--space-6) 0;
}

.admin-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.admin-list__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) var(--space-2);
}

/* Capacity cell in the PracticeListCard #badge slot (rose when full). */
.admin-cap {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-gap-6);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.admin-cap--full {
  color: var(--velo-pink-500);
}
</style>
