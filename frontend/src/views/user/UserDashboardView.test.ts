// =============================================================================
// VELO Frontend -- UserDashboardView Screen Tests (probekit-screen-test v1.9)
// =============================================================================
//
// The user's main screen (rank #1 of the untested user queue, 590 lines). Three
// independent alert banners, a live-aware nearest-practice list, and a progress/
// AI-summary pair -- all derived from two data seams into one screen with no
// state of its own beyond a 60s clock ref.
//
// PATTERN: hybrid, but NOT the skill's canonical Pattern C (store + local
// FORM) -- this is store-backed DATA (bookings, via a REAL useBookingsStore)
// alongside a SECOND, independently-fetched local-ref DATA half (`stats`, a
// direct getMyStats() call in the screen's own onMounted, .vue:230,422-428).
// Both halves route through the SAME module, @/api/bookings, which is why one
// `vi.mock('@/api/bookings')` seams everything -- but the skill's warning still
// applies in a different shape here: the module exports THREE independent
// functions (getMyBookings, getUpcomingBookings, getMyStats) and mocking one
// while forgetting another does not throw, it silently returns `undefined` from
// an unconfigured vi.fn() auto-mock. `await undefined` resolves to `undefined`,
// stats.value ends up undefined, and attendedCount's `?? 0` fallback renders
// the SAME "0" a real empty stats payload would -- a forgotten mock and a
// genuine zero are indistinguishable on screen. Every test below that reads a
// non-zero stat value is therefore proof the seam is read, not just defaulted.
//
// A THIRD trap, found only by reading stores/bookings.ts (.vue:221,237-292 vs
// .vue:315-317): checkinAlert/feedbackAlert/reflectionAlert search
// `bookingsStore.bookings` (the PAGINATED list, fed by getMyBookings via
// fetchMyBookings/pagination.refresh), while the nearest-practice section reads
// `bookingsStore.upcoming` (a SEPARATE list from a SEPARATE endpoint,
// getUpcomingBookings via fetchUpcoming). These are deliberately given
// DIFFERENT booking IDs below (bk_* for banners, up_* for nearest) so a mixed-up
// wire (a banner accidentally reading `upcoming`, or vice versa) would produce a
// visibly wrong id/title rather than an accidental pass.
//
// TIME IS PINNED to 2026-07-20T12:00:00Z with fake timers -- this screen reads
// the wall clock in FOUR places that decide what renders: the reactive `now`
// ref + 60s setInterval (.vue:225-226,459-461) driving isInCheckinWindow/
// isInFeedbackWindow/isLiveNow; and formatDateShort/dayLabelOf internally
// compare against `new Date()` for "Сегодня"/"Завтра" (utils/format.ts:67,176).
// All fixture datetimes are literals relative to that frozen instant.
//
// VIEWER TIMEZONE: the profile timezone is 'Europe/Moscow' (UTC+3), not 'UTC'
// -- every practice below is UTC, so a screen that silently defaulted to UTC
// instead of reading authStore.user.timezone (useViewerTimezone.ts:31) would
// still produce plausible-looking but WRONG times, and a UTC fixture could
// not have caught it. useViewerTimezone reads a REAL useAuthStore, set
// directly (.user = user()) rather than mocked -- .vue:390 only reads it, not
// @/api/users, so no third API module needs mocking for this.
//
// THE ERROR RUNG IS A TOAST, NOT INLINE (W15 fix, .vue:452-456) -- and the DOM
// does NOT distinguish it from the empty state: upcomingError only ever
// surfaces via toast.error() in onMounted's .then(); the template's v-else-if
// for "nothing upcoming" is driven purely by `nearestBookings.length === 0`,
// which is equally true whether the fetch returned [] on purpose or crashed and
// the store's catch block set `upcoming.value = []` (stores/bookings.ts:149).
// The "empty" and "error" tests below therefore assert the SAME DOM state and
// differ ONLY in whether toast.error fired and with what message -- that is
// the whole point of W15, and a test that checked only the DOM could not tell
// the two apart (exactly the bug W15 fixed).
//
// isInCheckinWindow / isInFeedbackWindow (composables/usePracticeWindows.ts)
// have NO existing unit test of their own (grepped: no usePracticeWindows.test.ts
// in the repo) -- this file is currently the ONLY place their boundary behavior
// is exercised, via the three banners. Each window is proven from both sides
// (in-window shows the banner, out-of-window does not), per the operator's
// explicit ask, not because the skill demands it for every dependency.
//
// v-if throughout (grepped: zero v-show in this template or its direct
// children -- Banner.vue, PracticeListCard.vue, VCard.vue, VStatCard.vue,
// VBadge.vue), so SC-14 does not apply and host.textContent is always exactly
// what is currently rendered.
//
// TRAP SURFACES CHECKED ABSENT (Step 4 -- proving absence, not just silence):
// grepped this screen and its direct children for Teleport/VBottomSheet/VModal
// (SC-13), window.location, navigator.clipboard, window.history.state,
// IntersectionObserver/ResizeObserver, scrollHeight, getComputedStyle,
// waitUntilReady, and formatMoney -- ZERO hits on every one. No overlay reap,
// no clipboard/location/history stubs, no NBSP-in-money guard needed. Intl's
// date/time formatters can still emit U+00A0 on some ICU builds, so norm() is
// kept anyway -- it costs nothing and the trap does not announce itself before
// it bites (velo-idiom §11, §4 pattern).
//
// PLATFORM MOCK uses a GETTER over a mutable module-scope object, not a bare
// literal (velo-idiom §5, precedent MasterDashboardView.test.ts:133-142) --
// `vi.mock` factories are hoisted above this file's consts, and stores/auth.ts
// imports @/platform eagerly (this screen does too, .vue:206), so a bare
// `openLink: openLinkSpy` reference would throw "Cannot access before
// initialization" the moment the .vue module (which imports the auth store
// transitively via useViewerTimezone) is imported.
//
// GUARD: user-dashboard has no PER-ROUTE beforeEnter of its own (grepped
// router/index.ts) -- role routing lives entirely in the root `roleRedirect`
// guard, already covered exhaustively by router/guards.test.ts. Not duplicated
// here; a screen test's job is the screen, and this route sits behind a guard
// this file does not own.
//
// No order dependence: every test mounts its own app + fresh Pinia; declaration
// order is execution order (no shuffle configured) but nothing here relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import UserDashboardView from '@/views/user/UserDashboardView.vue'
import * as bookingsApi from '@/api/bookings'
import { useAuthStore } from '@/stores/auth'
import { useBookingsStore } from '@/stores/bookings'
import { ApiResponseError } from '@/api/client'
import type {
  BookingWithPracticeResponse,
  PaginatedBookingsResponse,
  PracticeSummary,
  UserResponse,
  UserStatsResponse,
} from '@/api/types'

