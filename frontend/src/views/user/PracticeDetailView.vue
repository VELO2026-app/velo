<!--
  VELO Frontend -- PracticeDetailView (Phase F3.2, updated F4.1, F5, F9.1, DS-sprint)

  Full practice detail screen. Matches design Dashboard 2 / booked-practice layout:
    - Hero: white card with IconMeditation SVG + title + meta + "Оплачено" badge
    - Accordions: "О практике" (description), "Что подготовить" (what_to_prepare)
    - Master card: avatar + name + check + methods tags (VTag) + arrow
    - Contraindications banner (if practice.contraindications)
    - Sticky footer: price + action button + cancel booking

  F4.1: BookingPopup (purchase flow with promo).
  F5 review fix:
    W-21: booked state derived from bookingsStore instead of local ref.
  F9.1: Sticky footer action is now context-aware:
    - Not booked + available  -> "Забронировать" / "Записаться бесплатно"
    - Booked + in check-in window  -> "Check-in перед практикой"
    - Booked + in feedback window  -> "Оставить feedback"
    - Booked + outside any window  -> "Вы записаны" (disabled)
    - Booked (cancellable)         -> "Отменить бронирование"
  DS-sprint: accordions, master methods tags, contraindications banner.

  Route: /user/practices/:id
  Param: id (practice UUID)
-->

