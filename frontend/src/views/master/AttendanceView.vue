<!--
  VELO Frontend -- AttendanceView (Master DS rebuild 2026-06-11, "Check-ins")

  Per-practice check-ins for the master, rebuilt to the approved design.
  Protected by masterStatusGuard. Rendered inside MasterShell.

  Data: GET /api/v1/practices/:id/attendance -> AttendanceResponse.
  Each item (AttendanceItemResponse) is enriched for the master's prep view:
    - user_display_name / user_avatar_url identify the participant
    - checkin = their PRE check-in for this practice (mood 1..10 + comment), or null
    - status (attended / no_show / pending / confirmed)

  Layout:
    - Header "Check-ins" + count badge (checked-in / total).
    - Practice card (icon + title + when).
    - One card per participant: mood face (from checkin.mood) + name + comment;
      no-show -> muted × avatar; not-yet-checked-in -> muted initials.
    - Read-only: no finalize button (manual finalize removed; completion is
      auto-by-duration, pending backend).

  Note: the design's secondary "message" bubble is a future master↔participant
  messaging feature (no backend) — not rendered here; only the real pre-check-in
  comment is shown.
-->

<template>
  <div class="checkins">
    <VHeader
      title="Check-ins"
      show-back
      :badge="attendance ? checkinBadge : undefined"
      @back="goBack"
    />

    <!-- Loading -->
    <div v-if="loading" class="checkins__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="checkins__content">
      <VEmptyState icon="warning" title="Не удалось загрузить check-ins" :description="error">
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>
    </div>

    <template v-else-if="attendance">
      <div class="checkins__content">
        <!-- Practice card -->
        <VCard v-if="practice" class="checkins__practice">
          <component :is="practiceIcon" :size="44" class="checkins__practice-ico" />
          <div class="checkins__practice-info">
            <div class="checkins__practice-title">{{ practice.title }}</div>
            <div v-if="practiceWhen" class="checkins__practice-sub">{{ practiceWhen }}</div>
          </div>
        </VCard>

        <!-- Empty -->
        <VEmptyState
          v-if="attendance.total === 0"
          icon="group"
          title="Нет записавшихся"
          description="На эту практику ещё никто не записался"
        />

        <!-- Participants -->
        <div v-for="item in sortedItems" :key="item.booking_id" class="checkins__item">
          <MoodAvatar v-if="item.checkin" :mood="item.checkin.mood" :size="46" />
          <span v-else-if="item.status === 'no_show'" class="checkins__face checkins__face--noshow">
            <IconClose :size="20" />
          </span>
          <span v-else class="checkins__face checkins__face--pending">{{ initials(item) }}</span>

          <div class="checkins__body">
            <div class="checkins__name">{{ displayName(item) }}</div>
            <div v-if="item.checkin?.comment" class="checkins__comment">
              {{ item.checkin.comment }}
            </div>
            <div v-else-if="item.status === 'no_show'" class="checkins__meta">Не пришёл</div>
            <!-- Checked in (mood submitted) but left no comment: do NOT say
                 «Ожидает check-in» — their mood face already shows they're in. -->
            <div v-else-if="item.checkin" class="checkins__meta">Без комментария</div>
            <div v-else class="checkins__meta">Ожидает check-in</div>
          </div>
        </div>

        <!-- «Финализировать практику» убрана (operator 2026-06-18): завершение —
             авто по расписанию (Зод auto-finalizer). -->
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VLoader, VEmptyState, VCard } from '@/components/ui'
import { IconClose } from '@/components/icons'
import MoodAvatar from '@/components/shared/MoodAvatar.vue'
import { useMasterStore } from '@/stores/master'
import { getAttendance, getPractice } from '@/api/practices'
import { formatDateShort, formatTime } from '@/utils/format'
import { practiceIconFor } from '@/utils/displayHelpers'
import { extractApiError } from '@/composables/useApiError'
import type { AttendanceResponse, AttendanceItemResponse, PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const masterStore = useMasterStore()

const practiceId = route.params.id as string

// -- Data --
const attendance = ref<AttendanceResponse | null>(null)
const practice = ref<PracticeResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// -- Header count badge: how many left a pre-check-in, of the total booked. --
const checkinBadge = computed((): string => {
  const items = attendance.value?.items ?? []
  const checkedIn = items.filter((i) => i.checkin).length
  return `${checkedIn}/${attendance.value?.total ?? items.length}`
})

// -- Practice card --
const practiceIcon = computed(() => (practice.value ? practiceIconFor(practice.value) : null))
const practiceWhen = computed((): string => {
  if (!practice.value) return ''
  const day = formatDateShort(practice.value.scheduled_at, practice.value.timezone)
  const time = formatTime(practice.value.scheduled_at, practice.value.timezone)
  return `${day}, ${time}`
})

// -- Items: checked-in first, then awaiting, then no-shows. --
const sortedItems = computed((): AttendanceItemResponse[] => {
  const rank = (i: AttendanceItemResponse): number => {
    if (i.checkin) return 0
    if (i.status === 'no_show') return 2
    return 1
  }
  return [...(attendance.value?.items ?? [])].sort((a, b) => rank(a) - rank(b))
})

// -- Display helpers --
function displayName(item: AttendanceItemResponse): string {
  return item.user_display_name || `#${item.user_id.slice(0, 8)}`
}
function initials(item: AttendanceItemResponse): string {
  const name = (item.user_display_name || item.user_id).trim()
  return (name.charAt(0) || '?').toUpperCase()
}

function goBack(): void {
  router.back()
}

// -- Load attendance + practice --
async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [attendanceData] = await Promise.all([getAttendance(practiceId), loadPractice()])
    attendance.value = attendanceData
  } catch (e) {
    error.value = extractApiError(e, 'Ошибка загрузки')
  } finally {
    loading.value = false
  }
}

async function loadPractice(): Promise<void> {
  const cached = masterStore.practices.find((p) => p.id === practiceId)
  if (cached) {
    practice.value = cached
    return
  }
  try {
    practice.value = await getPractice(practiceId)
  } catch {
    // Non-critical: the practice card just won't show.
  }
}

onMounted(load)
</script>

<style scoped>
.checkins {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.checkins__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.checkins__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). Top
     trimmed to sit closer to the floating header (parity with Create/Edit/
     Students; operator 2026-06-25). */
  padding: var(--space-2) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* -- Practice card -- */
.checkins__practice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.checkins__practice-ico {
  flex-shrink: 0;
  color: var(--velo-text-primary);
}

.checkins__practice-info {
  min-width: 0;
}

.checkins__practice-title {
  font-family: var(--font-body);
  font-size: var(--text-base);  color: var(--velo-text-primary);
}

.checkins__practice-sub {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-2);
}

/* -- Participant card -- */
.checkins__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
}

/* Non-mood avatars (no-show ×, awaiting initials): muted blue-grey circle. */
.checkins__face {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  flex-shrink: 0;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--velo-glass-blue-60);
  color: var(--velo-text-secondary);
  font-family: var(--font-body);
  font-size: var(--text-base);
}

.checkins__body {
  flex: 1;
  min-width: 0;
  /* Center the single name line against the 46px avatar. */
  align-self: center;
}

.checkins__name {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
}

.checkins__comment {
  font-family: var(--font-body);
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-3);
}

.checkins__meta {
  font-family: var(--font-body);
  font-size: var(--text-12);
  color: var(--velo-text-muted);
  margin-top: var(--velo-gap-3);
}
</style>