// Auto-mock: every export becomes an unconfigured vi.fn() until .mockResolvedValue
// is set per-test. No non-function export needs preserving here (ApiResponseError
// lives in @/api/client, untouched -- imported directly below, real class).
vi.mock('@/api/bookings')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: vi.fn() }),
}))

// Getter over a mutable module-scope object -- see banner. TDZ-safe against
// stores/auth.ts's eager `import { platform } from '@/platform'`.
const platformState = { openLink: vi.fn() }
vi.mock('@/platform', () => ({
  platform: {
    name: 'standalone',
    get openLink() {
      return platformState.openLink
    },
    close: vi.fn(),
  },
}))

// -----------------------------------------------------------------------------
// The frozen instant + the viewer's (non-UTC) profile timezone
// -----------------------------------------------------------------------------

const NOW = new Date('2026-07-20T12:00:00Z')
const VIEWER_TZ = 'Europe/Moscow' // UTC+3, fixed (no DST) -- distinct from every fixture's UTC scheduled_at

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Аня',
    last_name: null,
    avatar_url: null,
    timezone: VIEWER_TZ,
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: false,
    phone: null,
    bio: null,
    email: null,
    notifications: {} as UserResponse['notifications'],
    master_notifications: null,
    role_switch: null,
    ...overrides,
  }
}