<template>
  <!-- Loading -->
  <div v-if="store.selectedLoading" class="detail__loader">
    <VLoader size="lg" />
  </div>

  <!-- Error -->
  <VEmptyState
    v-else-if="store.selectedError"
    icon="warning"
    title="Практика не найдена"
    :description="store.selectedError"
  >
    <VButton size="sm" @click="router.back()">Назад</VButton>
  </VEmptyState>

  <!-- Content -->
  <div v-else-if="practice" class="detail">
    <!-- Back button header (contextual: catalog vs booked) -->
    <VHeader :title="hasAnyBooking ? 'Моя практика' : 'Практика'" show-back @back="router.back()" />

    <!-- Single unified scroll: the whole screen scrolls in MobileLayout's
         __main (no nested scroll/pinned footer). Hero + body + actions flow. -->
    <!-- Hero card (shared component) -->
    <div class="detail__hero">
      <PracticeHeroCard
        :title="practice.title"
        :date="formattedDate"
        :duration="formattedDuration"
        :participants="!booked ? formattedParticipants : null"
        :direction="practice.direction"
        :difficulty-dots="difficultyDots"
        :difficulty-label="difficultyLabel"
      />
    </div>

    <!-- Body -->
    <div class="detail__body">
      <!-- Status row (Batch 6: ported from BookingDetailView). Shown when
             the viewer holds a booking for this practice in any status. -->
      <VCard v-if="myAnyBooking" class="detail__status-row" padding="none">
        <span class="detail__status-label">Статус</span>
        <VBadge :variant="statusVariant">
          <component :is="statusIcon" v-if="statusIcon" :size="12" />
          {{ statusLabel }}
        </VBadge>
      </VCard>

      <!-- О практике accordion -->
      <VAccordion v-if="practice.description" title="О практике">
        <p class="detail__accordion-text">{{ practice.description }}</p>
      </VAccordion>

      <!-- Что подготовить accordion -->
      <VAccordion v-if="practice.what_to_prepare" title="Что подготовить">
        <p class="detail__accordion-text">{{ practice.what_to_prepare }}</p>
      </VAccordion>

      <!-- Master card (shared component) -->
      <section class="detail__section">
        <h3 class="detail__section-title">Мастер</h3>
        <MasterCard
          :master-name="practice.master_name"
          :methods="practice.master_methods"
          :avatar-url="practice.master_avatar_url"
          :master-id="practice.master_id"
        />
      </section>

      <!-- Zoom (Batch 6: ported from BookingDetailView). Only while the
             booking is active -- a past/cancelled booking has no live link.
             F2 (№263): honest copy — the link is revealed by booking status
             (confirmed), not by a 10-minute timer; it lives on the dashboard
             card and the live screen. -->
      <section v-if="showZoom" class="detail__section">
        <h3 class="detail__section-title">ZOOM</h3>
        <VCard class="detail__zoom-card">
          Ссылка на Zoom доступна после записи — на главном экране и в практике
        </VCard>
      </section>

      <!-- Contraindications (shared Banner) -->
      <Banner
        v-if="practice.contraindications"
        variant="warning"
        title="ПРОТИВОПОКАЗАНИЯ"
        :body="practice.contraindications"
        class="detail__contraindications"
      >
        <template #icon><IconWarning :size="22" /></template>
      </Banner>
    </div>

    <!-- Footer: price + action (flows at the end of the unified scroll) -->
    <div class="detail__actions">
      <!-- Price row: only for the catalog (not-booked) view. In the booked
           "Моя практика" view (Figma 15) the practice is already paid for,
           so the price row is hidden. -->
      <VCard v-if="!booked" class="detail__price-row" padding="none">
        <span class="detail__price-label">Стоимость</span>
        <span
          class="detail__price-value"
          :class="{ 'detail__price-value--free': practice.is_free }"
        >
          {{ formattedPrice }}
        </span>
      </VCard>

      <!-- F9.1: Check-in button (confirmed booking in check-in window) -->
      <VButton
        v-if="booked && inCheckinWindow"
        variant="primary"
        size="lg"
        block
        @click="onCheckin"
      >
        Check-in перед практикой
      </VButton>

      <!-- F9.1: Feedback button (attended booking in feedback window) -->
      <VButton
        v-else-if="booked && inFeedbackWindow"
        variant="primary"
        size="lg"
        block
        @click="onFeedback"
      >
        Оставить feedback
      </VButton>

      <!-- Booked but no active window: NO CTA here. The "записан" state is
           shown in the status row ("Вы записаны"); the old disabled button was
           dead weight and ate vertical space (operator, 2026-06-04). -->

      <!-- Not booked: book button. Hidden for the practice owner, for a
           finished booking (attended/no_show — no re-booking), and once the
           practice has started (practiceStarted) — a started practice can no
           longer be booked (backend enforces the same). A cancelled booking
           on a not-yet-started practice still may re-book. When hidden for a
           started practice we simply show no CTA. -->
      <VButton
        v-else-if="!booked && !isMaster && !isPastBooking && !practiceStarted"
        variant="primary"
        size="lg"
        block
        :disabled="full"
        @click="onBook"
      >
        {{ bookButtonText }}
      </VButton>
      <!-- Cancel booking button (visible when booked and cancellable).
           Per Figma booked-practice.svg — solid pink (#F795A2 = velo-pink-300),
           that's `variant="danger"` (already exists in VButton). -->
      <VButton
        v-if="booked && canCancel"
        variant="danger"
        size="lg"
        block
        :loading="cancelling"
        @click="onCancelBooking"
      >
        Отменить бронирование
      </VButton>
    </div>

    <!-- Booking popup -->
    <BookingPopup
      :practice="practice"
      :open="showBookingPopup"
      @close="showBookingPopup = false"
      @purchased="onPurchased"
      @sold-out="onSoldOut"
    />

    <!-- Полноэкранный стейт «Места закончились» (гонка: места кончились,
         пока юзер читал/бронировал). Поверх кадра, как .form-shell-success. -->
    <PracticeSoldOut v-if="soldOut" @find-other="onFindOther" @close="soldOut = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePracticesStore } from '@/stores/practices'
import { useBookingsStore } from '@/stores/bookings'
import { VLoader, VEmptyState, VButton, VBadge, VAccordion, VCard } from '@/components/ui'
import { VHeader } from '@/components/layout'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import BookingPopup from '@/components/shared/BookingPopup.vue'
import PracticeSoldOut from '@/components/shared/PracticeSoldOut.vue'
import PracticeHeroCard from '@/components/shared/PracticeHeroCard.vue'
import MasterCard from '@/components/shared/MasterCard.vue'
import Banner from '@/components/shared/Banner.vue'
import { formatDate, formatDuration, formatMoney, formatParticipants, isFull } from '@/utils/format'
import { IconCheck, IconClose, IconWarning } from '@/components/icons'
import { DIFFICULTY_DOTS, DIFFICULTY_LABEL } from '@/utils/displayHelpers'
import { hasEnded } from '@/utils/bookingStatus'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import type { BookingStatus, BookingWithPracticeResponse, PracticeDifficulty } from '@/api/types'

const route = useRoute()
const router = useRouter()
const store = usePracticesStore()
const bookingsStore = useBookingsStore()

const practice = computed(() => store.selected)

// -- Difficulty indicator (Calendar iteration) --
// Filled-dot count (0 hides the block) + human label, from data.taxonomy.
const difficultyDots = computed<number>(() => {
  const d = practice.value?.difficulty
  return d ? DIFFICULTY_DOTS[d as PracticeDifficulty] : 0
})
const difficultyLabel = computed<string>(() => {
  const d = practice.value?.difficulty
  return d ? DIFFICULTY_LABEL[d as PracticeDifficulty] : ''
})

// -- Booking state --
const showBookingPopup = ref(false)
// Полноэкранный стейт «Места закончились» (гонка practice_full при бронировании).
const soldOut = ref(false)
const authStore = useAuthStore()
const toast = useToast()

// Prevent master from booking their own practice (backend also enforces this,
// but we hide the button entirely to avoid a pointless UX dead-end).
const isMaster = computed(() => !!practice.value && practice.value.master_id === authStore.user?.id)

// W-21: Derive booked state from bookingsStore (survives navigation).
// Falls back to local flag for immediate feedback after purchase.
const justPurchased = ref(false)

const booked = computed(() => {
  if (justPurchased.value) return true
  if (!practice.value) return false
  return bookingsStore.bookings.some(
    (b) =>
      b.practice_id === practice.value!.id &&
      (b.status === 'confirmed' || b.status === 'pending' || b.status === 'attended'),
  )
})

// =========================================================================
// F9.1: Time window helpers
// =========================================================================

// NEW-1: imported from utils/constants -- single source of truth.
import { isInCheckinWindow, isInFeedbackWindow } from '@/composables/usePracticeWindows'

// Reactive clock -- updated every 60s so window computeds re-evaluate
// without requiring a page reload (C-1 fix).
const now = ref(Date.now())

/**
 * Returns the booking matching this practice (any active-ish status).
 * Used to read status for window checks.
 */
const myBooking = computed(() => {
  if (!practice.value) return null
  return bookingsStore.bookings.find((b) => b.practice_id === practice.value!.id) ?? null
})

// =========================================================================
// Batch 6: merged "Бронирование" screen. The dedicated BookingDetailView is
// gone; its unique pieces (a status row + a ZOOM card) live here now.
//
// `myAnyBooking` is ANY booking the viewer holds for this practice, in ANY
// status (including cancelled / no_show) -- so the history (status row, "Моя
// практика" title) survives for past/cancelled bookings. This is separate
// from `booked` / `myBooking` above (active-status semantics), which keep
// driving price / "Забронировать" / "Вы записаны" / check-in / feedback and
// must NOT change. Selection: an active booking
// (confirmed/pending/attended) wins; otherwise the latest by created_at.
// =========================================================================
const _ACTIVE_BOOKING_STATUSES = ['confirmed', 'pending', 'attended'] as const

const myAnyBooking = computed((): BookingWithPracticeResponse | null => {
  if (!practice.value) return null
  const pid = practice.value.id
  const mine = bookingsStore.bookings.filter((b) => b.practice_id === pid)
  if (mine.length === 0) return null
  const active = mine.find((b) =>
    (_ACTIVE_BOOKING_STATUSES as readonly string[]).includes(b.status),
  )
  if (active) return active
  // No active booking -> the most recent one (cancelled / no_show history).
  // `?? null` satisfies noUncheckedIndexedAccess; mine is non-empty here.
  return (
    [...mine].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0] ?? null
  )
})

