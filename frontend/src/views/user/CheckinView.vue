<!--
  VELO Frontend -- CheckinView (Phase F9.1, updated back-button, WARNING-9)

  Full-screen pre-practice check-in form.
  Uses FormShell for shared layout/CSS. Only mood-specific logic stays here.

  Route: /user/checkin/:practiceId
  Param: practiceId (practice UUID)
-->

<template>
  <FormShell
    back-label="Check-in"
    :practice="practice"
    :practice-loading="practiceLoading"
    :load-error="practiceLoadError"
    question-title="Как вы себя чувствуете?"
    question-subtitle="Оцените своё состояние перед практикой"
    v-model:comment="comment"
    :submitting="diaryStore.checkinSubmitting"
    :submit-disabled="windowClosed"
    :disabled-hint="practice && windowClosed ? 'Check-in закрыт — практика уже началась' : ''"
    submit-label="Отправить"
    :show-skip="true"
    :submitted="submitted"
    success-title="Check-in отправлен"
    success-text="Ваше состояние записано, хорошей практики!"
    @back="onBack"
    @retry="loadPractice"
    @submit="onSubmit"
    @skip="onSkip"
  >
    <!-- Practice meta — две колонки (Figma 2266:716): мастер | дата. -->
    <template #practice-meta>
      <span class="form-shell__practice-meta-cell">
        с {{ practice?.master_name ?? 'Мастером' }}
      </span>
      <span class="form-shell__practice-meta-cell">
        <IconCalendar :size="14" /> {{ formattedDate }}
      </span>
    </template>

    <!-- Mood selector: selected face grows to center, others shrink/dim.
         The track + dot below is a decorative indicator of the discrete
         choice (low/mid/high) -- not a real range slider. -->
    <template #selection>
      <div class="checkin__mood">
        <MoodSlider
          v-model="moodScore"
          :zones="MOOD_ZONES"
          aria-label="Оценка состояния от 1 до 10"
        />
      </div>
    </template>

    <!-- Success icon: reused IconCheck in a teal circle (Figma 13) -->
    <template #success-icon>
      <span class="checkin__success-check">
        <IconCheck :size="48" />
      </span>
    </template>

    <!-- Success actions -->
    <template #success-actions>
      <VButton variant="primary" size="lg" block @click="goToPracticeLive">
        Начать практику
      </VButton>
      <VButton variant="ghost" block @click="goToDashboard"> На главную </VButton>
    </template>
  </FormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useBookingsStore } from '@/stores/bookings'
import { useDiaryStore } from '@/stores/diary'
import { useToast } from '@/composables/useToast'
import { platform } from '@/platform'
import { VButton } from '@/components/ui'
import FormShell from '@/components/shared/FormShell.vue'
import MoodSlider from '@/components/shared/MoodSlider.vue'
import { IconCalendar, IconCheck, IconMoodLow, IconMoodMid, IconMoodHigh } from '@/components/icons'
import { formatDate } from '@/utils/format'
import { useViewerTimezone } from '@/composables/useViewerTimezone'

// Three slider zones (low -> high), passed to MoodSlider. Icons are .vue
// components, so this stays in the view (not in the utils layer). Labels
// mirror the old discrete buttons (Не очень / Нормально / Хорошо).
const MOOD_ZONES = [
  { icon: IconMoodLow, label: 'Не очень' },
  { icon: IconMoodMid, label: 'Нормально' },
  { icon: IconMoodHigh, label: 'Хорошо' },
]

const route = useRoute()
const router = useRouter()
const practicesStore = usePracticesStore()
const bookingsStore = useBookingsStore()
const diaryStore = useDiaryStore()
const toast = useToast()

const practiceId = route.params.practiceId as string
const viewerTz = useViewerTimezone()

const practice = computed(() => practicesStore.selected)
const practiceLoading = computed(() => practicesStore.selectedLoading)
const practiceLoadError = computed(() => practicesStore.selectedError)

// Slider score 1..10. Default 6 = middle "Нормально" zone, so the slider
// opens in a neutral position (the user can still submit immediately).
const moodScore = ref<number>(6)
const comment = ref('')
const submitted = ref(false)

// Tick `now` once a minute so submit auto-disables when the practice starts
// while the user is sitting on this screen. Backend rejects late check-ins
// ("Window has closed") -- we mirror the same boundary client-side to avoid
// the error screen.
const nowMs = ref<number>(Date.now())
let tickHandle: ReturnType<typeof setInterval> | null = null

const windowClosed = computed<boolean>(() => {
  const s = practice.value?.scheduled_at
  // FAIL CLOSED (№444): no practice, no submit. This used to return false --
  // "the window is open" -- on the strength of data we did not have, so a
  // deep link whose fetch failed offered a live button for a POST the backend
  // was always going to refuse. The hint is gated on `practice` in the template
  // for the same reason: while we have no data, the button is disabled because
  // we do not KNOW, and claiming "практика уже началась" would be a guess.
  if (!s) return true
  return nowMs.value > new Date(s).getTime()
})

