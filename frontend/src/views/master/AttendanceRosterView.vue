<!--
  VELO Frontend -- AttendanceRosterView (Phase-3 Master DS)

  Read-only attendance roster for a practice. Route: /master/practices/:id/roster
  (masterStatusGuard; inside MasterShell, no tab bar — detail route).
  Reached by the «Посещаемость» CTA on MasterPracticeDetailView.

  Decision Р2=А (operator 2026-06-12): a SEPARATE light roster, distinct from the
  «Check-ins» screen (AttendanceView) which keeps mood faces + comments + finalize.
  This screen is purely the ✓ attended / ✗ no-show name lists — no mood, no comment,
  no finalize action.

  Sections (operator SVG "6 Attendance 1/2"):
    - VHeader (back + "Посещаемость").
    - Hero card: direction icon + title + date·time / duration.
    - 2 VStatCard: Присутствовало (teal) / Не пришли (rose).
    - «Присутствовали»: ✓ rows (teal check + name); «+ еще N участников» expands.
    - «Не пришли»: ✗ rows (rose cross + name); «+ еще N» expands.

  Data: REAL — GET /practices/:id/attendance. Stats = attended/no_show aggregates;
  lists = items filtered by status (display_name; avatar not shown per design).
-->

<template>
  <div class="roster">
    <VHeader title="Посещаемость" show-back @back="router.back()" />

    <!-- Loading -->
    <div v-if="loading" class="roster__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="roster__content">
      <VEmptyState icon="warning" title="Не удалось загрузить посещаемость" :description="error">
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>
    </div>

    <template v-else-if="attendance">
      <div class="roster__content">
        <!-- Hero (shared PracticeHeroCard; titleSize base canon, icon-46) -->
        <PracticeHeroCard
          v-if="practice"
          :title="practice.title"
          title-size="base"
          :date="whenLabel"
          :duration="durationLabel"
          :direction="practice.direction"
        />

        <!-- Stats -->
        <div class="roster__stats">
          <VStatCard :value="attendance.attended" label="Присутствовало" value-tone="teal" />
          <VStatCard :value="attendance.no_show" label="Не пришли" value-tone="rose" />
        </div>

        <!-- T21-1 (ПРОМТ №541): the unmatched bucket, made VISIBLE here too --
             backend has computed unmatched_count since E21 step G with no
             consumer until now (ПРОМТ №540 audit). Shown only when non-zero:
             this is a heads-up for the master, not a permanent stat card. -->
        <VBadge v-if="(attendance.unmatched_count ?? 0) > 0" variant="warning" class="roster__unmatched-note">
          {{ attendance.unmatched_count }} участник(а) Zoom не удалось сопоставить с записью
        </VBadge>

        <!-- Empty (no bookings at all) -->
        <VEmptyState
          v-if="attendedItems.length === 0 && noShowItems.length === 0"
          icon="group"
          title="Нет данных о посещаемости"
          description="На этой практике никто не отмечен"
        />

        <!-- Присутствовали -->
        <section v-if="attendedItems.length > 0" class="roster__section">
          <h2 class="velo-section-title">Присутствовали</h2>
          <div v-for="item in visibleAttended" :key="item.booking_id" class="roster__row">
            <IconCheck :size="24" class="roster__ic roster__ic--ok" />
            <span class="roster__name">{{ displayName(item) }}</span>
          </div>
          <VShowMore
            v-if="hiddenAttended > 0"
            label="посмотреть еще"
            @click="attendedExpanded = true"
          />
        </section>

        <!-- Не пришли -->
        <section v-if="noShowItems.length > 0" class="roster__section">
          <h2 class="velo-section-title">Не пришли</h2>
          <div v-for="item in visibleNoShow" :key="item.booking_id" class="roster__row">
            <IconClose :size="24" class="roster__ic roster__ic--no" />
            <span class="roster__name">{{ displayName(item) }}</span>
          </div>
          <VShowMore
            v-if="hiddenNoShow > 0"
            label="посмотреть еще"
            @click="noShowExpanded = true"
          />
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMasterStore } from '@/stores/master'
import { getPractice, getAttendance } from '@/api/practices'
import { extractApiError } from '@/composables/useApiError'
import { VStatCard, VButton, VLoader, VEmptyState, VBadge } from '@/components/ui'
import VShowMore from '@/components/shared/VShowMore.vue'
import PracticeHeroCard from '@/components/shared/PracticeHeroCard.vue'
import { VHeader } from '@/components/layout'
import { IconCheck, IconClose } from '@/components/icons'
import { formatDateShort, formatTime } from '@/utils/format'
import type { PracticeResponse, AttendanceResponse, AttendanceItemResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const masterStore = useMasterStore()

const practiceId = route.params.id as string

const COLLAPSE_THRESHOLD = 10

// -- Data --
const practice = ref<PracticeResponse | null>(null)
const attendance = ref<AttendanceResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const attendedExpanded = ref(false)
const noShowExpanded = ref(false)

// -- Hero meta --
const whenLabel = computed((): string => {
  if (!practice.value) return ''
  const day = formatDateShort(practice.value.scheduled_at, practice.value.timezone)
  const time = formatTime(practice.value.scheduled_at, practice.value.timezone)
  return `${day}, ${time}`
})

const durationLabel = computed((): string =>
  practice.value ? `${practice.value.duration_minutes} мин` : '',
)

// -- Roster lists (from items, filtered by status) --
const attendedItems = computed((): AttendanceItemResponse[] =>
  (attendance.value?.items ?? []).filter((i) => i.status === 'attended'),
)
const noShowItems = computed((): AttendanceItemResponse[] =>
  (attendance.value?.items ?? []).filter((i) => i.status === 'no_show'),
)

const visibleAttended = computed((): AttendanceItemResponse[] =>
  attendedExpanded.value ? attendedItems.value : attendedItems.value.slice(0, COLLAPSE_THRESHOLD),
)
const visibleNoShow = computed((): AttendanceItemResponse[] =>
  noShowExpanded.value ? noShowItems.value : noShowItems.value.slice(0, COLLAPSE_THRESHOLD),
)

const hiddenAttended = computed((): number =>
  attendedExpanded.value ? 0 : Math.max(0, attendedItems.value.length - COLLAPSE_THRESHOLD),
)
const hiddenNoShow = computed((): number =>
  noShowExpanded.value ? 0 : Math.max(0, noShowItems.value.length - COLLAPSE_THRESHOLD),
)

// -- Display helper --
function displayName(item: AttendanceItemResponse): string {
  return item.user_display_name || `#${item.user_id.slice(0, 8)}`
}

// -- Load --
async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const cached = masterStore.practices.find((p) => p.id === practiceId)
    if (cached) {
      practice.value = cached
    }
    const [attendanceData] = await Promise.all([
      getAttendance(practiceId),
      cached ? Promise.resolve() : loadPractice(),
    ])
    attendance.value = attendanceData
  } catch (e) {
    error.value = extractApiError(e, 'Ошибка загрузки')
  } finally {
    loading.value = false
  }
}

async function loadPractice(): Promise<void> {
  try {
    practice.value = await getPractice(practiceId)
  } catch {
    // Non-critical: the hero card just won't render; stats/roster still show.
  }
}

onMounted(load)
</script>

<style scoped>
.roster {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.roster__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.roster__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding).
     Top tightened (operator ПРОМТ №161): back-button → hero sits closer. */
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ===== Stats (2-col, coloured values) ===== */
.roster__stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

.roster__unmatched-note {
  display: block;
  width: fit-content;
  text-align: center;
}

/* ===== Section ===== */
/* Row-to-row spacing tightened (operator ПРОМТ №161). */
.roster__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* ===== Roster row ===== */
.roster__row {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  min-height: 47px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--velo-inset-row);
}

.roster__ic {
  flex-shrink: 0;
}

.roster__ic--ok {
  color: var(--velo-success);
}

.roster__ic--no {
  color: var(--velo-error);
}

.roster__name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

</style>
