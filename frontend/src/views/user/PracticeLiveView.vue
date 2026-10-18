<!--
  VELO Frontend -- PracticeLiveView (screen 14, Practice-Live)

  The practice screen: where a person ENTERS the practice. Since Standalone
  F4 Zoom runs inside VELO -- the Meeting SDK (client view) -- and no Zoom
  link is ever opened. ONE view, two zones (the CuratorGroupPageView
  pattern): the user zone mounts it as 'practice-live', the master zone as
  'master-practice-live'. The zone only picks the back target and hides the
  student-only actions; WHAT the person may do is the server's answer.

  Layout (top -> bottom):
    - Video placeholder (the meeting itself takes over the whole page once
      entered -- client view draws its own full-page UI)
    - Info card: title + master + «В эфире» badge
    - Actions, by the server's answer (GET /practices/{id}/zoom/resolve):
        personal  -- «Войти»: join (sets joined_at), then the SDK as attendee
        host      -- «Начать»: the SDK as host (the practice's own master)
        guest     -- not booked: «Вы не записаны» and the way to the practice
                     (owner decision 12: no guest entry from the app)
        pending / failed / unavailable / cancelled -- honest states
      + «Check-in», «Покинуть практику» -- student actions, user zone only
      + the camera hint where the host app blocks the camera (Telegram iOS)

  Entering (onEnter / onStart): POST .../zoom/sdk-join for the parameters,
  then platform/zoom-sdk.ts loads the SDK and joins. Leaving is the SDK's
  own leaveUrl -- a full page load: the student lands on the feedback
  screen, the master on his dashboard. «Назад» while in the meeting leaves it
  the same way.

  This screen is also the DEEP LINK target (startapp=zoom__<22>). A code of
  valid shape can name a practice that no longer exists; the client cannot
  know that locally, so the resolve call 404s and this screen shows an honest
  error instead of an empty state.

  Routes: /user/practice-live/:practiceId, /master/practice-live/:practiceId
-->

<template>
  <div class="live">
    <!-- Back -> the zone's dashboard (router.back() looped check-in <-> live).
         Uses the shared DS back button (arrow-only pill, same as the diary). -->
    <VBackButton class="live__back" @click="goBack" />

    <!-- Themed direction placeholder until the meeting takes over the page. -->
    <PracticePlaceholder
      class="live__video"
      :direction="practice?.direction"
      :title="practice?.title"
    />

    <!-- Info card -->
    <VCard class="live__info">
      <h2 class="live__title">{{ practice?.title ?? 'Практика' }}</h2>
      <p class="live__master">с {{ practice?.master_name ?? 'Мастером' }}</p>
      <span class="live__badge">
        <span class="live__badge-dot" />
        В эфире
      </span>
    </VCard>

    <!-- Actions -->
    <div class="live__actions">
      <!-- T-35: a well-formed deep link can name a practice that no longer
           exists -- the client cannot tell locally (it has no database), so
           the resolve call 404s and lands here. An honest error, never an
           empty screen. -->
      <VEmptyState
        v-if="resolveFailed"
        icon="warning"
        :title="t('user.screens.practiceLive.notFound.title')"
        :description="t('user.screens.practiceLive.notFound.text')"
      />

      <!-- F4: the server has no Meeting SDK keys (or runs the Zoom stub).
           Said out loud instead of a button that cannot work. -->
      <VEmptyState
        v-else-if="sdkNotConfigured"
        icon="warning"
        :title="t('user.screens.practiceLive.zoomNotConfigured')"
        :description="t('user.screens.practiceLive.zoomServerBroken')"
      />

      <VEmptyState
        v-else-if="zoomEntry?.kind === 'cancelled'"
        icon="warning"
        :title="t('user.screens.practiceLive.cancelled.title')"
        :description="t('user.screens.practiceLive.cancelled.text')"
      />

      <!-- Links (3 October): 'unavailable' -- the meeting exists and this
           person holds a live booking, but their personal entry could not be
           made (resolve_zoom_entry: nothing retries it, so «ask the master to
           retry» would be a lie). No way in -- say so, no «Войти». -->
      <VEmptyState
        v-else-if="zoomEntry?.kind === 'unavailable'"
        icon="warning"
        :title="t('user.screens.practiceLive.entryUnavailable')"
        :description="t('user.screens.practiceLive.registrationFailed')"
      />

      <!-- F4, owner decision 12: no guest entry from inside the app. A person
           without a live booking is told so and sent to the practice, where
           booking is. -->
      <VEmptyState
        v-else-if="zoomEntry?.kind === 'guest'"
        icon="calendar"
        :title="t('user.screens.practiceLive.notBooked')"
        :description="t('user.screens.practiceLive.notBookedHint')"
      >
        <VButton size="sm" @click="goToPractice">{{
          t('user.screens.practiceLive.toPractice')
        }}</VButton>
      </VEmptyState>

      <!-- The practice's own master: he starts the meeting as host, inside
           VELO. Reached from his dashboard (master zone) or by his own
           published link (user zone) -- either way the same «Начать». -->
      <template v-else-if="zoomEntry?.kind === 'host'">
        <p v-if="cameraHint" class="live__camera-hint">{{ CAMERA_HINT }}</p>
        <VButton
          variant="primary"
          size="lg"
          block
          :disabled="entering"
          :loading="entering"
          @click="onStart"
        >
          Начать
        </VButton>
      </template>

      <template v-else>
        <!-- A4 V2 (PROMPT №572): honest permanent-failure state, distinct from
             "still preparing". A participant has no retry action (only the
             master does, MasterDashboardView) -- this just tells the truth. -->
        <VBadge v-if="zoomEntry?.kind === 'failed'" variant="error" class="live__zoom-note">
          Не удалось создать встречу — обратитесь к мастеру
        </VBadge>

        <p v-if="cameraHint" class="live__camera-hint">{{ CAMERA_HINT }}</p>

        <VButton
          variant="primary"
          size="lg"
          block
          :disabled="!canJoin || entering"
          :loading="entering"
          @click="onEnter"
        >
          <template v-if="zoomEntry?.kind === 'failed'">{{
            t('user.screens.practiceLive.entryPreparing')
          }}</template>
          <template v-else-if="zoomEntry?.kind === 'pending'">{{
            t('user.screens.practiceLive.entryPreparing2')
          }}</template>
          <template v-else>{{ t('user.screens.practiceLive.join') }}</template>
        </VButton>
      </template>

      <!-- Student actions -- the user zone only, and not for the practice's
           own master (he checks no one in to his own practice). -->
      <template v-if="studentActions">
        <!-- One check-in per practice: once done, the button locks and shows
             why (so it does not read as a random disabled control). -->
        <VButton
          variant="secondary"
          size="lg"
          block
          :disabled="alreadyCheckedIn"
          @click="onCheckin"
        >
          <template v-if="alreadyCheckedIn">{{
            t('user.screens.practiceLive.checkinDone')
          }}</template>
          <template v-else>Check-in</template>
        </VButton>

        <VButton variant="danger" size="lg" block :loading="leaving" @click="onLeave">
          Покинуть практику
        </VButton>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed, onMounted, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useBookingsStore } from '@/stores/bookings'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { platform } from '@/platform'