// One check-in per booking -- OUR product decision, NOT an API constraint. The
// endpoint is an upsert and would happily accept a second one, overwriting the
// mood/comment already recorded (api/diary.ts:50-55). We block it because a
// check-in is a moment, not a document: it says how you felt before the
// practice, and letting it be rewritten later makes it worth less.
//
// So this is a UI gate over a permissive API, and the backend will NOT catch a
// bug here. Do not read it as "the server enforces one" -- an earlier version of
// this comment called it a "hard rule" and that wording alone got the screen's
// risk scored wrong (№443).
//
// The booking list already carries `has_checkin`, so we read it from there
// instead of an extra request. When true, the form is replaced by the success
// screen and submit is blocked.
const alreadyCheckedIn = computed<boolean>(() =>
  bookingsStore.bookings.some((b) => b.practice_id === practiceId && b.has_checkin),
)

// SW4: viewer's own profile timezone, matching flow siblings
// PracticeDetailView.vue and EntryView.vue -- not the practice's own.
const formattedDate = computed(() =>
  practice.value ? formatDate(practice.value.scheduled_at, viewerTz.value) : '',
)

async function onSubmit(): Promise<void> {
  if (diaryStore.checkinSubmitting || windowClosed.value || alreadyCheckedIn.value) return

  const result = await diaryStore.submitCheckin(practiceId, {
    mood: moodScore.value,
    comment: comment.value.trim() || null,
  })

  if (result.ok) {
    try {
      platform.hapticFeedback('medium')
    } catch {
      /* silent fallback */
    }
    submitted.value = true
    // Refresh bookings so `has_checkin` is up to date this session: the
    // dashboard banner, the dashboard "Check-in" button and the practice-detail
    // button all read it. Without this they keep offering a check-in until a
    // full reload (fetchMyBookings is a no-op while the list is non-empty).
    void bookingsStore.refreshBookings()
  } else {
    toast.error(closedPracticeMessage(result.code) ?? result.error)
  }
}

// P5 (ПРОМТ №594): the check-in gate (audience_service.py, via
// upsert_checkin) rejects a viewer who is blocked, or no longer in the
// practice's audience (the retroactive case -- a booking made before the
// master narrowed the audience or blocked this viewer). Maps the backend's
// machine code to the app's own Russian message; the groups case is
// composed from the practice response's own audience_group_names (already
// loaded, no second round-trip) -- never a raw backend string.
function closedPracticeMessage(code: string | undefined): string | null {
  if (code === 'blocked_by_master') {
    return 'Мастер ограничил вам доступ к этой практике'
  }
  if (code === 'not_a_student') {
    return 'Эта практика доступна только ученикам мастера'
  }
  if (code === 'not_in_audience') {
    const names = practice.value?.audience_group_names ?? []
    return names.length
      ? `Вы не состоите в группе «${names.join('», «')}»`
      : 'Вы не состоите в группе, которой открыта эта практика'
  }
  return null
}

function onSkip(): void {
  // Optimistic: hide the dashboard "Пора на check-in" banner instantly this
  // session, so navigation feels immediate.
  bookingsStore.dismissCheckin(practiceId)
  // Persist the skip (B2) so the prompt stays hidden across sessions/devices.
  // Fire-and-forget: the booking is in the store (loaded for has_checkin); if
  // it is missing or the request fails, the session dismiss above still hides
  // the banner this session.
  const booking = bookingsStore.bookings.find((b) => b.practice_id === practiceId)
  if (booking) {
    void bookingsStore.skipCheckin(booking.id)
  }
  toast.info('Check-in пропущен')
  router.push({ name: 'user-dashboard' })
}

function onBack(): void {
  // Always return to the dashboard. Using router.back() here sent the user
  // back into the practice detail card (which itself uses router.back()),
  // creating a check-in <-> detail loop.
  router.push({ name: 'user-dashboard' })
}

function goToDashboard(): void {
  router.push({ name: 'user-dashboard' })
}

// Navigate to the live practice screen (route exists, see router/index.ts).
function goToPracticeLive(): void {
  router.push({ name: 'practice-live', params: { practiceId } })
}

// If the user has already checked in for this booking, show the success
// screen straight away (hard one-time rule) instead of an editable form.
// Skip while the user is mid-success from a fresh submit this session.
watch(alreadyCheckedIn, (done) => {
  if (done) submitted.value = true
})

// Named so the error rung's «Повторить» can re-run exactly what onMounted ran.
// Unconditional: the guard below is a cache check for the mount path, but a retry
// means the last attempt FAILED, so there is nothing cached to skip for.
function loadPractice(): void {
  void practicesStore.fetchPractice(practiceId)
}

onMounted(async () => {
  if (practicesStore.selected?.id !== practiceId) {
    loadPractice()
  }
  // Ensure bookings are loaded so `has_checkin` is available. fetchMyBookings
  // is a no-op when the list is already populated (e.g. arriving from the
  // dashboard); on a direct deep-link it performs the initial load.
  await bookingsStore.fetchMyBookings()
  if (alreadyCheckedIn.value) {
    submitted.value = true
  }
  tickHandle = setInterval(() => {
    nowMs.value = Date.now()
  }, 60_000)
})

onBeforeUnmount(() => {
  if (tickHandle) clearInterval(tickHandle)
})
</script>

<style scoped>
/* Mood slider wrapper -- the slider itself carries its own styles. */
.checkin__mood {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
}

/* Success check icon in a teal circle (reused IconCheck, Figma 13) */
.checkin__success-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 93px;
  height: 93px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}
</style>
