// =============================================================================
// VELO Frontend -- PracticeDetailView Screen Tests (T8, ПРОМТ №432)
// =============================================================================
//
// The buy button. This is where a user spends their balance on a practice, and
// it carries the most branching logic of any screen in the app (21 computeds).
// The money-critical properties: the PRICE shown is the practice's own, a free
// practice is never sold as paid, a full practice cannot be bought, and a
// started/owned/finished practice offers no CTA at all -- the backend rejects
// each of those, so a dangling button is a user who is told "no" after
// committing.
//
// PATTERN A (store-backed) -- but BOTH stores are DEPENDENCIES here, not the
// thing under test, so both are mocked wholesale behind getters over mutable
// objects (the guards.test.ts trick, velo-idiom §5). What IS under test is this
// screen's own derivation: booked / canCancel / practiceStarted / the windows /
// the CTA ladder. Driving that through real stores would mean faking two API
// surfaces to reach state the screen computes anyway -- more setup, same
// assertions, and a slower test that proves less about THIS file.
//
// TIME IS PINNED (vi.setSystemTime). The screen keeps a reactive `now` seeded
// from Date.now() and re-read every 60s (PracticeDetailView.vue:~76, ~340), and
// practiceStarted / the check-in + feedback windows / canCancel all compare
// against it. Fixtures are literals relative to the frozen instant.
// useViewerTimezone is mocked to a FIXED zone -- it reads the auth profile, and
// an unpinned zone would drift formatDate.
//
// setInterval: the screen starts a 60s clock and clears it onUnmounted. Fake
// timers are NOT used to drive it -- the tests set `now` state through fixtures
// instead. The interval is harmless under vi.setSystemTime and the unmount in
// afterEach clears it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import PracticeDetailView from '@/views/user/PracticeDetailView.vue'
import type { BookingWithPracticeResponse, PracticeResponse } from '@/api/types'

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

vi.mock('@/composables/useViewerTimezone', async () => {
  const { computed } = await import('vue')
  return { useViewerTimezone: () => computed(() => 'UTC') }
})

// -- practices store (dependency) --
const practicesState: {
  selected: PracticeResponse | null
  selectedLoading: boolean
  selectedError: string | null
} = { selected: null, selectedLoading: false, selectedError: null }
const fetchPractice = vi.fn()
const clearSelected = vi.fn()
vi.mock('@/stores/practices', () => ({
  usePracticesStore: () => ({
    get selected() {
      return practicesState.selected
    },
    get selectedLoading() {
      return practicesState.selectedLoading
    },
    get selectedError() {
      return practicesState.selectedError
    },
    fetchPractice,
    clearSelected,
  }),
}))

// -- bookings store (dependency) --
const bookingsState: { bookings: BookingWithPracticeResponse[] } = { bookings: [] }
const fetchMyBookings = vi.fn()
const refreshBookings = vi.fn()
const cancelBooking = vi.fn()
vi.mock('@/stores/bookings', () => ({
  useBookingsStore: () => ({
    get bookings() {
      return bookingsState.bookings
    },
    fetchMyBookings,
    refreshBookings,
    cancelBooking,
  }),
}))

// -- auth store (dependency): only user.id matters, for the isMaster check --
const authState: { user: { id: string } | null } = { user: { id: 'user_1' } }
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

const NOW = new Date('2026-07-20T12:00:00Z')
const NOW_MS = NOW.getTime()
const HOUR = 3600_000

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    title: 'Утренняя практика',
    description: null,
    what_to_prepare: null,
    contraindications: null,
    practice_type: 'online',
    status: 'scheduled',
    // 2 days out -- comfortably not started, outside every window.
    scheduled_at: '2026-07-22T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    master_id: 'master_1',
    master_name: 'Мастер',
    direction: null,
    difficulty: null,
    is_free: false,
    price_cents: 2500,
    currency: 'EUR',
    max_participants: 10,
    current_participants: 3,
    zoom_link: null,
    ...overrides,
  } as PracticeResponse
}

