<!--
  VELO Frontend -- AdminParticipantsView (Admin DS, 2026-06-14, operator SVG "1 Participants")

  Global participants list (all platform users). Reached from the dashboard
  «Участников» stat card. Header (back + count badge) + VSegment filter
  (Все / Новые / Активные) + participant rows + load-more.

  DATA (E1): GET /api/v1/admin/participants — filter=all|new|active over the
  current week (new = created_at≥start, active = last_login_at≥start, coarse
  "opened ≥1×" using User.last_login_at, operator Q2=В). Rows show name · ID ·
  practices_count · joined («с Дек 2025») + last-active labels (formatted on the
  FE from created_at / last_login_at). Header count + «Все» badge still show the
  platform total from /admin/stats. admin->user messaging is still a stub toast.
-->

<template>
  <div class="admin-list">
    <header class="admin-list__top">
      <VBackButton @click="router.back()" />
      <h1 class="admin-list__title">Участники</h1>
      <span class="admin-list__count">{{ headerCount }}</span>
    </header>

    <VSegment v-model="filter" :options="segOptions" />

    <template v-if="participants.length">
      <div class="admin-list__items">
        <div v-for="p in participants" :key="p.id" class="prow">
          <span class="prow__avatar">
            <img v-if="p.avatar_url" :src="p.avatar_url" :alt="p.name" class="prow__avatar-img" />
            <IconProfile v-else :size="22" />
          </span>
          <span class="prow__text">
            <span class="prow__name">{{ p.name }}</span>
            <span v-if="p.telegram_id" class="prow__sub">ID {{ p.telegram_id }}</span>
            <span class="prow__meta">
              Практик: {{ p.practices_count }} • с {{ joinedLabel(p.created_at) }}
            </span>
            <span v-if="p.last_login_at" class="prow__meta"
              >Последняя: {{ lastActiveLabel(p.last_login_at) }}</span
            >
          </span>
          <button type="button" class="prow__msg" aria-label="Написать" @click="messageStub">
            <IconMessages :size="22" />
          </button>
        </div>
      </div>

      <div v-if="hasMore" class="admin-list__more">
        <VButton variant="outline" @click="loadMore">Показать ещё</VButton>
      </div>
    </template>

    <!-- W12 fix (PROMPT №409): a failed load used to fall through to the same
         "нет данных" empty state as a genuinely empty list -- indistinguishable
         to the admin, who'd read it as "no participants" rather than "retry". -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить участников"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action
        ><VButton variant="primary" @click="load(true)">Повторить</VButton></template
      >
    </VEmptyState>

    <VCard v-else-if="!loading">
      <p class="admin-list__empty">Данных пока нет</p>
    </VCard>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VSegment, VButton, VCard, VEmptyState } from '@/components/ui'
import type { SegmentOption } from '@/components/ui/VSegment.vue'
import { IconProfile, IconMessages } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useAdminStore } from '@/stores/admin'
import { getParticipants } from '@/api/admin'
import type { AdminParticipant } from '@/api/types'
import { dayLabelOf } from '@/utils/format'

const PAGE = 100

const router = useRouter()
const toast = useToast()
const adminStore = useAdminStore()

// Все / Новые / Активные. new+active window on the current week (backend
// filter over created_at / last_login_at). Changing it refetches from page 0.
type ParticipantFilter = 'all' | 'new' | 'active'
const filter = ref<ParticipantFilter>('all')

const participants = ref<AdminParticipant[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref(false)
const hasMore = computed<boolean>(() => participants.value.length < total.value)

// Header + «Все» badge show the real platform total from /admin/stats (loaded
// by AdminShell) — a stable count independent of the current filter/page.
const totalCount = computed<number | null>(() => adminStore.stats?.users_count ?? null)
const headerCount = computed<string>(() =>
  totalCount.value !== null ? String(totalCount.value) : '—',
)

const segOptions = computed<SegmentOption[]>(() => [
  { value: 'all', label: 'Все', badge: totalCount.value ?? undefined },
  { value: 'new', label: 'Новые' },
  { value: 'active', label: 'Активные' },
])

async function load(reset: boolean): Promise<void> {
  if (loading.value) return
  loading.value = true
  if (reset) error.value = false
  try {
    const pageOffset = reset ? 0 : participants.value.length
    const res = await getParticipants(filter.value, 'week', 0, PAGE, pageOffset)
    total.value = res.total
    participants.value = reset ? res.items : [...participants.value, ...res.items]
  } catch {
    toast.error('Не удалось загрузить участников')
    // A failed initial/filter load (reset) means the list below is genuinely
    // unknown, not empty -- render the real error state (W12) instead of
    // falling through to "Данных пока нет". A failed loadMore leaves the
    // already-loaded page visible; the toast is enough there.
    if (reset) error.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => load(true))
watch(filter, () => load(true))

function loadMore(): void {
  load(false)
}

// "Дек 2025" — registration month, from created_at (UTC).
function joinedLabel(iso: string): string {
  const d = new Date(iso)
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '')
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${d.getUTCFullYear()}`
}

// "Сегодня" / "Вчера" / "24 января" — last app-open, from last_login_at.
function lastActiveLabel(iso: string): string {
  return dayLabelOf(iso)
}

// No admin->user messaging endpoint yet -> stub toast (build-full-design).
function messageStub(): void {
  toast.info('Сообщения пока недоступны')
}
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
  font-weight: 400;
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

.admin-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.admin-list__more {
  display: flex;
  justify-content: center;
  padding-top: var(--space-1);
}

.admin-list__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) var(--space-2);
}

/* -- Participant row -- */
.prow {
  width: 100%;
  background: var(--velo-bg-card-solid);
  border: var(--velo-border-width) solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  text-align: left;
  font-family: var(--font-body);
}

.prow__avatar {
  width: var(--velo-size-41);
  height: var(--velo-size-41);
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-blue-300);
  color: var(--velo-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.prow__avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.prow__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
}

.prow__name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.prow__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.prow__meta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.prow__msg {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.prow__msg:active {
  opacity: 0.85;
}
</style>