import {
  appUrl,
  enterZoomMeeting,
  leaveZoomMeeting,
  setZoomInsetTop,
  zoomSdkLoaded,
} from '@/platform/zoom-sdk'
import { useSafeArea } from '@/composables/useSafeArea'
import { VButton, VBackButton, VCard, VBadge, VEmptyState } from '@/components/ui'
import PracticePlaceholder from '@/components/shared/PracticePlaceholder.vue'
import { joinZoomSdk, resolveZoomEntry } from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import type { ZoomEntryResolveResponse } from '@/api/types'

/** Owner decision 11, verbatim. */
const CAMERA_HINT = t('user.screens.practiceLive.desktopCameraHint')

const route = useRoute()
const router = useRouter()
const practicesStore = usePracticesStore()
const bookingsStore = useBookingsStore()
const toast = useToast()

const practiceId = route.params.practiceId as string
/** The master zone mounts this same view (router: 'master-practice-live'). */
const isMasterZone = route.name === 'master-practice-live'

const entering = ref(false)
const leaving = ref(false)

/** F4 fix: the top safe area the meeting's root keeps clear -- the SAME
 * source as every screen of ours (Telegram fullscreen controls, or
 * env(safe-area-inset-top) in the installed app). */
const { contentSafeTopCss } = useSafeArea()
/** True from the moment the SDK is handed the page until a failure takes
 * it back -- while true, a changed inset follows into the meeting. */