// A booking carries a NESTED practice summary, and it is load-bearing here:
// canCancel calls hasEnded(booking), which reads booking.practice.scheduled_at
// (utils/bookingStatus.ts:41-43) -- NOT the store's selected practice. So the
// nested summary must mirror the practice under test or the cancel gate is
// computed against the wrong clock. `nested` defaults to the same schedule as
// the practice fixture; tests that move the practice in time pass it too.
function booking(
  overrides: Partial<BookingWithPracticeResponse> = {},
  nested: Partial<BookingWithPracticeResponse['practice']> = {},
): BookingWithPracticeResponse {
  return {
    id: 'b1',
    practice_id: 'p1',
    user_id: 'user_1',
    status: 'confirmed',
    purchase_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    joined_at: null,
    left_at: null,
    checkin_skipped: false,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    has_feedback: false,
    has_checkin: false,
    ...overrides,
    practice: {
      id: 'p1',
      title: 'Утренняя практика',
      practice_type: 'online',
      status: 'scheduled',
      scheduled_at: '2026-07-22T10:00:00Z',
      duration_minutes: 60,
      timezone: 'UTC',
      master_id: 'master_1',
      master_name: 'Мастер',
      direction: null,
      is_free: false,
      price_cents: 2500,
      currency: 'EUR',
      zoom_link: null,
      ...nested,
    },
  } as BookingWithPracticeResponse
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// Real Pinia is installed even though every store THIS screen touches is
// module-mocked above. Its CHILDREN are not stubbed (velo-idiom §2), and they
// resolve stores of their own -- without an active Pinia they throw
// "getActivePinia() was called but there was no active Pinia" and the mount
// dies before a single assertion runs. The mocked stores never reach Pinia, so
// the two coexist: mocks for what this screen reads, a real Pinia underneath so
// the real children can mount.
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(PracticeDetailView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  pinia = createPinia()
  setActivePinia(pinia)
  routeParams.id = 'p1'
  practicesState.selected = practice()
  practicesState.selectedLoading = false
  practicesState.selectedError = null
  bookingsState.bookings = []
  authState.user = { id: 'user_1' }
  fetchPractice.mockReset()
  clearSelected.mockReset()
  fetchMyBookings.mockReset()
  refreshBookings.mockReset()
  cancelBooking.mockReset().mockResolvedValue({ ok: true })
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('PracticeDetailView', () => {
  describe('state ladder', () => {
    it('shows the loader while the practice is in flight', async () => {
      practicesState.selectedLoading = true
      practicesState.selected = null
      mount()
      await flush()

      expect(host?.querySelector('.detail__loader')).not.toBeNull()
    })

    it('error: surfaces the REAL store message, not a hardcoded fallback', async () => {
      // :description="store.selectedError" (PracticeDetailView.vue:37).
      practicesState.selectedLoading = false
      practicesState.selected = null
      practicesState.selectedError = 'Практика удалена мастером'
      mount()
      await flush()

      expect(text()).toContain('Практика не найдена')
      expect(text()).toContain('Практика удалена мастером')
    })

    it('content: renders the practice the store actually holds', async () => {
      practicesState.selected = practice({ title: 'Вечерняя йога' })
      mount()
      await flush()

      expect(text()).toContain('Вечерняя йога')
    })

    it('fetches the practice and the bookings on mount', async () => {
      mount()
      await flush()

      expect(fetchPractice).toHaveBeenCalledWith('p1')
      expect(fetchMyBookings).toHaveBeenCalled()
    })
  })

  describe('price', () => {
    it('renders the price in the practice\'s OWN currency', async () => {
      practicesState.selected = practice({ price_cents: 2500, currency: 'EUR', is_free: false })
      mount()
      await flush()

      expect(host?.querySelector('.detail__price-value')?.textContent).toContain('25,00')
    })

    it('a FREE practice reads «Бесплатно», not «0,00»', async () => {
      // formatMoney's allowZero defaults to false here (PracticeDetailView.vue:
      // formattedPrice passes no flag), which is correct on this screen: a
      // 0-cent practice IS free and should say so.
      practicesState.selected = practice({ price_cents: 0, is_free: true })
      mount()
      await flush()

      expect(host?.querySelector('.detail__price-value')?.textContent).toContain('Бесплатно')
    })

    it('a free practice offers «Записаться бесплатно», a paid one «Забронировать»', async () => {
      // bookButtonText (PracticeDetailView.vue:~240). Offering "Забронировать"
      // on a free practice is a needless payment framing; the reverse is worse.
      practicesState.selected = practice({ is_free: true, price_cents: 0 })
      mount()
      await flush()
      expect(button('Записаться бесплатно')).toBeDefined()

      app?.unmount()
      host?.remove()
      practicesState.selected = practice({ is_free: false, price_cents: 2500 })
      mount()
      await flush()
      expect(button('Забронировать')).toBeDefined()
      expect(button('Записаться бесплатно')).toBeUndefined()
    })

    it('the price row is HIDDEN once booked -- it is already paid for', async () => {
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      expect(host?.querySelector('.detail__price-row')).toBeNull()
    })
  })

  describe('capacity', () => {
    it('a full practice says «Мест нет» and the button is disabled', async () => {
      practicesState.selected = practice({ current_participants: 10, max_participants: 10 })
      mount()
      await flush()

      const btn = button('Мест нет')
      expect(btn).toBeDefined()
      expect(btn?.disabled).toBe(true)
    })

    it('a practice with room is bookable', async () => {
      practicesState.selected = practice({ current_participants: 9, max_participants: 10 })
      mount()
      await flush()

      expect(button('Забронировать')?.disabled).toBe(false)
    })

    it('an UNCAPPED practice is never full', async () => {
      // max_participants null = no limit. Treating null as 0 would lock every
      // open practice behind «Мест нет».
      practicesState.selected = practice({ current_participants: 999, max_participants: null })
      mount()
      await flush()

      expect(button('Забронировать')?.disabled).toBe(false)
      expect(button('Мест нет')).toBeUndefined()
    })
  })

  describe('who may NOT book (the CTA must not dangle)', () => {
    it('the practice OWNER gets no book button', async () => {
      // The backend rejects self-booking; showing the button would be a dead end
      // (PracticeDetailView.vue:~50).
      authState.user = { id: 'master_1' }
      practicesState.selected = practice({ master_id: 'master_1' })
      mount()
      await flush()

      expect(button('Забронировать')).toBeUndefined()
    })

    it('a STARTED practice gets no book button', async () => {
      // practiceStarted compares scheduled_at against the reactive `now`. The
      // booking endpoint rejects a started practice.
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS - HOUR).toISOString(),
      })
      mount()
      await flush()

      expect(button('Забронировать')).toBeUndefined()
    })

    it('a practice starting in a minute is STILL bookable -- the guard is <=, not fuzzy', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS + 60_000).toISOString(),
      })
      mount()
      await flush()

      expect(button('Забронировать')).toBeDefined()
    })

    it('an ATTENDED booking gets no re-book button', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS - 48 * HOUR).toISOString(),
      })
      bookingsState.bookings = [booking({ status: 'attended', has_feedback: true })]
      mount()
      await flush()

      expect(button('Забронировать')).toBeUndefined()
    })

    it('a CANCELLED booking on a future practice CAN re-book', async () => {
      // isPastBooking is attended/no_show only (PracticeDetailView.vue:121-124).
      // A cancelled booking must not lock the user out of a practice they still
      // want -- and still want to pay for.
      bookingsState.bookings = [booking({ status: 'cancelled' })]
      mount()
      await flush()

      expect(button('Забронировать')).toBeDefined()
    })
  })

  describe('booked state', () => {
    it('an active booking shows the status row and NO book button', async () => {
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      expect(text()).toContain('Вы записаны')
      expect(button('Забронировать')).toBeUndefined()
    })

    it('AT-2: a confirmed booking whose practice already ended shows "being calculated", not «Вы записаны»', async () => {
      // bookings/service.py deliberately leaves a Zoom-tracked booking
      // CONFIRMED after the practice ends until the attendance report ripens
      // or the deadline fallback fires. Without this, a user who sat through
      // the class sees the exact same «Вы записаны» as before it started --
      // indistinguishable from a no-show at a glance.
      const ended = new Date(NOW_MS - 3 * HOUR).toISOString()
      practicesState.selected = practice({ scheduled_at: ended, duration_minutes: 60 })
      bookingsState.bookings = [
        booking({ status: 'confirmed' }, { scheduled_at: ended, duration_minutes: 60 }),
      ]
      mount()
      await flush()

      expect(text()).toContain('Посещаемость подсчитывается')
      expect(text()).not.toContain('Вы записаны')
    })

    it('a booking for a DIFFERENT practice does not count as booked', async () => {
      // The whole `booked` computed keys on practice_id. A mismatch here would
      // either block a purchase or fake one.
      bookingsState.bookings = [booking({ practice_id: 'p_other', status: 'confirmed' })]
      mount()
      await flush()

      expect(button('Забронировать')).toBeDefined()
      expect(text()).not.toContain('Вы записаны')
    })

    it('the header reads «Моя практика» when a booking exists, «Практика» otherwise', async () => {
      mount()
      await flush()
      expect(text()).toContain('Практика')

      app?.unmount()
      host?.remove()
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()
      expect(text()).toContain('Моя практика')
    })

    it('a CANCELLED booking still shows its status row -- the history survives', async () => {
      // myAnyBooking keeps ANY status (PracticeDetailView.vue:~95-110).
      bookingsState.bookings = [booking({ status: 'cancelled' })]
      mount()
      await flush()

      expect(text()).toContain('Отменена')
    })

    it('an ACTIVE booking wins over an older cancelled one', async () => {
      // Selection order matters: showing «Отменена» to someone who re-booked and
      // holds a paid confirmed booking is a support ticket.
      bookingsState.bookings = [
        booking({ id: 'b_old', status: 'cancelled', created_at: '2026-07-10T00:00:00Z' }),
        booking({ id: 'b_new', status: 'confirmed', created_at: '2026-07-01T00:00:00Z' }),
      ]
      mount()
      await flush()

      expect(text()).toContain('Вы записаны')
      expect(text()).not.toContain('Отменена')
    })

    it('with no active booking, the LATEST by created_at is shown', async () => {
      bookingsState.bookings = [
        booking({ id: 'b_old', status: 'cancelled', created_at: '2026-07-01T00:00:00Z' }),
        booking({ id: 'b_new', status: 'no_show', created_at: '2026-07-10T00:00:00Z' }),
      ]
      mount()
      await flush()

      expect(text()).toContain('Неявка')
      expect(text()).not.toContain('Отменена')
    })
  })

  describe('check-in / feedback windows', () => {
    it('offers check-in for a confirmed booking inside the window', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS + HOUR).toISOString(),
      })
      bookingsState.bookings = [booking({ status: 'confirmed', has_checkin: false })]
      mount()
      await flush()

      expect(button('Check-in перед практикой')).toBeDefined()
    })

    it('does NOT offer check-in twice -- has_checkin drops it', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS + HOUR).toISOString(),
      })
      bookingsState.bookings = [booking({ status: 'confirmed', has_checkin: true })]
      mount()
      await flush()

      expect(button('Check-in перед практикой')).toBeUndefined()
      expect(text()).toContain('Вы записаны')
    })

    it('does NOT offer check-in far outside the window', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS + 72 * HOUR).toISOString(),
      })
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      expect(button('Check-in перед практикой')).toBeUndefined()
    })

    it('offers feedback for an attended booking inside the window', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS - 2 * HOUR).toISOString(),
        duration_minutes: 60,
      })
      bookingsState.bookings = [booking({ status: 'attended', has_feedback: false })]
      mount()
      await flush()

      expect(button('Оставить feedback')).toBeDefined()
    })

    it('does NOT offer feedback twice -- has_feedback drops it', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS - 2 * HOUR).toISOString(),
        duration_minutes: 60,
      })
      bookingsState.bookings = [booking({ status: 'attended', has_feedback: true })]
      mount()
      await flush()

      expect(button('Оставить feedback')).toBeUndefined()
    })

    it('check-in navigates to the check-in screen for THIS practice', async () => {
      practicesState.selected = practice({
        id: 'p42',
        scheduled_at: new Date(NOW_MS + HOUR).toISOString(),
      })
      bookingsState.bookings = [booking({ practice_id: 'p42', status: 'confirmed' })]
      mount()
      await flush()

      button('Check-in перед практикой')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-checkin', params: { practiceId: 'p42' } })
    })
  })

  describe('ZOOM card', () => {
    it('shows for an upcoming confirmed booking', async () => {
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      expect(text()).toContain('ZOOM')
    })

    it('is HIDDEN once the practice has started -- the note is meaningless then', async () => {
      practicesState.selected = practice({
        scheduled_at: new Date(NOW_MS - HOUR).toISOString(),
      })
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      expect(text()).not.toContain('ZOOM')
    })

    it('is HIDDEN for a cancelled booking', async () => {
      bookingsState.bookings = [booking({ status: 'cancelled' })]
      mount()
      await flush()

      expect(text()).not.toContain('ZOOM')
    })
  })

  describe('cancelling a booking', () => {
    it('offers cancel for a confirmed booking on a future practice', async () => {
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      expect(button('Отменить бронирование')).toBeDefined()
    })

    it('does NOT offer cancel once the practice has ENDED', async () => {
      // G4 (PracticeDetailView.vue:~267-272): the backend keeps a booking
      // confirmed until the lifecycle worker finalizes it, so status alone would
      // dangle «Отменить» on an practice that is already over.
      const ended = new Date(NOW_MS - 3 * HOUR).toISOString()
      practicesState.selected = practice({ scheduled_at: ended, duration_minutes: 60 })
      // The nested summary moves too -- hasEnded reads THAT, not the store's.
      bookingsState.bookings = [
        booking({ status: 'confirmed' }, { scheduled_at: ended, duration_minutes: 60 }),
      ]
      mount()
      await flush()

      expect(button('Отменить бронирование')).toBeUndefined()
    })

    it('cancels through the store and reports success', async () => {
      bookingsState.bookings = [booking({ id: 'b7', status: 'confirmed' })]
      mount()
      await flush()

      button('Отменить бронирование')?.click()
      await flush()

      expect(cancelBooking).toHaveBeenCalledWith('b7')
      expect(toastSuccess).toHaveBeenCalledWith('Бронирование отменено')
    })

    it('surfaces the store\'s REAL error and does NOT claim success', async () => {
      // W-25: the store returns { ok, error } and raises no toast itself
      // (PracticeDetailView.vue:~318-325). Swallowing this would tell a user
      // their money-back cancel worked when it did not.
      cancelBooking.mockResolvedValue({ ok: false, error: 'Отмена невозможна менее чем за час' })
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      button('Отменить бронирование')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Отмена невозможна менее чем за час')
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('does NOT double-cancel when the button is hit twice in flight', async () => {
      let resolve!: (v: { ok: boolean }) => void
      cancelBooking.mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      bookingsState.bookings = [booking({ status: 'confirmed' })]
      mount()
      await flush()

      button('Отменить бронирование')?.click()
      await nextTick()
      button('Отменить бронирование')?.click()
      await nextTick()

      expect(cancelBooking).toHaveBeenCalledTimes(1)

      resolve({ ok: true })
      await flush()
    })
  })

  // NOT COVERED, deliberately -- two limits of this file's seams, stated rather
  // than faked:
  //
  // 1. The F-01 route-reuse watch (PracticeDetailView.vue:~350-360): Vue Router
  //    reuses this instance between practices, so onMounted does not re-fire and
  //    a watch on route.params.id re-fetches. `useRoute` is mocked as a PLAIN
  //    object (velo-idiom §6 -- never build a real router), and a plain object
  //    cannot notify Vue, so the watch never fires here. Any test of it would be
  //    asserting the mock's own mutation. Covering it needs a real router, which
  //    this repo's idiom rules out; it belongs to whatever exercises routing.
  //
  // 2. The 60s clock tick (PracticeDetailView.vue:~76): every time-gated state
  //    IS covered above, but by fixtures placed relative to a frozen instant --
  //    not by advancing the interval. The tick itself (button appears live when
  //    the start time passes) would need fake timers driving setInterval AND a
  //    reactive store seam; the stores here are plain mocks read at mount, so
  //    post-mount re-renders are not reachable. The computeds are proven; the
  //    tick that re-runs them is not.
})