/** Any booking exists (any status) -> show the "Моя практика" framing. */
const hasAnyBooking = computed((): boolean => myAnyBooking.value !== null)

/** A finished booking (attended / no_show) -> hide the "Забронировать" CTA. */
const isPastBooking = computed((): boolean => {
  const b = myAnyBooking.value
  return !!b && (b.status === 'attended' || b.status === 'no_show')
})

/**
 * True once the practice has started (scheduled_at <= now). The booking
 * endpoint rejects a started practice (backend create_booking time guard);
 * we hide the "Забронировать" CTA so it never dangles on a past practice
 * opened from history / a deep link. Uses the reactive `now` (60s tick) so
 * the button disappears live when the start time passes. The backend stays
 * the source of truth (direct API call / the start-while-open race).
 */
const practiceStarted = computed((): boolean => {
  if (!practice.value) return false
  return new Date(practice.value.scheduled_at).getTime() <= now.value
})

// -- Status row (ported from BookingDetailView; driven by myAnyBooking) --
// NB: confirmed -> «Вы записаны» ТОЛЬКО на этом экране (status row заменяет
// бывшую disabled-кнопку). Глобальный лейбл «Подтверждена» (Мои записи и пр.)
// живёт в своих местах и не трогается.
const STATUS_LABEL: Record<BookingStatus, string> = {
  pending: 'Ожидает',
  confirmed: 'Вы записаны',
  attended: 'Завершена',
  no_show: 'Неявка',
  cancelled: 'Отменена',
}