let inMeeting = false
watch(contentSafeTopCss, (value) => {
  if (inMeeting) setZoomInsetTop(value)
})

const practice = computed(() => practicesStore.selected)

/** The current user's booking for this practice (any active-ish status). */
const myBooking = computed(() =>
  bookingsStore.bookings.find((b) => b.practice_id === practiceId && b.status !== 'cancelled'),
)

/** One check-in per practice: once the booking has it, the button locks. */
const alreadyCheckedIn = computed(() => !!myBooking.value?.has_checkin)

/**
 * T-35: the server's answer for THIS user on THIS practice. null until the
 * resolve call returns; resolveFailed when it 404s (no such practice, or
 * draft/deleted -- reachable from a stale deep link). The choice is
 * deliberately NOT made here.
 */
const zoomEntry = ref<ZoomEntryResolveResponse | null>(null)
const resolveFailed = ref(false)
/** F4: sdk-join answered zoom_sdk_not_configured -- no SDK keys here. */
const sdkNotConfigured = ref(false)

/** «Войти» is enabled only for 'personal' -- the one answer that carries an
 * entry for this person. */
const canJoin = computed(() => zoomEntry.value?.kind === 'personal')

/** Check-in and «Покинуть» belong to a student in the user zone; never to
 * the practice's own master. */
const studentActions = computed(
  () => !isMasterZone && !resolveFailed.value && zoomEntry.value?.kind !== 'host',
)

/** The camera hint: where an entry button is on screen and the host app is
 * known to black out the camera (platform.cameraBlockedByHost). */
const cameraHint = computed(() => {
  const kind = zoomEntry.value?.kind
  const entryOnScreen = kind === 'personal' || kind === 'pending' || kind === 'host'
  return entryOnScreen && !sdkNotConfigured.value && platform.cameraBlockedByHost()
})

// -- Actions --

/**
 * Ask the server for this person's SDK parameters and enter. Resolves once
 * the SDK has joined (it then owns the page until leaveUrl reloads it).
 * Every refusal is shown, none is swallowed:
 *   zoom_sdk_not_configured -> the screen says so instead of the button;
 *   zoom_entry_not_joinable -> the state changed under us: re-resolve;
 *   anything else          -> its phrase, or a plain «try again».
 */
async function enterThroughSdk(): Promise<void> {
  let params
  try {
    params = await joinZoomSdk(practiceId)
  } catch (e) {
    if (e instanceof ApiResponseError && e.code === 'zoom_sdk_not_configured') {
      sdkNotConfigured.value = true
      return
    }
    if (e instanceof ApiResponseError && e.code === 'zoom_entry_not_joinable') {
      toast.info(t('user.screens.practiceLive.toast.stateChanged'))
      await loadEntry()
      return
    }
    toast.error(extractApiError(e, t('user.screens.practiceLive.toast.zoomOpenFailed')))
    return
  }
  // The student leaves to his feedback screen; the master to his dashboard
  // (he has no feedback screen of his own).
  const leaveTo =
    params.role === 1
      ? router.resolve({ name: 'master-dashboard' })
      : router.resolve({ name: 'user-feedback', params: { practiceId } })
  inMeeting = true
  try {
    await enterZoomMeeting(params, appUrl(leaveTo.href), {
      insetTop: contentSafeTopCss.value,
    })
  } catch {
    // enterZoomMeeting has already taken its style off again.
    inMeeting = false
    toast.error(t('user.screens.practiceLive.toast.zoomOpenFailed'))
  }
}

/**
 * «Войти» (personal): check in to the booking if not joined yet -- joined_at
 * is set here, by the button, exactly as before F4 -- then enter. A 409
 * "Already joined" is not an error: entering is still the right action.
 */
async function onEnter(): Promise<void> {
  if (!canJoin.value || entering.value) return
  entering.value = true
  try {
    const booking = myBooking.value
    if (booking && booking.joined_at === null) {
      const result = await bookingsStore.joinBooking(booking.id)
      // FE-78.2: the gate keys on the machine status (the join endpoint's
      // only 409 is "already joined"), never on the human-readable text.
      if (!result.ok && result.status !== 409) {
        toast.error(result.error)
      }
    }
    try {
      platform.hapticFeedback('medium')
    } catch {
      /* silent fallback */
    }
    await enterThroughSdk()
  } finally {
    entering.value = false
  }
}