function practice(id: string, overrides: Partial<PracticeSummary> = {}): PracticeSummary {
  return {
    id,
    title: `Практика ${id}`,
    practice_type: 'live',
    status: 'scheduled',
    scheduled_at: '2026-07-25T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    master_id: 'master_1',
    master_name: 'Мастер',
    direction: null,
    is_free: false,
    price_cents: 1000,
    currency: 'EUR',
    zoom_link: null,
    ...overrides,
  }
}

function booking(
  id: string,
  overrides: Partial<BookingWithPracticeResponse> = {},
  practiceOverrides: Partial<PracticeSummary> = {},
): BookingWithPracticeResponse {
  return {
    id,
    practice_id: `pr_${id}`,
    user_id: 'user_1',
    status: 'confirmed',
    purchase_id: 'purchase_1',
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
    practice: practice(`pr_${id}`, practiceOverrides),
  }
}

function page(items: BookingWithPracticeResponse[], total = items.length): PaginatedBookingsResponse {
  return { items, total, limit: 20, offset: 0 }
}

function stats(overrides: Partial<UserStatsResponse> = {}): UserStatsResponse {
  return { practices_attended: 7, hours_attended: 5.5, ...overrides }
}

// -- Nearest-practice fixtures (bookingsStore.upcoming, getUpcomingBookings) --
// UP_LIVE: started 10 min ago, still running (ends 12:50Z) -> isLiveNow TRUE
// client-time, but backend practice.status stays 'scheduled' -- proves the
// badge (client-time) and the click-routing (backend status) are genuinely
// two different signals, not one relabeled.
const UP_LIVE = booking(
  'up_live',
  { status: 'confirmed' },
  {
    title: 'Утренняя практика (эфир)',
    scheduled_at: '2026-07-20T11:50:00Z',
    duration_minutes: 60,
    status: 'scheduled',
    is_free: false,
    zoom_link: 'https://zoom.us/j/live1',
  },
)
// UP_SOON: tomorrow, free, no zoom link yet, already checked in -- exercises
// the free badge, the Zoom-disabled state, and the Check-in-disabled state on
// ONE card (has_checkin true).
const UP_SOON = booking(
  'up_soon',
  { status: 'confirmed', has_checkin: true },
  {
    title: 'Завтрашняя практика',
    scheduled_at: '2026-07-21T05:00:00Z',
    duration_minutes: 45,
    is_free: true,
    zoom_link: null,
  },
)

