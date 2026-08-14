// =============================================================================
// VELO Frontend -- PracticeLiveView Screen Tests (probekit-screen-test v1.9)
// =============================================================================
//
// 194 lines of script, no test. TWO stores (usePracticesStore, useBookingsStore)
// PLUS a platform boundary (@/platform) PLUS a real SECURITY control
// (AUDIT-0520-02: a Zoom link is only ever opened when it starts with
// "https://"). This is the highest-value untested surface on the user board.
//
// PATTERN: both stores are DEPENDENCIES here, not the thing under test --
// same classification as PracticeDetailView.test.ts, and for the identical
// reason: this screen's OWN derivation (hasValidZoom / canJoin / the join-409
// no-op / the leave-always-navigates flow) is what needs proving, not the
// stores' internal fetch/refresh plumbing (already covered by
// stores/bookings.test.ts and stores/practices' own tests). Both mocked
// wholesale behind getters over a mutable object (velo-idiom §5), exactly
// PracticeDetailView.test.ts:59-97's shape. Real Pinia still installed so any
// real child that resolves its own store does not crash on a missing
// getActivePinia().
//
// PROVEN ABSENT (do not cargo-cult onto this screen): NO loading/error ladder.
// Grepped the template -- no VLoader, no v-if on any loading/error flag.
// Every field access goes through `practice?.x ?? fallback` (.vue:47-48), so
// the screen renders its full shape immediately and swaps in real values once
// the store resolves; there is nothing that "shows a loader" to assert. NO
// status branching either: the "В эфире" badge (.vue:51) is unconditional --
// this screen trusts whatever navigated it here (only reached from a
// dashboard/booking CTA gated on the practice actually being live) and does
// not itself re-check practice.status. Both confirmed by reading the full
// template, not assumed from the screen's name.
//
// VEmptyState is used for three T-35 states (host / cancelled / resolve-404),
// not as a general loading/error ladder; Check-in and "Покинуть практику"
// stay rendered regardless.
//
// Because both stores are mocked getters (not reactive refs), state must be
// set BEFORE mount() -- mutating bookingsState/practicesState mid-test does
// NOT trigger a recompute (same caveat as PracticeDetailView.test.ts:60-97;
// the getters read a plain closure variable, so Vue's reactivity system has
// nothing to track). Every test sets its fixture, then mounts once.
//
// T-35 SUPERSEDES TWO THINGS THIS FILE USED TO COVER, and the report says so
// rather than letting the coverage look silently dropped:
//   (a) the AUDIT-0520-02 https guard. It policed a master-typed string; that
//       field no longer exists, and every URL this screen can open now comes
//       from our own database through the resolve endpoint.
//   (b) N1's "Вы не записаны" empty state. A person with no booking is no
//       longer stonewalled -- they are offered the guest entry, which is what
//       the wrapper is for. The honest "не засчитается" mark took its place.
//
// ⚠ FINDING (not fixed, not asserted as "correct" -- flagged to the navigator
// in the report): onEnter (.vue:125-154) documents ONLY the 409
// "already joined" case as a no-op that still opens Zoom, but the code's
// actual gate (`!result.ok && !error.includes('already')`) treats EVERY
// join failure identically -- toast fires, Zoom opens regardless. The tests
// below assert the CURRENT behavior (both the documented 409 case and the
// undocumented generic-failure case reach platform.openLink) as a faithful
// record of what the code does today, not as a claim that it is correct.
//
// vue-router: mocked, never built. `platform`: mocked via the
// `get platform()` trick (stores/auth.test.ts:52-55) -- required because
// @/stores/auth (pulled in transitively by other screens' precedent) imports
// @/platform eagerly; referencing a spy at the mock factory's top level
// without the getter throws "Cannot access before initialization" the moment
// the mocked module loads, before this file's own consts exist.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import PracticeLiveView from '@/views/user/PracticeLiveView.vue'
import type { BookingWithPracticeResponse, PracticeResponse } from '@/api/types'