/** «Начать» (host): the practice's own master starts the meeting in VELO. */
async function onStart(): Promise<void> {
  if (zoomEntry.value?.kind !== 'host' || entering.value) return
  entering.value = true
  try {
    try {
      platform.hapticFeedback('medium')
    } catch {
      /* silent fallback */
    }
    await enterThroughSdk()
  } finally {
    entering.value = false
  }
}

function onCheckin(): void {
  if (alreadyCheckedIn.value) return
  void router.push({ name: 'user-checkin', params: { practiceId } })
}

/** Not booked: the practice screen, where booking is. */
function goToPractice(): void {
  void router.push({ name: 'practice-detail', params: { id: practiceId } })
}

/** Back arrow -> the zone's dashboard (breaks the check-in <-> live loop). */
function goBack(): void {
  void router.push({ name: isMasterZone ? 'master-dashboard' : 'user-dashboard' })
}

/**
 * t('user.screens.practiceLive.leave'): always returns to the dashboard. We only call the
 * leave API if the user had actually joined (otherwise the backend returns
 * 400 "Cannot leave without joining first").
 */
async function onLeave(): Promise<void> {
  if (leaving.value) return

  leaving.value = true
  try {
    const booking = myBooking.value
    if (booking && booking.joined_at !== null && booking.left_at === null) {
      const result = await bookingsStore.leaveBooking(booking.id)
      if (!result.ok) toast.error(result.error)
    }
  } finally {
    leaving.value = false
    void router.push({ name: 'user-dashboard' })
  }
}

/** T-35: how THIS user enters. Failure here is not a toast -- this screen's
 * whole purpose is entering the practice, so it becomes the screen's state. */
async function loadEntry(): Promise<void> {
  try {
    zoomEntry.value = await resolveZoomEntry(practiceId)
    resolveFailed.value = false
  } catch {
    resolveFailed.value = true
  }
}

// Inside the meeting the SDK owns the page; any in-app navigation away
// (the arrow, the system back gesture) leaves the meeting instead, and the
// SDK's leaveUrl then reloads the app where it belongs.
onBeforeRouteLeave(() => {
  if (zoomSdkLoaded()) {
    leaveZoomMeeting()
    return false
  }
  return true
})

onMounted(async () => {
  if (practicesStore.selected?.id !== practiceId) {
    void practicesStore.fetchPractice(practiceId)
  }
  // Needed to resolve the user's booking id for join/leave.
  void bookingsStore.fetchMyBookings()
  await loadEntry()
})
</script>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* Horizontal rail comes from MobileLayout (--velo-rail-pad-x); only vertical
     padding here so content sits on the single 24px rail (no double inset).
     NO top padding: this route is headerless (FE-48), so MobileLayout already
     clears the top by --velo-fog-headerless-top -- the ONE shared default
     every headerless screen sits on. Our own padding here is how the back
     button ended up 61px down (34 shared + 27 local); the shared token is
     the single knob for the top clearance across all screens. */
  padding: 0 0 var(--space-5);
  min-height: 100%;
}

/* Back button: arrow-only DS pill, top-left (not stretched by the flex column). */
.live__back {
  align-self: flex-start;
}

/* Direction placeholder: PracticePlaceholder already carries the
   336x199 aspect, glass-blue background, white border and glow shadow.
   Layout-only overrides here. */
.live__video {
  align-self: center;
}

/* Info card */
.live__info {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.live__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.live__master {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* t('user.screens.practiceLive.liveBadge') badge */
.live__badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-xl);
  background: var(--velo-glass-teal-30);
  border: 1px solid var(--velo-teal-400);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-teal-700);
}

.live__badge-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--velo-teal-400);
}

/* Actions */
.live__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: auto;
}

.live__zoom-note {
  align-self: center;
  text-align: center;
}

/* F4: the camera hint (owner decision 11) -- plain secondary text above the
   entry button, not a warning badge: nothing is broken, the camera just
   lives in the home-screen app. */
.live__camera-hint {
  margin: 0;
  text-align: center;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}
</style>