const STATUS_VARIANT: Record<BookingStatus, 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'warning',
  confirmed: 'success',
  attended: 'success',
  no_show: 'error',
  cancelled: 'error',
}

/**
 * AT-2: a CONFIRMED booking whose practice has already ended is NOT "still
 * booked" -- it's a Zoom-tracked practice awaiting its attendance report
 * (bookings/service.py deliberately leaves it CONFIRMED until the report
 * ripens or the deadline fallback fires). Without this, a user who sat
 * through the class and checks right after sees the exact same «Вы
 * записаны» they saw before it started -- indistinguishable from a no-show
 * at a glance. hasEnded is already imported/used by canCancel above.
 */
const attendancePending = computed((): boolean => {
  const b = myAnyBooking.value
  return !!b && b.status === 'confirmed' && hasEnded(b, now.value)
})

const statusLabel = computed(() => {
  if (attendancePending.value) return 'Посещаемость подсчитывается'
  return myAnyBooking.value ? STATUS_LABEL[myAnyBooking.value.status] : ''
})
const statusVariant = computed(() => {
  if (attendancePending.value) return 'muted'
  return myAnyBooking.value ? STATUS_VARIANT[myAnyBooking.value.status] : 'info'
})
const statusIcon = computed(() => {
  if (!myAnyBooking.value) return null
  if (attendancePending.value) return null
  switch (myAnyBooking.value.status) {
    case 'confirmed':
    case 'attended':
      return IconCheck
    case 'cancelled':
    case 'no_show':
      return IconClose
    default:
      return null
  }
})

/** ZOOM card shows only for an UPCOMING active booking (confirmed / pending,
 *  before the practice starts). Once the practice has started or is past, the
 *  "link will be sent 10 min before" note is meaningless — hide it. */
const showZoom = computed((): boolean => {
  const b = myAnyBooking.value
  return !!b && (b.status === 'confirmed' || b.status === 'pending') && !practiceStarted.value
})

/**
 * True when now is in the check-in window and booking is confirmed.
 */
const inCheckinWindow = computed((): boolean => {
  if (!practice.value || !myBooking.value) return false
  if (myBooking.value.status !== 'confirmed') return false
  // One check-in per booking: once done, drop back to the "Вы записаны" state.
  if (myBooking.value.has_checkin) return false
  const scheduledMs = new Date(practice.value.scheduled_at).getTime()
  return isInCheckinWindow(scheduledMs, now.value)
})

/**
 * True when now is in the feedback window and booking is attended.
 */
