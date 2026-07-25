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
        no booking for this practice -- N1 (ПРОМТ №587): honest inline
          "Вы не записаны" empty state instead of the badges/"Войти" button
        "Войти"            -- join (sets joined_at) + open Zoom link
        "Check-in"         -- go to the check-in form
        "Покинуть практику" -- leave (sets left_at) + back to dashboard

  Data:
    - practicesStore.fetchPractice(practiceId) -> zoom_link (fallback), title, master_name, status
    - bookingsStore -> the user's booking (booking.id, joined_at, zoom_registrant_join_url)

  Backend (Phase 5.4, ready):
    POST /bookings/{id}/join   -- confirmed + scheduled/live, 409 if already joined
    POST /bookings/{id}/leave  -- requires joined_at, 400 if not joined

  Zoom link (T21-1, ПРОМТ №541): resolveZoomLink() ladder -- the booking's
  own registrant link first, else the manual practice.zoom_link visibly
  marked (attendance not counted), else "Ссылка готовится". Security
  (AUDIT-0520-02, now inside resolveZoomLink): only an https:// URL is ever
  opened, on either rung.

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
      <!-- N1 (ПРОМТ №587, recon №586): no booking for THIS practice at all --
           canJoin (below) already permanently disables "Войти" in this case
           (not a security hole: the backend also fail-closes the zoom_link),
           but a disabled button with no explanation was a UX dead end. An
           honest inline state instead -- no auto-redirect, no surprise
           navigation. -->
      <VEmptyState
        v-if="!myBooking"
        icon="warning"
        title="Вы не записаны на это занятие"
        description="Чтобы войти, сначала забронируйте практику"
      />
      <template v-else>
        <!-- D3 ladder (ПРОМТ №541): the manual-link state must be visibly
             distinct from a real personal link -- silent fall-through is the
             defect being fixed, so this badge is never optional decoration. -->
        <VBadge v-if="zoomLink.kind === 'manual'" variant="warning" class="live__zoom-note">
          Ссылка от мастера — посещение не засчитается автоматически
        </VBadge>

        <!-- A4 V2 (ПРОМТ №572): honest permanent-failure state, distinct from
             "still preparing" -- before this, create_failed rendered the
             identical "Ссылка готовится" spinner forever. A participant has
             no retry action (only the master does, MasterDashboardView) --
             this just tells the truth instead of hiding it. -->
        <VBadge v-if="zoomLink.kind === 'failed'" variant="error" class="live__zoom-note">
          Не удалось создать встречу — обратитесь к мастеру
        </VBadge>

        <VButton
          variant="primary"
          size="lg"
          block
          :disabled="!canJoin || joining"
          :loading="joining"
          @click="onEnter"
        >
          <template v-if="zoomLink.kind === 'failed'">Ссылка недоступна</template>
          <template v-else-if="zoomLink.kind === 'pending'">Ссылка готовится</template>
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
import { resolveZoomLink } from '@/utils/zoomLink'

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
 * D3 ladder (ПРОМТ №541): the booking's own registrant link first, the
 * manual practice.zoom_link only as a visibly-marked fallback, otherwise
 * "being prepared" -- or, since A4 V2 (ПРОМТ №572), the honest "failed"
 * state when practice.zoom_meeting_status is create_failed. Never a silent
 * fall-through (AUDIT-0520-02's https guard is now inside resolveZoomLink
 * for both rungs).
 */
const zoomLink = computed(() =>
  resolveZoomLink(
    myBooking.value?.zoom_registrant_join_url,
    practice.value?.zoom_link,
    practice.value?.zoom_meeting_status,
  ),
)

/** "Войти" is enabled only with a booking and a usable link (neither
 * pending nor permanently failed). */
const canJoin = computed(
  () => !!myBooking.value && zoomLink.value.kind !== 'pending' && zoomLink.value.kind !== 'failed',
)

// -- Actions --

/**
 * "Войти": check in (if not joined yet) and open the Zoom link.
 * A 409 "Already joined" is treated as a no-op -- we still open Zoom.
 */
async function onEnter(): Promise<void> {
  if (zoomLink.value.kind === 'pending' || !zoomLink.value.url) return
  if (joining.value) return

  // Capture the link now: the guard above narrows it to a string, but the await
  // below resets that narrowing (zoomLink is a computed ref).
  const zoomUrl = zoomLink.value.url
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

onMounted(() => {
  if (practicesStore.selected?.id !== practiceId) {
    practicesStore.fetchPractice(practiceId)
  }
  // Needed to resolve the user's booking id for join/leave.
  bookingsStore.fetchMyBookings()
})
</script>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* Horizontal rail comes from MobileLayout (--velo-rail-pad-x); only vertical
     padding here so content sits on the single 24px rail (no double inset). */
  padding: var(--space-5) 0;
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