// -- Banner fixtures (bookingsStore.bookings, getMyBookings) -- DIFFERENT ids
// from the up_* set on purpose (see banner).
const CHECKIN_IN = booking(
  'bk_checkin',
  { status: 'confirmed', has_checkin: false, checkin_skipped: false },
  { title: 'Вечерняя практика', scheduled_at: '2026-07-20T14:00:00Z', duration_minutes: 60 },
)
// +30h -- outside the 24h check-in window (window opens at scheduled-24h).
const CHECKIN_OUT = booking(
  'bk_checkin_out',
  { status: 'confirmed', has_checkin: false, checkin_skipped: false },
  { title: 'Далёкая практика', scheduled_at: '2026-07-21T18:00:00Z', duration_minutes: 60 },
)
const FEEDBACK_IN = booking(
  'bk_feedback',
  { status: 'attended', has_feedback: false },
  // ends 11:00Z, NOW=12:00Z -> 1h into the 72h feedback window.
  { title: 'Утренняя практика', scheduled_at: '2026-07-20T10:00:00Z', duration_minutes: 60 },
)
// Ended 2026-07-16T09:00Z; feedback window closed at +72h = 2026-07-19T09:00Z,
// well before NOW -- window is OVER, not "hasn't started".
const FEEDBACK_OUT = booking(
  'bk_feedback_out',
  { status: 'attended', has_feedback: false },
  { title: 'Старая практика', scheduled_at: '2026-07-16T08:00:00Z', duration_minutes: 60 },
)
// practice_id is the TOP-LEVEL booking field pickReflectionVariant reads
// (.vue:68 -- reflectionAlert.practice_id, NOT practice.id), fixed to a value
// whose stableHash lands on index 0 (VARIANT_WELLBEING) so the expected
// banner title is a known literal, not a guess.
const REFLECT_IN = booking(
  'bk_reflect',
  { status: 'no_show', practice_id: 'practice_r1' },
  { title: 'Дневная практика', scheduled_at: '2026-07-20T10:00:00Z', duration_minutes: 60 },
)
const REFLECT_OUT = booking(
  'bk_reflect_out',
  { status: 'no_show', practice_id: 'practice_r1' },
  { title: 'Старая практика', scheduled_at: '2026-07-16T08:00:00Z', duration_minutes: 60 },
)

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// SAME pinia instance to setActivePinia AND app.use (SC-03) -- two instances
// means the test drives one store while the screen renders another.
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserDashboardView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). Three INDEPENDENT chains fire in
// onMounted (.vue:450-461), none awaited by the caller:
//   fetchMyBookings()  -> pagination.refresh() -> reset() (sync) + await
//                          loadMore() -> await fetchFn (1) -> re-render (1)
//   fetchUpcoming()...
//     .then(cb)         -> await getUpcomingBookings (1) -> fetchUpcoming's
//                          own promise settles (1) -> the .then() continuation
//                          runs, calling toast.error when it applies (1) ->
//                          re-render (1)
//   loadStats()          -> await getMyStats (1) -> re-render (1)
// Deepest is the fetchUpcoming+.then() chain at ~4. Rounded well up (over-
// counting is harmless, under-counting fails loudly -- velo-idiom §3).
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

// Intl can emit U+00A0/U+202F/U+2009 depending on ICU build (velo-idiom §11) --
// flattened defensively even though no money is formatted on this screen.
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[   ]/g, ' ')
}
function text(): string {
  return norm(host?.textContent)
}