const inFeedbackWindow = computed((): boolean => {
  if (!practice.value || !myBooking.value) return false
  if (myBooking.value.status !== 'attended') return false
  // One feedback per booking: once left, drop back to the "Вы записаны" state.
  if (myBooking.value.has_feedback) return false
  const scheduledMs = new Date(practice.value.scheduled_at).getTime()
  return isInFeedbackWindow(scheduledMs, practice.value.duration_minutes, now.value)
})

// =========================================================================
// Formatted fields
// =========================================================================

// F5: render the date in the viewer's own profile timezone (the profile decides).
const viewerTz = useViewerTimezone()

const formattedDate = computed(() => {
  if (!practice.value) return ''
  return formatDate(practice.value.scheduled_at, viewerTz.value)
})

const formattedDuration = computed(() => {
  if (!practice.value) return ''
  return formatDuration(practice.value.duration_minutes)
})

const formattedParticipants = computed(() => {
  if (!practice.value) return ''
  return formatParticipants(practice.value.current_participants, practice.value.max_participants)
})

const formattedPrice = computed(() => {
  if (!practice.value) return ''
  return formatMoney(practice.value.price_cents, practice.value.currency)
})

const full = computed(() => {
  if (!practice.value) return false
  return isFull(practice.value.current_participants, practice.value.max_participants)
})

const bookButtonText = computed(() => {
  if (full.value) return 'Мест нет'
  if (practice.value?.is_free) return 'Записаться бесплатно'
  return 'Забронировать'
})

// =========================================================================
// Actions
// =========================================================================

const cancelling = ref(false)

/**
 * Booking is cancellable when status is confirmed or pending AND the practice
 * has not yet ended. attended/no_show/cancelled are not cancellable.
 *
 * G4: the backend keeps a booking `confirmed` until the practice is finalized
 * (now automatic — the lifecycle worker at scheduled_at + duration), so a
 * held-but-not-finalized practice would otherwise still
 * show «Отменить бронирование» on an already-over practice. Gate additionally on
 * hasEnded (scheduled_at + duration ≤ now) using the reactive `now` (60s tick),
 * so the action hides live the moment the practice ends. FE-hide only — the
 * backend late-cancel/no-refund path stays sanctioned (operator).
 */
const canCancel = computed((): boolean => {
  if (!myBooking.value) return false
  const activeStatus =
    myBooking.value.status === 'confirmed' || myBooking.value.status === 'pending'
  return activeStatus && !hasEnded(myBooking.value, now.value)
})

function onBook(): void {
  showBookingPopup.value = true
}

function onPurchased(): void {
  showBookingPopup.value = false
  justPurchased.value = true
  const id = route.params.id as string
  // No fetchPractice here: BookingConfirmedView loads the practice itself,
  // and this detail view reloads via its own onMounted when the user returns
  // (routes are not kept alive). Refreshing bookings keeps the global store
  // in sync so the booked state is correct on return.
  bookingsStore.refreshBookings()
  // Frame 5: go to the dedicated booking-confirmed screen.
  router.push({ name: 'user-booking-confirmed', params: { practiceId: id } })
}

/**
 * Места кончились в гонке (BookingPopup поймал practice_full): поднимаем
 * полноэкранный стейт «Места закончились» и обновляем практику/брони, чтобы
 * экран под оверлеем уже отражал заполненность (кнопка -> «Мест нет»).
 */
function onSoldOut(): void {
  soldOut.value = true
  store.fetchPractice(route.params.id as string)
  bookingsStore.refreshBookings()
}

/** «Найти другую практику» -> в Календарь (витрина записи). */
function onFindOther(): void {
  soldOut.value = false
  router.push({ name: 'user-calendar' })
}

function onCheckin(): void {
  if (!practice.value) return
  router.push({ name: 'user-checkin', params: { practiceId: practice.value.id } })
}

function onFeedback(): void {
  if (!practice.value) return
  router.push({ name: 'user-feedback', params: { practiceId: practice.value.id } })
}

