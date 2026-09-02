<!--
  VELO Frontend -- PracticeLiveView (screen 14, Practice-Live)

  Full-screen view for a practice that is currently in progress (LIVE).
  Header has a back arrow (VHeader show-back) so the user can return to the
  previous screen without leaving the practice. "Покинуть практику" remains
  the explicit way to leave (sets left_at + back to dashboard).

  Layout (top -> bottom):
    - Video placeholder (no real video in MVP; Zoom is external)
    - Info card: title + master + "В эфире" badge
    - Actions:
        no booking for this practice -- N1 (PROMPT №587): honest inline
          "Вы не записаны" empty state instead of the badges/"Войти" button
        "Войти"            -- join (sets joined_at) + open Zoom link
        "Check-in"         -- go to the check-in form
        "Покинуть практику" -- leave (sets left_at) + back to dashboard

  Data:
    - practicesStore.fetchPractice(practiceId) -> title, master_name, status
    - bookingsStore -> the user's booking (booking.id, joined_at)
    - resolveZoomEntry(practiceId) -> HOW THIS USER ENTERS (T-35)

  Backend (Phase 5.4, ready):
    POST /bookings/{id}/join   -- confirmed + scheduled/live, 409 if already joined
    POST /bookings/{id}/leave  -- requires joined_at, 400 if not joined

  Zoom entry (T-35): this screen no longer CHOOSES a link. It asks the server
  (GET /practices/{id}/zoom/resolve) and renders the answer:

    personal  -- the user's own registrant link; attendance is recorded.
    guest     -- no live booking, so nothing to record; the shared link. url
                 may be null (the guest registrant was never minted) -- an
                 honest line, not a dead button.
    host      -- the practice's own master, arriving by his own link. url is
                 always null: he starts through the existing ticket flow.
    pending   -- a live booking exists but no usable link yet (Zoom does not
                 always return join_url on create). NEVER downgraded to a
                 guest link: joining as an unmatchable guest with a confirmed
                 booking is exactly what produces a false NO_SHOW.
    failed    -- meeting creation permanently failed.
    cancelled -- the practice is cancelled.

  This screen is also the DEEP LINK target (startapp=zoom__<22>). A code of
  valid shape can name a practice that no longer exists; the client cannot
  know that locally, so the resolve call 404s and this screen shows an honest
  error instead of an empty state.

  Route: /user/practice-live/:practiceId
-->

<template>
  <div class="live">
    <!-- Back -> dashboard (router.back() looped check-in <-> live). Uses the
         shared DS back button (arrow-only pill, same as the diary). -->
    <VBackButton class="live__back" @click="goBack" />

    <!-- Themed direction placeholder in place of a real video stream
         (no real video in MVP; Zoom is external). -->
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
        title="Практика не найдена"
        description="Возможно, её удалили или ссылка скопирована не полностью"
      />

      <!-- T-35: the master arriving by his OWN public link. url is null by
           design here -- he starts as host through the ticket flow, which
           lives on his own screens; sending him in as a guest would leave his
           meeting waiting for a host who is standing inside it. -->
      <VEmptyState
        v-else-if="zoomEntry?.kind === 'host'"
        icon="calendar"
        title="Это ваша практика"
        description="Начните встречу с экрана мастера — там кнопка «Начать»"
      />

      <VEmptyState
        v-else-if="zoomEntry?.kind === 'cancelled'"
        icon="warning"
        title="Практика отменена"
        description="Вход в неё больше не откроется"
      />

      <template v-else>
        <!-- T-35: no live booking -> the guest link. Attendance writes nothing
             for this person either way, so nothing is lost by it -- and
             anyone who DOES hold a live booking gets 'pending' instead, never
             this. -->
        <VBadge v-if="zoomEntry?.kind === 'guest'" variant="warning" class="live__zoom-note">
          Вы не записаны — вход гостем, посещение не засчитается
        </VBadge>

        <!-- A4 V2 (PROMPT №572): honest permanent-failure state, distinct from
             "still preparing" -- before this, create_failed rendered the
             identical "Ссылка готовится" spinner forever. A participant has
             no retry action (only the master does, MasterDashboardView) --
             this just tells the truth instead of hiding it. -->
        <VBadge v-if="zoomEntry?.kind === 'failed'" variant="error" class="live__zoom-note">
          Не удалось создать встречу — обратитесь к мастеру
        </VBadge>

        <!-- T-35: 'guest' with no url is the minting miss
             (ensure_shared_registrant is best-effort). NOT 'failed': the
             meeting exists, only the guest seat in it does not. -->
        <VBadge
          v-if="zoomEntry?.kind === 'guest' && !zoomEntry?.url"
          variant="error"
          class="live__zoom-note"
        >
          Гостевой вход сейчас недоступен
        </VBadge>

        <VButton
          variant="primary"
          size="lg"
          block
          :disabled="!canJoin || joining"
          :loading="joining"
          @click="onEnter"
        >
          <template v-if="zoomEntry?.kind === 'failed'">Ссылка недоступна</template>
          <template v-else-if="zoomEntry?.kind === 'pending'">Ссылка готовится</template>
          <template v-else>Войти</template>
        </VButton>
      </template>

      <!-- One check-in per practice: once done, the button locks and shows
           why (so it does not read as a random disabled control). -->
      <VButton variant="secondary" size="lg" block :disabled="alreadyCheckedIn" @click="onCheckin">
        <template v-if="alreadyCheckedIn">Check-in сделан</template>
        <template v-else>Check-in</template>
      </VButton>

      <VButton variant="danger" size="lg" block :loading="leaving" @click="onLeave">
        Покинуть практику
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useBookingsStore } from '@/stores/bookings'
import { useToast } from '@/composables/useToast'
import { platform } from '@/platform'
import { VButton, VBackButton, VCard, VBadge, VEmptyState } from '@/components/ui'
import PracticePlaceholder from '@/components/shared/PracticePlaceholder.vue'
import { resolveZoomEntry } from '@/api/practices'
import type { ZoomEntryResolveResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const practicesStore = usePracticesStore()
const bookingsStore = useBookingsStore()
const toast = useToast()

const practiceId = route.params.practiceId as string

const joining = ref(false)
const leaving = ref(false)

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
 * draft/deleted -- reachable from a stale deep link).
 *
 * The choice is deliberately NOT made here. It used to be: resolveZoomLink()
 * picked between a personal link and a manual one, which made correctness a
 * rule this file had to keep. utils/zoomLink.ts still exists for list views
 * that already hold the personal link in their payload, but it no longer
 * chooses between two links -- there is only one.
 */
