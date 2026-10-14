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
// stay rendered regardless -- except (F4) for the practice's own master and in
// the master zone, where they are not his actions.
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
// ⚠ FINDING RESOLVED (FE-78.2, 2026-10-03): the gate now keys on the machine
// status (`result.status !== 409`) instead of matching the word "already" in
// the human-readable error. The 409 case is suppressed, a real failure toasts.
// NOTE: a real failure still opens Zoom afterwards -- the ticket scoped the fix
// to the toast gate only; if that is wrong too, it is a separate decision.
//
// STANDALONE F4 SUPERSEDES THE LINK. Zoom now runs INSIDE VELO (Meeting SDK,
// client view): «Войти»/«Начать» ask the server for SDK parameters
// (joinZoomSdk) and hand them to platform/zoom-sdk.ts (enterZoomMeeting). Every
// assertion that used to read `openLink(<zoom url>)` now reads those two
// calls, and `openLink` is asserted NEVER called. The guest branch inverted
// (owner decision 12: no guest entry from the app -- «Вы не записаны» and the
// way to the practice), and the host branch no longer sends the owner away:
// he starts right here. One view, two zones: routeName decides.
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
import { ApiResponseError } from '@/api/client'

const push = vi.fn()
const back = vi.fn()
const routeParams: { practiceId: string } = { practiceId: 'p1' }
const routeState: { name: string } = { name: 'practice-live' }
/** The guard the screen registers with onBeforeRouteLeave (F4). */
let leaveGuard: (() => boolean) | null = null
/** What router.resolve() would give for the two leaveUrl targets. */
function hrefFor(to: { name: string; params?: { practiceId?: string } }): string {
  if (to.name === 'user-feedback') return `/user/feedback/${to.params?.practiceId}`
  if (to.name === 'master-dashboard') return '/master/dashboard'
  throw new Error(`unexpected resolve target ${to.name}`)
}
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push,
    back,
    resolve: (to: { name: string; params?: { practiceId?: string } }) => ({ href: hrefFor(to) }),
  }),
  useRoute: () => ({ params: routeParams, name: routeState.name }),
  onBeforeRouteLeave: (fn: () => boolean) => {
    leaveGuard = fn
  },
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: toastInfo }),
}))

// T-35: the screen asks the server how THIS user enters. Mocked at the API
// boundary -- the decision under test on this side is what the screen RENDERS
// for each kind, not how the ladder is computed (that lives in the backend's
// resolve_zoom_entry and is proved by its own doubles).
const resolveZoomEntry = vi.fn()
const joinZoomSdk = vi.fn()
vi.mock('@/api/practices', () => ({
  resolveZoomEntry: (...args: Parameters<typeof resolveZoomEntry>) => resolveZoomEntry(...args),
  joinZoomSdk: (...args: Parameters<typeof joinZoomSdk>) => joinZoomSdk(...args),
}))

const openLink = vi.fn()
const hapticFeedback = vi.fn()
const platformFlags = { cameraBlocked: false }
vi.mock('@/platform', () => ({
  get platform() {
    return {
      name: 'standalone' as const,
      openLink,
      hapticFeedback,
      cameraBlockedByHost: () => platformFlags.cameraBlocked,
    }
  },
}))

// F4: the SDK boundary. Mocked as a module -- loading the real SDK in
// happy-dom would be both slow and meaningless; what this screen owns is
// WHAT it hands over and WHERE leaving goes, not Zoom's own client.
const enterZoomMeeting = vi.fn()
const leaveZoomMeeting = vi.fn()
const sdkState = { loaded: false }
vi.mock('@/platform/zoom-sdk', () => ({
  enterZoomMeeting: (...args: unknown[]) => enterZoomMeeting(...args),
  leaveZoomMeeting: () => leaveZoomMeeting(),
  zoomSdkLoaded: () => sdkState.loaded,
  appUrl: (path: string) => `https://app.test${path}`,
}))