async function onCancelBooking(): Promise<void> {
  if (!myBooking.value || cancelling.value) return
  cancelling.value = true
  const result = await bookingsStore.cancelBooking(myBooking.value.id)
  cancelling.value = false
  if (!result.ok) {
    // The store returns { ok, error } but does not raise a toast itself.
    toast.error(result.error)
    return
  }
  toast.success('Бронирование отменено')
  justPurchased.value = false
}

// =========================================================================
// Lifecycle
// =========================================================================

// Reactive clock: re-evaluate window computeds every minute so the button
// switches without requiring a page reload.
let clockInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  const id = route.params.id as string
  store.fetchPractice(id)
  bookingsStore.fetchMyBookings()
  // Refresh window checks every 60s.
  clockInterval = setInterval(() => {
    now.value = Date.now()
  }, 60_000)
})

// F-01: Vue Router may reuse this component instance when navigating between
// practices (e.g. from search results). onMounted won't fire again, so watch
// the route param and re-fetch when it changes.
watch(
  () => route.params.id as string,
  (newId, oldId) => {
    if (newId && newId !== oldId) {
      store.clearSelected()
      store.fetchPractice(newId)
      justPurchased.value = false
    }
  },
)

onUnmounted(() => {
  if (clockInterval) clearInterval(clockInterval)
})
</script>

<style scoped>
.detail__loader {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 40vh;
}

/* Outer container: a plain block — the whole screen scrolls in MobileLayout's
 * single __main scroll. No nested scroll / no pinned footer (operator fix:
 * "скролл на блоке, а не общий"). Hero + body + actions flow top-to-bottom. */
.detail {
  display: flex;
  flex-direction: column;
}

/* ===== Hero (shared PracticeHeroCard wrapper) =====
 * Horizontal screen-padding раздаётся MobileLayout (--velo-screen-padding=33).
 * Здесь только vertical top-margin, чтобы не было двойного отступа. */
.detail__hero {
  margin-top: var(--space-4);
}

/* ===== Body =====
 * Аналогично — горизонтальный padding из ML, локально только vertical. */
.detail__body {
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Difficulty indicator (Calendar iteration) */
/* Accordion text body */
.detail__accordion-text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
}

/* Override VAccordion: white card style matching design */
:deep(.v-accordion) {
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  border-bottom: none;
  overflow: hidden;
}

:deep(.v-accordion__header) {
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
}

:deep(.v-accordion__body) {
  padding: 0 var(--space-4) var(--space-3);
}

:deep(.v-accordion__arrow) {
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
}

/* ===== Section (master) ===== */
/* ===== Status row (Batch 6: ported from BookingDetailView) ===== */
.detail__status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  /* Match the accordion cards' padding for one cohesive card language. */
  padding: var(--space-3) var(--space-4);
}

.detail__status-label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

/* ===== Zoom card (Batch 6: ported from BookingDetailView) ===== */
.detail__zoom-card {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.5;
}

/* Section = label («Мастер» / «ZOOM») над карточкой. Разделительные линии
 * убраны — в белой DS они инородны; единый карточный язык + gap из __body
 * (operator: «навести красоту через DS», 2026-06-04). */
.detail__section {
  display: flex;
  flex-direction: column;
}

.detail__section-title {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--velo-text-secondary);
  letter-spacing: var(--velo-card-letter-spacing-meta);
  margin-bottom: var(--space-2);
}

/* ===== Contraindications banner (shared Banner) =====
 * Все стили — в Banner.vue (variant="warning"). Здесь только spacing вокруг. */
.detail__contraindications {
  margin-top: var(--space-2);
}

/* ===== Footer =====
 * Figma booked-practice.svg: кнопки сидят прямо на mandala-фоне экрана,
 * никакой стеклянной подложки. Убран background/backdrop-filter/border-top. */
.detail__actions {
  padding: var(--space-4) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.detail__price-row {
  /* F-5.4 sync: в Figma practice-booked.svg price-row — белая card 336×48
   * rx=15 (стиль как у accordion и status-row), не голый flex-row. */
  padding: var(--space-3) var(--space-4);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.detail__price-label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.detail__price-value {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
}

.detail__price-value--free {
  color: var(--velo-success-text);
}
</style>