const zoomEntry = ref<ZoomEntryResolveResponse | null>(null)
const resolveFailed = ref(false)

/** "Войти" is enabled only when the server handed us a URL to open. That is
 * true for 'personal' and for 'guest' with a minted link, and false for
 * 'pending' / 'failed' / 'host' / a guest whose link was never minted -- so
 * the button cannot open something that does not exist. */
const canJoin = computed(() => !!zoomEntry.value?.url)

// -- Actions --

/**
 * "Войти": check in (if not joined yet) and open the Zoom link.
 * A 409 "Already joined" is treated as a no-op -- we still open Zoom.
 */
async function onEnter(): Promise<void> {
  if (!zoomEntry.value?.url) return
  if (joining.value) return

  // Capture the link now: the guard above narrows it to a string, but the await
  // below resets that narrowing (zoomEntry is a ref).
  const zoomUrl = zoomEntry.value.url
  joining.value = true
  try {
    const booking = myBooking.value
    // Only call join if we have a booking that has not joined yet.
    if (booking && booking.joined_at === null) {
      const result = await bookingsStore.joinBooking(booking.id)
      // Ignore "already joined" -- opening Zoom is still the right action.
      if (!result.ok && !result.error.toLowerCase().includes('already')) {
        toast.error(result.error)
      }
    }
    try {
      platform.hapticFeedback('medium')
    } catch {
      /* silent fallback */
    }
    // Open the Zoom link via the platform abstraction (Telegram-SDK openLink vs
    // window.open). zoomUrl was captured above while narrowed to a valid https URL.
    platform.openLink(zoomUrl)
  } finally {
    joining.value = false
  }
}

function onCheckin(): void {
  if (alreadyCheckedIn.value) return
  router.push({ name: 'user-checkin', params: { practiceId } })
}

/** Back arrow -> dashboard (breaks the check-in <-> live loop). */
function goBack(): void {
  router.push({ name: 'user-dashboard' })
}

/**
 * "Покинуть практику": always returns to the dashboard. We only call the
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
    router.push({ name: 'user-dashboard' })
  }
}

onMounted(async () => {
  if (practicesStore.selected?.id !== practiceId) {
    practicesStore.fetchPractice(practiceId)
  }
  // Needed to resolve the user's booking id for join/leave.
  bookingsStore.fetchMyBookings()
  // T-35: how THIS user enters. Failure here is not a toast -- this screen's
  // whole purpose is entering the practice, so it becomes the screen's state.
  try {
    zoomEntry.value = await resolveZoomEntry(practiceId)
  } catch {
    resolveFailed.value = true
  }
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

/* "В эфире" badge */
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
</style>
