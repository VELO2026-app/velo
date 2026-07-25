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
// N1 (ПРОМТ №587): VEmptyState WAS added, but only for one specific case --
// no booking at all for this practice (`!myBooking`) -- replacing the
// badges + "Войти" button block. It is not a general loading/error ladder;
// Check-in and "Покинуть практику" stay rendered regardless (deliberately
// out of this fix's scope, see the PROMPT).
//
// Because both stores are mocked getters (not reactive refs), state must be
// set BEFORE mount() -- mutating bookingsState/practicesState mid-test does
// NOT trigger a recompute (same caveat as PracticeDetailView.test.ts:60-97;
// the getters read a plain closure variable, so Vue's reactivity system has
// nothing to track). Every test sets its fixture, then mounts once.
//
// ⭐ THE SECURITY GUARD (AUDIT-0520-02, .vue:114): canJoin requires BOTH an
// active booking AND `zoom_link.startsWith('https://')`. Covered from both
// sides below (safe link enables + opens; four distinct unsafe shapes disable
// and never reach platform.openLink) and mutation-proved by hand: commenting
// out the `.startsWith('https://')` half of hasValidZoom (.vue:114) turns the
// "http://" test red (Войти becomes enabled) -- reverted before commit.
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
    zoom_link: 'https://zoom.us/j/123456',
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
      zoom_link: 'https://zoom.us/j/123456',
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
  describe('N1 (ПРОМТ №587): honest "not booked" empty state', () => {
    it('no matching booking: the empty state renders with the exact copy, and the join button/badges are absent -- Check-in and «Покинуть практику» stay', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/123456' })
      bookingsState.bookings = []
      mount()

      expect(emptyState()).not.toBeNull()
      expect(emptyState()?.textContent).toContain('Вы не записаны на это занятие')
      expect(emptyState()?.textContent).toContain('Чтобы войти, сначала забронируйте практику')
      expect(enterBtn()).toBeNull()
      expect(checkinBtn()).not.toBeNull()
      expect(leaveBtn()).not.toBeNull()
    })

    it('with an active booking: unchanged -- no empty state, the normal join button renders instead', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/123456' })
      bookingsState.bookings = [booking()]
      mount()

      expect(emptyState()).toBeNull()
      expect(enterBtn()).not.toBeNull()
    })

    it('does not auto-redirect -- no router.push/back is called just because there is no booking', () => {
      practicesState.selected = practice()
      bookingsState.bookings = []
      mount()

      expect(push).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('⭐ the security guard (AUDIT-0520-02): Войти only for a valid https Zoom link', () => {
    it('a valid https zoom_link + an active booking: Войти is enabled', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/123456' })
      bookingsState.bookings = [booking()]
      mount()

      expect(enterBtn()?.disabled).toBe(false)
    })

    it('clicking Войти with a valid link opens EXACTLY that URL via platform.openLink', async () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/999' })
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:01:00Z' })] // already joined -> no API call needed
      joinBooking.mockResolvedValue({ ok: true, error: '' })
      mount()

      enterBtn()?.click()
      await flush()

      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/999')
      expect(openLink).toHaveBeenCalledTimes(1)
    })

    it('a non-https link (http://) disables Войти, and clicking it never reaches platform.openLink', () => {
      practicesState.selected = practice({ zoom_link: 'http://zoom.us/j/123456' })
      bookingsState.bookings = [booking()]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
      enterBtn()?.click() // a disabled <button> fires no click handler in happy-dom either
      expect(openLink).not.toHaveBeenCalled()
    })

    it('a javascript: URI disables Войти and never reaches platform.openLink', () => {
      practicesState.selected = practice({ zoom_link: 'javascript:alert(1)' })
      bookingsState.bookings = [booking()]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
      enterBtn()?.click()
      expect(openLink).not.toHaveBeenCalled()
    })

    it('an empty zoom_link disables Войти', () => {
      practicesState.selected = practice({ zoom_link: '' })
      bookingsState.bookings = [booking()]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
    })

    it('no zoom_link (null) disables Войти', () => {
      practicesState.selected = practice({ zoom_link: null })
      bookingsState.bookings = [booking()]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
    })

    it('a valid https link but NO booking: N1 (ПРОМТ №587) -- "Войти" is GONE, replaced by the not-booked empty state, not merely disabled', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/123456' })
      bookingsState.bookings = []
      mount()

      expect(enterBtn()).toBeNull()
      expect(emptyState()).not.toBeNull()
    })

    it('a CANCELLED booking for this practice does not count as "my booking" -- N1: the not-booked empty state shows, same as no booking at all', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/123456' })
      bookingsState.bookings = [booking({ status: 'cancelled' })]
      mount()

      expect(enterBtn()).toBeNull()
      expect(emptyState()).not.toBeNull()
    })
  })

  // ===========================================================================
  describe('D3 link ladder (T21-1, ПРОМТ №541): personal link first, manual marked, else pending', () => {
    it('a personal registrant link takes priority over the manual zoom_link -- opens the PERSONAL one', async () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/manual' })
      bookingsState.bookings = [
        booking({
          joined_at: '2026-07-20T10:01:00Z',
          zoom_registrant_join_url: 'https://zoom.us/w/personal?tk=abc',
        }),
      ]
      mount()

      enterBtn()?.click()
      await flush()

      expect(openLink).toHaveBeenCalledWith('https://zoom.us/w/personal?tk=abc')
    })

    it('no personal link, but a valid manual zoom_link: Войти is enabled and shows the "not counted" mark', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/manual' })
      bookingsState.bookings = [booking()] // no zoom_registrant_join_url in the fixture
      mount()

      expect(enterBtn()?.disabled).toBe(false)
      expect(text()).toContain('посещение не засчитается')
    })

    it('a personal link present: the "not counted" mark does NOT show', () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/manual' })
      bookingsState.bookings = [
        booking({ zoom_registrant_join_url: 'https://zoom.us/w/personal?tk=abc' }),
      ]
      mount()

      expect(text()).not.toContain('посещение не засчитается')
    })

    it('neither link exists: Войти is disabled and reads "Ссылка готовится", not the default label', () => {
      practicesState.selected = practice({ zoom_link: null })
      bookingsState.bookings = [booking({ zoom_registrant_join_url: null, joined_at: null })]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
      expect(text()).toContain('Ссылка готовится')
    })

    // A4 V2 (ПРОМТ №572): before this, create_failed and pending_creation
    // rendered the IDENTICAL "Ссылка готовится" state -- a permanently
    // failed meeting looked exactly like one still being created, forever.
    it('the meeting permanently FAILED (create_failed): honest distinct state, not "готовится"', () => {
      practicesState.selected = practice({ zoom_link: null, zoom_meeting_status: 'create_failed' })
      bookingsState.bookings = [booking({ zoom_registrant_join_url: null, joined_at: null })]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
      expect(enterBtn()?.textContent).toContain('Ссылка недоступна')
      expect(text()).not.toContain('Ссылка готовится')
      expect(text()).toContain('Не удалось создать встречу')
    })

    it('pending_creation is still the honest "готовится" state, not "failed"', () => {
      // The discriminator: pending_creation must NOT read as a failure.
      practicesState.selected = practice({
        zoom_link: null,
        zoom_meeting_status: 'pending_creation',
      })
      bookingsState.bookings = [booking({ zoom_registrant_join_url: null, joined_at: null })]
      mount()

      expect(enterBtn()?.disabled).toBe(true)
      expect(enterBtn()?.textContent).toContain('Ссылка готовится')
      expect(text()).not.toContain('Не удалось создать встречу')
    })

    it('a manual zoom_link still wins over create_failed -- the link itself is the source of truth', () => {
      practicesState.selected = practice({
        zoom_link: 'https://zoom.us/j/manual',
        zoom_meeting_status: 'create_failed',
      })
      bookingsState.bookings = [booking({ zoom_registrant_join_url: null })]
      mount()

      expect(enterBtn()?.disabled).toBe(false)
      expect(text()).toContain('посещение не засчитается')
      expect(text()).not.toContain('Не удалось создать встречу')
    })

    it('a non-https personal link is never opened -- falls through to the manual link instead', async () => {
      practicesState.selected = practice({ zoom_link: 'https://zoom.us/j/manual' })
      bookingsState.bookings = [
        booking({
          joined_at: '2026-07-20T10:01:00Z',
          zoom_registrant_join_url: 'http://insecure.example/tk=abc',
        }),
      ]
      mount()

      enterBtn()?.click()
      await flush()

      expect(openLink).toHaveBeenCalledWith('https://zoom.us/j/manual')
    })
  })

  // ===========================================================================
  describe('join flow', () => {
    it('a fresh booking (never joined): calls joinBooking, then haptic + openLink on success', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: true, error: '' })
      mount()

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

      enterBtn()?.click()
      await flush()

      expect(enterBtn()?.classList.contains('v-btn--loading')).toBe(true)
      expect(enterBtn()?.disabled).toBe(true)
    })

    it('an ALREADY-joined booking (joined_at already set): skips calling joinBooking and opens Zoom directly', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: '2026-07-20T09:00:00Z' })]
      mount()

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