function loader(): HTMLElement | null {
  return host?.querySelector('.dashboard__loader') ?? null
}
function emptyState(): HTMLElement | null {
  return host?.querySelector('.dashboard__empty') ?? null
}
function emptyCta(): HTMLButtonElement | undefined {
  return Array.from(emptyState()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Найти практику',
  )
}
function nearestBlocks(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.dashboard__nearest-item') ?? [])
}
function titleOf(b: HTMLElement): string {
  return norm(b.querySelector('.practice-list-card__title')?.textContent).trim()
}
function badgeOf(b: HTMLElement): string {
  return norm(b.querySelector('.v-badge')?.textContent).trim()
}
function whenOf(b: HTMLElement): string {
  return norm(b.querySelector('.practice-list-card__when')?.textContent).trim()
}
function durOf(b: HTMLElement): string {
  return norm(b.querySelector('.practice-list-card__dur')?.textContent).trim()
}
function cardOf(b: HTMLElement): HTMLElement {
  const card = b.querySelector<HTMLElement>('.practice-list-card')
  if (!card) throw new Error('the practice card did not render')
  return card
}
function actionIn(b: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(
    b.querySelectorAll<HTMLButtonElement>('.dashboard__practice-actions button'),
  ).find((btn) => btn.textContent?.trim() === label)
}
function banners(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.banner') ?? [])
}
function bannerTitled(t: string): HTMLElement | undefined {
  return banners().find((b) => b.querySelector('.banner__title')?.textContent?.trim() === t)
}
function bannerBody(b: HTMLElement): string {
  return norm(b.querySelector('.banner__body')?.textContent).trim()
}
function statCard(label: string): HTMLElement {
  const card = Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? []).find(
    (c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label,
  )
  if (!card) throw new Error(`no stat card labelled «${label}»`)
  return card
}
function statValue(label: string): string {
  return norm(statCard(label).querySelector('.v-stat__value')?.textContent).trim()
}
function aiCard(): HTMLElement {
  const card = host?.querySelector<HTMLElement>('.v-card')
  if (!card) throw new Error('the AI-summary card did not render')
  return card
}
function aiMood(): HTMLElement | null {
  return host?.querySelector('.dashboard__ai-mood') ?? null
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(bookingsApi.getMyBookings).mockReset().mockResolvedValue(page([]))
  vi.mocked(bookingsApi.getUpcomingBookings).mockReset().mockResolvedValue([])
  vi.mocked(bookingsApi.getMyStats).mockReset().mockResolvedValue(stats())

  useAuthStore().user = user()

  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
  platformState.openLink.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // No teleport on this screen (see banner) -- purge kept unconditional and
  // idempotent anyway, per SC-13's own precedent, in case that ever changes.
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('UserDashboardView', () => {
  // ===========================================================================
  describe('nearest-practices ladder', () => {
    it('loading: shows the loader and nothing else while upcoming is in flight', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(loader()).not.toBeNull()
      expect(emptyState()).toBeNull()
      expect(nearestBlocks()).toHaveLength(0)
    })

    it('empty: a genuinely empty result shows the empty state and does NOT toast', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([])
      mount()
      await flush()

      expect(loader()).toBeNull()
      expect(emptyState()).not.toBeNull()
      expect(text()).toContain('Нет предстоящих практик')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('error: renders the SAME empty DOM as a genuine empty result, but toasts the REAL backend message (W15, empty != error)', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockRejectedValue(
        new ApiResponseError(503, 'Сервис бронирований недоступен', 'service_unavailable'),
      )
      mount()
      await flush()

      // Same DOM shape as the empty test above -- the distinguishing signal is
      // the toast, not the markup (that IS the W15 fix; see banner).
      expect(emptyState()).not.toBeNull()
      expect(text()).toContain('Нет предстоящих практик')
      expect(toastError).toHaveBeenCalledWith('Сервис бронирований недоступен')
    })

    it('error fallback: a non-ApiResponseError toasts the fallback, not a raw exception message (SC-05)', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить ближайшую практику')
    })

    it('content: renders both cards with real dates/times/badges, live pinned first', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_SOON, UP_LIVE])
      mount()
      await flush()

      const blocks = nearestBlocks()
      expect(blocks).toHaveLength(2)
      // selectNearestBookings pins the active session first regardless of input order.
      expect(titleOf(blocks[0]!)).toBe('Утренняя практика') // "(эфир)" suffix stripped
      expect(badgeOf(blocks[0]!)).toBe('В эфире')
      expect(whenOf(blocks[0]!)).toBe('Сегодня')
      expect(durOf(blocks[0]!)).toContain('14:50')
      expect(durOf(blocks[0]!)).toContain('1 час')

      expect(titleOf(blocks[1]!)).toBe('Завтрашняя практика')
      expect(badgeOf(blocks[1]!)).toBe('Бесплатно')
      expect(whenOf(blocks[1]!)).toBe('Завтра')
      expect(durOf(blocks[1]!)).toContain('08:00')
    })
  })

  // ===========================================================================
  describe('nearest-practice actions', () => {
    it('Zoom: opens the real https link through the platform, not window.open', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_LIVE])
      mount()
      await flush()

      actionIn(nearestBlocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(platformState.openLink).toHaveBeenCalledWith('https://zoom.us/j/live1')
    })

    it('Zoom: disabled (not just unlinked) when the practice has no valid link', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_SOON])
      mount()
      await flush()

      const zoomBtn = actionIn(nearestBlocks()[0]!, 'Zoom')
      expect(zoomBtn?.disabled).toBe(true)
      // A disabled <button> does not dispatch click to its handler (native DOM
      // behaviour, not a test convention) -- proven, not asserted from the
      // attribute alone.
      zoomBtn?.click()
      await flush()
      expect(platformState.openLink).not.toHaveBeenCalled()
    })

    // -- D3 link ladder (T21-1, ПРОМТ №541) --
    it('Zoom: a personal registrant link takes priority over the manual zoom_link', async () => {
      const withPersonal = booking(
        'up_personal',
        { status: 'confirmed', zoom_registrant_join_url: 'https://zoom.us/w/personal?tk=abc' },
        { scheduled_at: '2026-07-20T11:50:00Z', duration_minutes: 60, zoom_link: 'https://zoom.us/j/live1' },
      )
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([withPersonal])
      mount()
      await flush()

      actionIn(nearestBlocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(platformState.openLink).toHaveBeenCalledWith('https://zoom.us/w/personal?tk=abc')
    })

    it('Zoom: no personal link but a valid manual zoom_link -- button enabled, "not counted" mark shown', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_LIVE]) // no zoom_registrant_join_url
      mount()
      await flush()

      expect(actionIn(nearestBlocks()[0]!, 'Zoom')?.disabled).toBe(false)
      expect(host?.textContent).toContain('посещение не засчитается')
    })

    it('Zoom: a personal link present -- the "not counted" mark does not show', async () => {
      const withPersonal = booking(
        'up_personal2',
        { status: 'confirmed', zoom_registrant_join_url: 'https://zoom.us/w/personal?tk=abc' },
        { scheduled_at: '2026-07-20T11:50:00Z', duration_minutes: 60, zoom_link: 'https://zoom.us/j/live1' },
      )
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([withPersonal])
      mount()
      await flush()

      expect(host?.textContent).not.toContain('посещение не засчитается')
    })

    // A4 V2 (ПРОМТ №572): before this, create_failed and pending_creation
    // both rendered as the SAME disabled Zoom button with no explanation --
    // a participant could not tell "still preparing" from "will never
    // happen unless the master acts".
    it('Zoom: create_failed -- disabled AND the honest failure badge shows, distinct from a plain unlinked practice', async () => {
      const failedMeeting = booking(
        'up_failed',
        { status: 'confirmed', zoom_registrant_join_url: null },
        {
          scheduled_at: '2026-07-20T11:50:00Z',
          duration_minutes: 60,
          zoom_link: null,
          zoom_meeting_status: 'create_failed',
        },
      )
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([failedMeeting])
      mount()
      await flush()

      expect(actionIn(nearestBlocks()[0]!, 'Zoom')?.disabled).toBe(true)
      expect(host?.textContent).toContain('Не удалось создать встречу')
    })

    it('Zoom: pending_creation stays a plain disabled button -- no failure badge', async () => {
      const pending = booking(
        'up_pending',
        { status: 'confirmed', zoom_registrant_join_url: null },
        {
          scheduled_at: '2026-07-20T11:50:00Z',
          duration_minutes: 60,
          zoom_link: null,
          zoom_meeting_status: 'pending_creation',
        },
      )
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([pending])
      mount()
      await flush()

      expect(actionIn(nearestBlocks()[0]!, 'Zoom')?.disabled).toBe(true)
      expect(host?.textContent).not.toContain('Не удалось создать встречу')
    })

    it('Check-in: disabled when the booking already has one, enabled otherwise', async () => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_SOON, UP_LIVE])
      mount()
      await flush()

      const blocks = nearestBlocks()
      // blocks[0] is UP_LIVE (pinned live-first) -- has_checkin false -> enabled.
      const liveCheckin = actionIn(blocks[0]!, 'Check-in')
      expect(liveCheckin?.disabled).toBe(false)
      // blocks[1] is UP_SOON -- has_checkin true -> disabled.
      const soonCheckin = actionIn(blocks[1]!, 'Check-in')
      expect(soonCheckin?.disabled).toBe(true)

      liveCheckin?.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'user-checkin', params: { practiceId: 'pr_up_live' } })
    })

    it('card click: routes by BACKEND status (practice-live), not the client-time badge', async () => {
      const liveBackend = booking(
        'up_backend_live',
        { status: 'confirmed' },
        { title: 'Идёт сейчас', scheduled_at: '2026-07-20T11:55:00Z', duration_minutes: 60, status: 'live' },
      )
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([liveBackend])
      mount()
      await flush()

      cardOf(nearestBlocks()[0]!).click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'practice-live', params: { practiceId: 'pr_up_backend_live' } })
    })

    it('card click: routes to practice-detail when backend status is not live, even while the badge shows "В эфире"', async () => {
      // UP_LIVE is client-time live (badge shows it) but backend status stays
      // 'scheduled' -- .vue:365-368 documents this as deliberate, not a bug.
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_LIVE])
      mount()
      await flush()

      expect(badgeOf(nearestBlocks()[0]!)).toBe('В эфире')
      cardOf(nearestBlocks()[0]!).click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'pr_up_live' } })
    })

    it('badge: "Оплачено" for a paid, non-live upcoming booking', async () => {
      const paid = booking(
        'up_paid',
        { status: 'confirmed' },
        { title: 'Платная практика', scheduled_at: '2026-07-22T09:00:00Z', duration_minutes: 60, is_free: false },
      )
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([paid])
      mount()
      await flush()

      expect(badgeOf(nearestBlocks()[0]!)).toBe('Оплачено')
    })

    it('empty state CTA routes to the calendar', async () => {
      mount()
      await flush()

      expect(emptyCta()).toBeDefined()
      emptyCta()?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-calendar' })
    })
  })

  // ===========================================================================
  describe('check-in banner', () => {
    it('in-window: shows the banner with the real countdown and navigates on click', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([CHECKIN_IN]))
      mount()
      await flush()

      const b = bannerTitled('Пора на check-in!')
      expect(b).toBeDefined()
      expect(bannerBody(b!)).toBe('Вечерняя практика • через 2 ч')

      b!.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'user-checkin', params: { practiceId: 'pr_bk_checkin' } })
    })

    it('out-of-window: does not show (too early, outside the 24h check-in window)', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([CHECKIN_OUT]))
      mount()
      await flush()

      expect(bannerTitled('Пора на check-in!')).toBeUndefined()
    })

    it('hidden once already checked in, even inside the window', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(
        page([{ ...CHECKIN_IN, has_checkin: true }]),
      )
      mount()
      await flush()

      expect(bannerTitled('Пора на check-in!')).toBeUndefined()
    })

    it('hidden when the user persistently skipped this booking (checkin_skipped, B2)', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(
        page([{ ...CHECKIN_IN, checkin_skipped: true }]),
      )
      mount()
      await flush()

      expect(bannerTitled('Пора на check-in!')).toBeUndefined()
    })

    it('hidden when dismissed THIS SESSION (store state, driven directly per Pattern A idiom)', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([CHECKIN_IN]))
      mount()
      // Real store, real action -- proves the screen reads dismissedCheckins,
      // not that dismissCheckin itself works (that lives elsewhere).
      useBookingsStore().dismissCheckin('pr_bk_checkin')
      await flush()

      expect(bannerTitled('Пора на check-in!')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('feedback banner', () => {
    it('in-window: shows the banner with the real day label and navigates on click', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([FEEDBACK_IN]))
      mount()
      await flush()

      const b = bannerTitled('Оставьте feedback!')
      expect(b).toBeDefined()
      expect(bannerBody(b!)).toBe('Утренняя практика • Сегодня')

      b!.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'user-feedback', params: { practiceId: 'pr_bk_feedback' } })
    })

    it('out-of-window: does not show once the 72h window has closed', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([FEEDBACK_OUT]))
      mount()
      await flush()

      expect(bannerTitled('Оставьте feedback!')).toBeUndefined()
    })

    it('hidden once feedback is already left, even inside the window', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(
        page([{ ...FEEDBACK_IN, has_feedback: true }]),
      )
      mount()
      await flush()

      expect(bannerTitled('Оставьте feedback!')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('reflection banner (no-show)', () => {
    it('in-window: shows the DETERMINISTIC variant for its practiceId and navigates on click', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([REFLECT_IN]))
      mount()
      await flush()

      // 'practice_r1' hashes to variant index 0 -- see fixture comment.
      const b = bannerTitled('Как ваше самочувствие?')
      expect(b).toBeDefined()
      expect(bannerBody(b!)).toBe('Дневная практика • Сегодня')

      b!.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'user-reflection', params: { practiceId: 'practice_r1' } })
    })

    it('out-of-window: does not show once the window has closed', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([REFLECT_OUT]))
      mount()
      await flush()

      expect(bannerTitled('Как ваше самочувствие?')).toBeUndefined()
    })

    it('hidden when dismissed this session (localStorage-persisted dismissal, driven directly)', async () => {
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([REFLECT_IN]))
      mount()
      useBookingsStore().dismissReflection('practice_r1')
      await flush()

      expect(bannerTitled('Как ваше самочувствие?')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('the 60s clock', () => {
    it('a check-in banner appears the moment the window opens, with no reload', async () => {
      // CHECKIN_OUT opens its window at scheduled-24h = 2026-07-20T18:00:00Z.
      // Advance system time there and let the screen's own interval re-evaluate.
      vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page([CHECKIN_OUT]))
      mount()
      await flush()
      expect(bannerTitled('Пора на check-in!')).toBeUndefined()

      vi.setSystemTime(new Date('2026-07-20T18:00:01Z'))
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()

      expect(bannerTitled('Пора на check-in!')).toBeDefined()
    })
  })

  // ===========================================================================
  describe('progress stats + AI summary', () => {
    it('renders the REAL fetched numbers (not the silent-degrade default) in both the progress cards and the AI text', async () => {
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue(stats({ practices_attended: 12, hours_attended: 9 }))
      mount()
      await flush()

      expect(statValue('Практик пройдено')).toBe('12')
      expect(statValue('Часов в практике')).toBe('9')
      expect(text()).toContain('вы посетили')
      expect(text()).toContain('12')
    })

    it('half-decimal hours render with a comma, not a dot (ru locale)', async () => {
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue(stats({ hours_attended: 5.5 }))
      mount()
      await flush()

      expect(statValue('Часов в практике')).toBe('5,5')
    })

    it('silent degrade to 0/0 on a failed stats fetch -- no error rung by design (loadStats swallows, .vue:422-428)', async () => {
      vi.mocked(bookingsApi.getMyStats).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      expect(statValue('Практик пройдено')).toBe('0')
      expect(statValue('Часов в практике')).toBe('0')
      // No error rung exists for this section by design -- confirming ABSENCE,
      // not skipping the check.
      expect(host?.querySelector('.dashboard__stats-grid .dashboard__error')).toBeNull()
    })

    it('mood trend indicator: hidden at zero attended, shown once attended > 0', async () => {
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue(stats({ practices_attended: 0 }))
      mount()
      await flush()
      expect(aiMood()).toBeNull()

      app?.unmount()
      host?.remove()
      pinia = createPinia()
      setActivePinia(pinia)
      useAuthStore().user = user()
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue(stats({ practices_attended: 3 }))
      mount()
      await flush()
      expect(aiMood()).not.toBeNull()
    })

    it('the AI-summary card navigates on click (whole card is the tap target)', async () => {
      mount()
      await flush()

      aiCard().click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-ai-summary' })
    })
  })

  // ===========================================================================
  describe('viewer timezone', () => {
    it('renders practice times in the VIEWER profile timezone, not UTC', async () => {
      // UP_LIVE is 11:50Z; in the viewer's UTC+3 Moscow profile that is 14:50 --
      // a UTC-defaulting bug would render 11:50 instead, and this fixture is
      // the only thing that could catch it (both times "look like" a time).
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([UP_LIVE])
      mount()
      await flush()

      expect(durOf(nearestBlocks()[0]!)).toContain('14:50')
      expect(durOf(nearestBlocks()[0]!)).not.toContain('11:50')
    })
  })
})