/** The server's SDK parameters for an attendee (role 0). */
const ATTENDEE_JOIN = {
  sdk_key: 'sdk-key',
  signature: 'sig',
  meeting_number: '123456',
  password: 'pw',
  user_name: 'Ученик User',
  role: 0,
  tk: 'tk-abc',
  user_email: 'user-1@users.velo.invalid',
  zak: null,
}
/** The server's SDK parameters for the host (role 1). */
const HOST_JOIN = { ...ATTENDEE_JOIN, role: 1, tk: null, user_email: null, zak: 'zak-xyz' }

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
    has_reflection: false,
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
/** A button by its visible text -- the guest state's own button is primary
 * too, so «the entry button» is found by what it says. */
function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
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
  // Default: a booked user with a personal entry -- the ordinary case every
  // non-Zoom test in this file assumes. F4: the body carries `kind` only.
  resolveZoomEntry.mockReset()
  resolveZoomEntry.mockResolvedValue({ kind: 'personal' })
  joinZoomSdk.mockReset()
  joinZoomSdk.mockResolvedValue(ATTENDEE_JOIN)
  enterZoomMeeting.mockReset()
  enterZoomMeeting.mockResolvedValue(undefined)
  leaveZoomMeeting.mockReset()
  sdkState.loaded = false
  platformFlags.cameraBlocked = false
  routeState.name = 'practice-live'
  leaveGuard = null
  toastInfo.mockReset()
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
    it('personal: Войти enters THROUGH THE SDK with the server parameters, leaving to feedback -- no link is opened', async () => {
      // F4: this opened the personal link (openLink) -- right while Zoom was
      // outside. The same outcome now: the person whose attendance can be
      // recorded enters with HIS entry, inside VELO.
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      resolveZoomEntry.mockResolvedValue({ kind: 'personal' })
      mount()
      await flush()

      expect(enterBtn()?.disabled).toBe(false)
      enterBtn()?.click()
      await flush()
      expect(joinZoomSdk).toHaveBeenCalledWith('p1')
      expect(enterZoomMeeting).toHaveBeenCalledWith(
        ATTENDEE_JOIN,
        'https://app.test/user/feedback/p1',
      )
      expect(openLink).not.toHaveBeenCalled()
    })

    it('guest: «Вы не записаны» and the way to the practice -- NO entry inside the app (owner decision 12)', async () => {
      // F4 inverts what this asserted (a guest let in by the shared link):
      // the app offers no guest entry; booking is where the entry comes from.
      practicesState.selected = practice()
      bookingsState.bookings = []
      resolveZoomEntry.mockResolvedValue({ kind: 'guest' })
      mount()
      await flush()

      expect(emptyState()?.textContent).toContain('Вы не записаны')
      expect(buttonByText('Войти')).toBeUndefined()
      buttonByText('К практике')?.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'p1' } })
      expect(joinZoomSdk).not.toHaveBeenCalled()
      expect(openLink).not.toHaveBeenCalled()
    })

    it('pending: honest wait, button disabled, nothing entered -- a confirmed booking is NEVER downgraded to a guest entry (that is what produced the false NO_SHOW)', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'pending' })
      mount()
      await flush()

      expect(text()).toContain('Вход готовится')
      expect(enterBtn()?.disabled).toBe(true)
      enterBtn()?.click()
      await flush()
      expect(joinZoomSdk).not.toHaveBeenCalled()
    })

    it('failed: distinct from pending -- the permanent-failure copy, not the spinner copy', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'failed' })
      mount()
      await flush()

      expect(text()).toContain('Не удалось создать встречу')
      expect(text()).not.toContain('Вход готовится')
      expect(enterBtn()?.disabled).toBe(true)
    })

    it('host: the owner starts his meeting HERE, as host, leaving to his dashboard -- and is never handed a guest seat or the student actions', async () => {
      // F4: this told the owner to go and start from the master screen (the
      // start-ticket flow lived there). He now starts right here, inside VELO.
      practicesState.selected = practice()
      bookingsState.bookings = []
      resolveZoomEntry.mockResolvedValue({ kind: 'host' })
      joinZoomSdk.mockResolvedValue(HOST_JOIN)
      mount()
      await flush()

      expect(checkinBtn()).toBeNull()
      expect(leaveBtn()).toBeNull()
      buttonByText('Начать')?.click()
      await flush()
      expect(enterZoomMeeting).toHaveBeenCalledWith(HOST_JOIN, 'https://app.test/master/dashboard')
      expect(openLink).not.toHaveBeenCalled()
    })

    it('cancelled: honest state, no entry offered', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'cancelled' })
      mount()
      await flush()

      expect(emptyState()?.textContent).toContain('Практика отменена')
      expect(enterBtn()).toBeNull()
    })

    // Links (Д4): 'unavailable' fell into the generic «Войти» branch.
    it('unavailable: honest state, no «Войти» (a live booking whose entry will not come)', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'unavailable' })
      mount()
      await flush()

      expect(emptyState()?.textContent).toContain('Вход в Zoom недоступен')
      expect(emptyState()?.textContent).toContain('поддержку')
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
    it('a fresh booking (never joined): calls joinBooking, then haptic + the SDK entry (F4: was openLink)', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: true, error: '' })
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // entry (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(joinBooking).toHaveBeenCalledWith('b1')
      expect(toastError).not.toHaveBeenCalled()
      expect(hapticFeedback).toHaveBeenCalledWith('medium')
      expect(joinBooking.mock.invocationCallOrder[0]).toBeLessThan(
        joinZoomSdk.mock.invocationCallOrder[0]!,
      )
      expect(enterZoomMeeting).toHaveBeenCalledTimes(1)
      expect(openLink).not.toHaveBeenCalled()
    })

    it('shows the loading state on Войти while the join call is pending', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockReturnValue(new Promise(() => {})) // never resolves
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // entry (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(enterBtn()?.classList.contains('v-btn--loading')).toBe(true)
      expect(enterBtn()?.disabled).toBe(true)
    })

    it('an ALREADY-joined booking (joined_at already set): skips calling joinBooking and enters Zoom directly', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: '2026-07-20T09:00:00Z' })]
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // entry (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(joinBooking).not.toHaveBeenCalled()
      expect(enterZoomMeeting).toHaveBeenCalledTimes(1)
    })

    it('the documented 409 "already joined" case (keyed on the machine status, FE-78.2): toast is suppressed, Zoom is still entered', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: false, error: 'Вы уже записаны', status: 409 })
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // entry (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(toastError).not.toHaveBeenCalled()
      expect(enterZoomMeeting).toHaveBeenCalledTimes(1)
    })

    it('a REAL join failure (non-409) still toasts; Zoom is still entered -- FE-78.2 scoped the fix to the toast gate only', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ id: 'b1', joined_at: null })]
      joinBooking.mockResolvedValue({ ok: false, error: 'Practice is full', status: 400 })
      mount()
      // T-35: the button is disabled until the server's resolution arrives --
      // it can no longer be pressed on a screen that has not been told what
      // entry (if any) this person gets.
      await flush()

      enterBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Practice is full')
      expect(enterZoomMeeting).toHaveBeenCalledTimes(1)
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
  // ===========================================================================
  // Standalone F4: entering through the Meeting SDK -- the refusals, the SDK
  // failing, the camera hint, the master zone, leaving while inside.
  describe('F4: Zoom inside the app', () => {
    it('zoom_sdk_not_configured: the screen SAYS so instead of a button that cannot work', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      joinZoomSdk.mockRejectedValue(
        new ApiResponseError(409, 'not configured', 'zoom_sdk_not_configured'),
      )
      mount()
      await flush()

      enterBtn()?.click()
      await flush()
      await flush()

      expect(emptyState()?.textContent).toContain('Zoom внутри приложения не настроен')
      expect(buttonByText('Войти')).toBeUndefined()
      expect(enterZoomMeeting).not.toHaveBeenCalled()
    })

    it('zoom_entry_not_joinable: the state changed under us -- re-resolve and show the new one', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      joinZoomSdk.mockRejectedValue(
        new ApiResponseError(409, 'not joinable', 'zoom_entry_not_joinable'),
      )
      mount()
      await flush()
      resolveZoomEntry.mockResolvedValue({ kind: 'cancelled' })

      enterBtn()?.click()
      await flush()
      await flush()

      expect(resolveZoomEntry).toHaveBeenCalledTimes(2)
      expect(toastInfo).toHaveBeenCalledWith('Состояние практики изменилось')
      expect(emptyState()?.textContent).toContain('Практика отменена')
      expect(enterZoomMeeting).not.toHaveBeenCalled()
    })

    it('Zoom did not answer (502 zoom_unavailable): its phrase, the button is usable again', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      joinZoomSdk.mockRejectedValue(new ApiResponseError(502, 'zoom down', 'zoom_unavailable'))
      mount()
      await flush()

      enterBtn()?.click()
      await flush()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Zoom не ответил. Попробуйте ещё раз через минуту')
      expect(enterBtn()?.disabled).toBe(false)
      expect(enterZoomMeeting).not.toHaveBeenCalled()
    })

    it('the SDK itself fails to load or join: an honest toast, never a silent stall', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      enterZoomMeeting.mockRejectedValue(new Error('Zoom SDK load failed'))
      mount()
      await flush()

      enterBtn()?.click()
      await flush()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось открыть Zoom. Попробуйте ещё раз')
      expect(enterBtn()?.disabled).toBe(false)
    })

    it('REPEAT: a second press while the first is in flight asks the server once', async () => {
      practicesState.selected = practice()
      bookingsState.bookings = [booking({ joined_at: '2026-07-20T10:00:00Z' })]
      joinZoomSdk.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      enterBtn()?.click()
      enterBtn()?.click()
      await flush()

      expect(joinZoomSdk).toHaveBeenCalledTimes(1)
    })

    it('camera hint: shown where the host app blocks the camera and an entry is on screen', async () => {
      platformFlags.cameraBlocked = true
      practicesState.selected = practice()
      resolveZoomEntry.mockResolvedValue({ kind: 'personal' })
      mount()
      await flush()

      expect(text()).toContain('Чтобы включить камеру, откройте VELO с рабочего стола')
    })

    it('camera hint: the host too -- the master needs the camera most', async () => {
      platformFlags.cameraBlocked = true
      practicesState.selected = practice()
      resolveZoomEntry.mockResolvedValue({ kind: 'host' })
      mount()
      await flush()

      expect(text()).toContain('Чтобы включить камеру, откройте VELO с рабочего стола')
    })

    it('camera hint: NOT shown where the camera works, nor where there is no entry at all', async () => {
      platformFlags.cameraBlocked = false
      resolveZoomEntry.mockResolvedValue({ kind: 'personal' })
      mount()
      await flush()
      expect(text()).not.toContain('Чтобы включить камеру')
      app?.unmount()
      host?.remove()

      platformFlags.cameraBlocked = true
      resolveZoomEntry.mockResolvedValue({ kind: 'cancelled' })
      mount()
      await flush()
      expect(text()).not.toContain('Чтобы включить камеру')
    })

    it('master zone: back goes to the master dashboard, and no student actions are shown', async () => {
      routeState.name = 'master-practice-live'
      practicesState.selected = practice()
      resolveZoomEntry.mockResolvedValue({ kind: 'host' })
      mount()
      await flush()

      expect(checkinBtn()).toBeNull()
      expect(leaveBtn()).toBeNull()
      backBtn()?.click()
      expect(push).toHaveBeenCalledWith({ name: 'master-dashboard' })
    })

    it("master zone hides the student actions for ANY answer, not only host (a master booked into another master's practice)", async () => {
      routeState.name = 'master-practice-live'
      practicesState.selected = practice()
      bookingsState.bookings = [booking()]
      resolveZoomEntry.mockResolvedValue({ kind: 'personal' })
      mount()
      await flush()

      expect(buttonByText('Войти')).toBeDefined()
      expect(checkinBtn()).toBeNull()
      expect(leaveBtn()).toBeNull()
    })

    it('leaving the screen while INSIDE the meeting leaves the meeting instead (its leaveUrl reloads the app)', async () => {
      mount()
      await flush()
      expect(leaveGuard).not.toBeNull()

      sdkState.loaded = false
      expect(leaveGuard!()).toBe(true)
      expect(leaveZoomMeeting).not.toHaveBeenCalled()

      sdkState.loaded = true
      expect(leaveGuard!()).toBe(false)
      expect(leaveZoomMeeting).toHaveBeenCalledTimes(1)
    })
  })
})