const push = vi.fn()
const back = vi.fn()
const routeParams: { practiceId: string } = { practiceId: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

// T-35: the screen asks the server how THIS user enters. Mocked at the API
// boundary -- the decision under test on this side is what the screen RENDERS
// for each kind, not how the ladder is computed (that lives in the backend's
// resolve_zoom_entry and is proved by its own doubles).
const resolveZoomEntry = vi.fn()
vi.mock('@/api/practices', () => ({
  resolveZoomEntry: (...args: unknown[]) => resolveZoomEntry(...args),
}))

const openLink = vi.fn()
const hapticFeedback = vi.fn()
vi.mock('@/platform', () => ({
  get platform() {
    return { name: 'standalone' as const, openLink, hapticFeedback }
  },
}))

// -- practices store (dependency) --
const practicesState: { selected: PracticeResponse | null } = { selected: null }
const fetchPractice = vi.fn()
vi.mock('@/stores/practices', () => ({
  usePracticesStore: () => ({
    get selected() {
      return practicesState.selected
    },
    fetchPractice,
  }),
}))

// -- bookings store (dependency) --
const bookingsState: { bookings: BookingWithPracticeResponse[] } = { bookings: [] }
const fetchMyBookings = vi.fn()
const joinBooking = vi.fn()
const leaveBooking = vi.fn()
vi.mock('@/stores/bookings', () => ({
  useBookingsStore: () => ({
    get bookings() {
      return bookingsState.bookings
    },
    fetchMyBookings,
    joinBooking,
    leaveBooking,
  }),
}))

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'master_1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'live',
    title: 'Утренняя медитация',
    description: null,
    scheduled_at: '2026-07-20T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 5,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    direction: 'meditation',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

function booking(
  overrides: Partial<BookingWithPracticeResponse> = {},
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
    practice: {
      id: 'p1',
      title: 'Утренняя медитация',
      practice_type: 'live',
      status: 'live',
      scheduled_at: '2026-07-20T10:00:00Z',
      duration_minutes: 60,
      timezone: 'UTC',
      master_id: 'master_1',
      master_name: 'Мастер',
      direction: 'meditation',
      is_free: true,
      price_cents: 0,
      currency: 'EUR',
    },
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// Real Pinia installed even though every store this screen reads is mocked
// wholesale above -- its children resolve stores of their own (VButton/VCard
// do not, but the pattern is load-bearing repo-wide; kept for consistency
// with every other screen test, PracticeDetailView.test.ts:190-196).
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(PracticeLiveView)
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
function enterBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.v-btn--primary') ?? null
}
function checkinBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.v-btn--secondary') ?? null
}
function leaveBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.v-btn--danger') ?? null
}
function backBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.live__back') ?? null
}
function emptyState(): HTMLElement | null {
  return host?.querySelector('.v-empty') ?? null
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  practicesState.selected = null
  bookingsState.bookings = []
  fetchPractice.mockReset()
  fetchMyBookings.mockReset()
  joinBooking.mockReset()
  leaveBooking.mockReset()
  openLink.mockReset()
  // Default: a booked user with a working personal link -- the ordinary case
  // every non-Zoom test in this file assumes.
  resolveZoomEntry.mockReset()
  resolveZoomEntry.mockResolvedValue({ kind: 'personal', url: 'https://zoom.us/j/123456' })
  hapticFeedback.mockReset()
  toastError.mockReset()
  push.mockReset()
  back.mockReset()
  routeParams.practiceId = 'p1'
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('PracticeLiveView', () => {
  // ===========================================================================
  describe('content', () => {
    it('before the practice resolves: renders the fallback title/master, not blank', () => {
      mount()

      expect(text()).toContain('Практика')
      expect(text()).toContain('с Мастером')
    })

    it('with the practice loaded: renders its real title, master, and the "В эфире" badge unconditionally', () => {
      practicesState.selected = practice({ title: 'Вечерняя йога', master_name: 'Анна' })
      mount()

      expect(text()).toContain('Вечерняя йога')
      expect(text()).toContain('с Анна')
      expect(text()).toContain('В эфире')
    })
  })

  // ===========================================================================
  describe('onMounted data fetch', () => {
    it('fetches the practice when nothing is selected yet, and always fetches my bookings', () => {
      mount()

      expect(fetchPractice).toHaveBeenCalledWith('p1')
      expect(fetchMyBookings).toHaveBeenCalledTimes(1)
    })

    it('skips re-fetching the practice when it is already the selected one (cache hit)', () => {
      practicesState.selected = practice({ id: 'p1' })
      mount()

      expect(fetchPractice).not.toHaveBeenCalled()
    })
  })
  // ===========================================================================
  // T-35: THE SCREEN NO LONGER CHOOSES A LINK.
  //
  // What used to live here was the client-side ladder (personal link, else the
  // manual practice.zoom_link, else "pending") plus the AUDIT-0520-02 https
  // guard that policed it. Both are gone from this file because both are gone
  // from the screen: the manual rung was deleted with its column, and the
  // remaining decision -- personal / guest / host / pending / failed /
  // cancelled -- is made by the server (GET /practices/{id}/zoom/resolve).
  //
  // The https guard is not "dropped": every URL this screen can now open came
  // out of our own database via that endpoint, not out of a field a master
  // typed. There is no longer an untrusted string to guard.
  //
  // What IS asserted here is that each kind renders honestly and that the
  // button cannot open something that does not exist.
  describe('T-35: rendering the server resolution', () => {
    it('personal: Войти is enabled and opens the personal link -- the outcome the whole feature exists for', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      resolveZoomEntry.mockResolvedValue({ kind: 'personal', url: 'https://zoom.us/j/personal?tk=x' })
      mount()
      await flush()

      expect(enterBtn()?.disabled).toBe(false)
      enterBtn()?.click()
      await flush()
      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/personal?tk=x')
    })

    it('guest: the honest "не засчитается" mark is shown AND the button works -- a person without a booking is let in, not stonewalled', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = []
      resolveZoomEntry.mockResolvedValue({ kind: 'guest', url: 'https://zoom.us/j/shared' })
      mount()
      await flush()

      expect(text()).toContain('Вы не записаны')
      expect(enterBtn()?.disabled).toBe(false)
      enterBtn()?.click()
      await flush()
      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/shared')
    })

    it('guest with NO url (the minting miss): honest line, button disabled, and it is NOT reported as a failed meeting', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = []
      resolveZoomEntry.mockResolvedValue({ kind: 'guest', url: null })
      mount()
      await flush()

      expect(text()).toContain('Гостевой вход сейчас недоступен')
      expect(text()).not.toContain('Не удалось создать встречу')
      expect(enterBtn()?.disabled).toBe(true)
      enterBtn()?.click()
      await flush()
      expect(openLink).not.toHaveBeenCalled()
    })

    it('pending: honest wait, button disabled, nothing opened -- a confirmed booking is NEVER downgraded to a guest link (that is what produced the false NO_SHOW)', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'pending', url: null })
      mount()
      await flush()

      expect(text()).toContain('Ссылка готовится')
      expect(enterBtn()?.disabled).toBe(true)
      enterBtn()?.click()
      await flush()
      expect(openLink).not.toHaveBeenCalled()
    })

    it('failed: distinct from pending -- the permanent-failure copy, not the spinner copy', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'failed', url: null })
      mount()
      await flush()

      expect(text()).toContain('Не удалось создать встречу')
      expect(text()).not.toContain('Ссылка готовится')
      expect(enterBtn()?.disabled).toBe(true)
    })

    it('host: the owner arriving by his own public link is told to start from the master screen, and is NOT handed a guest seat in his own meeting', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = []
      resolveZoomEntry.mockResolvedValue({ kind: 'host', url: null })
      mount()
      await flush()

      expect(emptyState()?.textContent).toContain('Это ваша практика')
      expect(enterBtn()).toBeNull()
      expect(openLink).not.toHaveBeenCalled()
    })

    it('cancelled: honest state, no entry offered', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'cancelled', url: null })
      mount()
      await flush()

      expect(emptyState()?.textContent).toContain('Практика отменена')
      expect(enterBtn()).toBeNull()
    })

    it('the resolve call 404s (a well-formed deep link naming a deleted practice): an honest error, NEVER an empty screen', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = []
      resolveZoomEntry.mockRejectedValue(new Error('404'))
      mount()
      await flush()

      expect(emptyState()?.textContent).toContain('Практика не найдена')
      expect(enterBtn()).toBeNull()
    })

    it('asks the server keyed by PRACTICE ID -- not by a code the screen would have to encode', async () => {
      practicesState.selected = practice()
      mount()
      await flush()

      expect(resolveZoomEntry).toHaveBeenCalledWith('p1')
    })
  })


  // ===========================================================================
  describe('join flow', () => {
    it('a fresh booking (never joined): calls joinBooking, then haptic + openLink on success', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: true, error: '' })
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // link (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(joinBooking).toHaveBeenCalledWith('b1')
      expect(toastError).not.toHaveBeenCalled()
      expect(hapticFeedback).toHaveBeenCalledWith('medium')
      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/123456')
    })

    it('shows the loading state on Войти while the join call is pending', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockReturnValue(new Promise(() => {})) // never resolves
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // link (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(enterBtn()?.classList.contains('v-btn--loading')).toBe(true)
      expect(enterBtn()?.disabled).toBe(true)
    })

    it('an ALREADY-joined booking (joined_at already set): skips calling joinBooking and opens Zoom directly', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: '2026-07-20T09:00:00Z' })]
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // link (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(joinBooking).not.toHaveBeenCalled()
      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/123456')
    })

    it('the documented 409 "already joined" case: joinBooking rejects with an "already"-worded error -- toast is suppressed, Zoom still opens', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: false, error: 'Booking already joined' })
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // link (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(toastError).not.toHaveBeenCalled()
      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/123456')
    })

    it('⚠ FINDING (documented, not fixed): a REAL join failure (not "already") shows the toast, but current code still opens Zoom -- the docstring only carves out the 409 case, the guard treats every failure alike', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: false, error: 'Practice is full' })
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // link (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Practice is full')
      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/123456')
    })
  })

  // ===========================================================================
  describe('check-in', () => {
    it('not yet checked in: navigates to the check-in route with the practiceId', () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ has_checkin: false })]
      mount()

      checkinBtn()?.click()

      expect(push).toHaveBeenCalledWith({ name: 'user-checkin', params: { practiceId: 'p1' } })
    })

    it('already checked in: the button is disabled and reads "Check-in сделан"', () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ has_checkin: true })]
      mount()

      expect(checkinBtn()?.disabled).toBe(true)
      expect(checkinBtn()?.textContent?.trim()).toBe('Check-in сделан')
    })
  })

  // ===========================================================================
  describe('leave flow', () => {
    it('a joined, not-yet-left booking: calls leaveBooking, then navigates to the dashboard', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [
        booking({ id: 'b1', joined_at: '2026-07-20T09:00:00Z', left_at: null }),
      ]
      leaveBooking.mockResolvedValue({ ok: true, error: '' })
      mount()

      leaveBtn()?.click()
      await flush()

      expect(leaveBooking).toHaveBeenCalledWith('b1')
      expect(toastError).not.toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('never joined: does NOT call leaveBooking, but still navigates to the dashboard', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      mount()

      leaveBtn()?.click()
      await flush()

      expect(leaveBooking).not.toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('leaveBooking fails: shows the toast AND still navigates to the dashboard (documented "always returns" behavior)', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [
        booking({ id: 'b1', joined_at: '2026-07-20T09:00:00Z', left_at: null }),
      ]
      leaveBooking.mockResolvedValue({ ok: false, error: 'Сеть недоступна' })
      mount()

      leaveBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Сеть недоступна')
      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('the back button navigates to the dashboard (breaks the check-in <-> live loop, not router.back())', () => {
      mount()

      backBtn()?.click()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })
})
