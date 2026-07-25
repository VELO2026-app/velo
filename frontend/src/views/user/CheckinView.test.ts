// =============================================================================
// VELO Frontend -- CheckinView Screen Tests
// =============================================================================
//
// WHY: this screen is the user zone's only WRITE that the UI refuses to let you
// take back. `POST /practices/{id}/checkin` records how you felt before a
// practice, and the screen enforces "one check-in per booking" (.vue:125) by
// swapping the whole form for a success screen the moment `has_checkin` is true
// -- there is no edit affordance and no delete. So every gate that stands
// between a tap and that POST is the product here, and the negative space (the
// POST that must NOT happen) is worth more than the happy path.
//
// It is also time-dependent: `windowClosed` (.vue:119) compares a reactive
// `nowMs` against the practice's `scheduled_at`, and a 60s interval re-reads the
// wall clock so the form self-disables while the user sits on it.
//
// PATTERN A (store-backed), all three stores REAL. The seams are the api
// wrappers the stores import: @/api/practices, @/api/bookings, @/api/diary. The
// deciding factor was the re-entry guard: `onSubmit` (.vue:137) gates on
// `diaryStore.checkinSubmitting`, a ref that only the REAL store flips. Mock the
// diary store and that ref is a frozen `false`, so the double-click test would
// exercise nothing and pass for the wrong reason. Real stores also make
// `alreadyCheckedIn` genuinely reactive (a plain-object store mock cannot notify
// the watch at .vue:196) and let the post-submit refresh be proven at the
// NETWORK (getMyBookings called twice) rather than as a spy call count.
// One pinia instance goes to both setActivePinia and app.use (SC-03).
//
// PINNED INSTANT: 2026-07-20T12:00:00.000Z. Every fixture is a literal against
// it (SC-04) -- no `Date.now() + 86400000`. Timezone is pinned via
// useAuthStore().user.timezone (SW4 fix, ПРОМТ №577): this screen renders the
// scheduled date via formatDate(scheduled_at, viewerTz.value), matching its
// flow siblings PracticeDetailView/EntryView -- so the viewer's profile
// timezone, not the practice's own, is what the runner's local zone could
// otherwise drift.
//
// FAKE TIMERS are on for the whole file (not just setSystemTime). They are
// load-bearing for exactly one test -- "the tick race" below -- which fires the
// 60s interval SYNCHRONOUSLY to reach the .vue:137 windowClosed guard in the one
// frame where the button has not re-rendered yet. Everywhere else they are inert.
//
// TICKS = 10. Counted, not copied (SC-08). The submit chain is the deep one:
//   onSubmit -> submitCheckin -> await upsertCheckin (1) ->
//   await refreshAfterDiaryMutation -> await Promise.allSettled([feed.refresh()])
//   -> feed.refresh -> await loadMore -> await listDiaryFeed (2,3) -> refresh
//   resumes (4) -> allSettled (5) -> refreshAfterDiaryMutation resumes (6) ->
//   submitCheckin returns (7) -> onSubmit resumes, sets submitted, fires
//   refreshBookings -> +1 final re-render = ~8.
// The mount chain is shallower (~5): onMounted -> await fetchMyBookings ->
// pagination.refresh -> await loadMore -> await getMyBookings, plus the
// DETACHED fetchPractice (.vue:202 is not awaited). 10 is two over the deeper
// chain; an over-count is harmless (velo-idiom §3) and an under-count would fail
// loudly on the toEqual body assertions rather than silently.
//
// TRAPS PRESENT:
//  - SC-17, and this file is the reason to read it: `windowClosed` and
//    `alreadyCheckedIn` are BOTH double-gated -- once at the DOM (VButton's
//    `:disabled="disabled || loading"`, VButton.vue:27; and the success screen
//    replacing the form entirely) and once again inside onSubmit (.vue:137). A
//    plain click test can only ever reach the first. So each guard is proven
//    TWICE and separately: once at the rung a user actually meets, and once at
//    .vue:137 through the RACE that is the only way to reach it -- state moves,
//    the DOM has not repainted, the tap lands. The race tests assert the button
//    is still enabled / the form is still on screen BEFORE tapping, so they
//    cannot pass vacuously.
//  - SC-17 (the re-entry half): the double click has NO tick between the two
//    clicks. With a tick, VButton's disabled attribute swallows the second and
//    the test would credit `checkinSubmitting` for work the DOM did. The
//    disabled rung is asserted separately, attributed to the right mechanism.
//  - Two guards, not one, sit behind the double click: the view's (.vue:137) and
//    the store's own (diary.ts:70). `upsertCheckin` called once proves only that
//    ONE of them held. $onAction counts the VIEW's calls, isolating .vue:137.
//  - SC-15: `not.toHaveBeenCalled()` on upsertCheckin is satisfied by a mount
//    that rendered nothing. Every such test first pins the positive -- the form
//    is up, the button exists, the button is enabled -- so the exclusion is real.
//  - SC-14b: 'Check-in' is the header's back-label AND a prefix of both the
//    closed hint and the success title, so `text()).toContain('Check-in')` can
//    never fail. The hint is read off .form-shell__disabled-hint and the success
//    title off .result-screen__title, never off the host.
//  - Wall clock: `nowMs = ref(Date.now())` (.vue:116) + a 60s interval (.vue:211).
//
// TRAPS ABSENT (grepped the whole tree -- CheckinView, FormShell, MoodSlider,
// ResultScreen, PracticeHeroCard, VHeader, VTextarea, VButton, VLoader -- so the
// next agent does not cargo-cult setup onto a screen that has none):
//  - NO overlays. Nothing here mounts VModal or VBottomSheet, so there is no
//    `.v-*__overlay` to reap and no SC-13/13b/13c afterEach purge. VHeader owns
//    the tree's only <Teleport>, and it is `:disabled="!floating"` with
//    `floating = inject(KEY, false)` -- no MobileLayout ancestor in a bare mount,
//    so it renders INLINE inside host. Nothing ever lands on document.body.
//  - NO v-show anywhere. FormShell is `v-if="submitted"` / `v-else`, so the form
//    and the success screen are never both mounted -- SC-14's impossible
//    assertion cannot happen here and whole-host queries are safe.
//  - NO money. No formatMoney, no Intl.NumberFormat, so no ru NBSP trap
//    (velo-idiom §11) and no norm() helper. The date assertions are split into
//    two toContain calls ('20 июля', '13:00') purely to dodge ICU separator
//    variance between Node builds -- that is not the NBSP rule.
//  - NO IntersectionObserver, no scroll/layout reads, no navigator.clipboard, no
//    window.location assignment, no window.history.state, no waitUntilReady.
//  - @/platform is NOT mocked and needs no seam: platform/index.ts picks
//    standalonePlatform when window.Telegram.WebApp.initData is absent (it is),
//    and standalone's hapticFeedback() is a no-op. The .vue:146 call is inside a
//    try/catch besides. Left real on purpose.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import CheckinView from '@/views/user/CheckinView.vue'
import { useBookingsStore } from '@/stores/bookings'
import { useDiaryStore } from '@/stores/diary'
import { usePracticesStore } from '@/stores/practices'
import { ApiResponseError } from '@/api/client'
import { upsertCheckin, listDiaryFeed } from '@/api/diary'
import { getMyBookings, skipCheckin } from '@/api/bookings'
import { getPractice } from '@/api/practices'
import { useAuthStore } from '@/stores/auth'
import type { BookingWithPracticeResponse, PracticeResponse, UserResponse } from '@/api/types'

// -- seams: the api wrappers the three real stores import (velo-idiom §4).
// importActual + spread keeps every other export real; only the network
// boundary is faked.
vi.mock('@/api/diary', async () => {
  const actual = await vi.importActual<typeof import('@/api/diary')>('@/api/diary')
  return { ...actual, upsertCheckin: vi.fn(), listDiaryFeed: vi.fn() }
})
vi.mock('@/api/bookings', async () => {
  const actual = await vi.importActual<typeof import('@/api/bookings')>('@/api/bookings')
  return { ...actual, getMyBookings: vi.fn(), skipCheckin: vi.fn() }
})
vi.mock('@/api/practices', async () => {
  const actual = await vi.importActual<typeof import('@/api/practices')>('@/api/practices')
  return { ...actual, getPractice: vi.fn() }
})

const push = vi.fn()
const routeParams: { practiceId: string } = { practiceId: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: vi.fn() }),
}))

const upsertCheckinMock = vi.mocked(upsertCheckin)
const listDiaryFeedMock = vi.mocked(listDiaryFeed)
const getMyBookingsMock = vi.mocked(getMyBookings)
const skipCheckinMock = vi.mocked(skipCheckin)
const getPracticeMock = vi.mocked(getPractice)

// -- the pinned instant. Everything below is a literal against it.
const NOW = new Date('2026-07-20T12:00:00.000Z')
const NOW_MS = NOW.getTime()

/** Default: starts in one hour -- the check-in window is OPEN. */
function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'm1',
    master_name: 'Мастер Аня',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Утренняя практика',
    description: null,
    scheduled_at: '2026-07-20T13:00:00.000Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 10,
    current_participants: 3,
    zoom_link: null,
    parent_practice_id: null,
    is_free: false,
    price_cents: 2500,
    currency: 'EUR',
    direction: null,
    difficulty: null,
    ...overrides,
  } as PracticeResponse
}

// SW4: the viewer's profile timezone, distinct from every fixture's own
// practice.timezone (default 'UTC') -- proves formattedDate reads the
// VIEWER's tz, not the practice's own.
const VIEWER_TZ = 'Europe/Moscow' // UTC+3

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'u1',
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

function booking(
  overrides: Partial<BookingWithPracticeResponse> = {},
): BookingWithPracticeResponse {
  return {
    id: 'b1',
    practice_id: 'p1',
    user_id: 'u1',
    status: 'confirmed',
    purchase_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    joined_at: null,
    left_at: null,
    checkin_skipped: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: null,
    has_feedback: false,
    has_checkin: false,
    ...overrides,
    practice: {
      id: 'p1',
      title: 'Утренняя практика',
      practice_type: 'live',
      status: 'scheduled',
      scheduled_at: '2026-07-20T13:00:00.000Z',
      duration_minutes: 60,
      timezone: 'UTC',
      master_id: 'm1',
      master_name: 'Мастер Аня',
      direction: null,
      is_free: false,
      price_cents: 2500,
      currency: 'EUR',
      zoom_link: null,
    },
  } as BookingWithPracticeResponse
}

function bookingsPage(items: BookingWithPracticeResponse[]) {
  return { items, total: items.length, limit: 20, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CheckinView)
  app.use(pinia)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

/** The primary submit. Only rendered on the FORM half of FormShell's v-if. */
function submitBtn(): HTMLButtonElement | undefined {
  return button('Отправить')
}

/** Scoped read (SC-14b): 'Check-in' also appears in the header back-label. */
function disabledHint(): string {
  return host?.querySelector('.form-shell__disabled-hint')?.textContent?.trim() ?? ''
}

/** Scoped read (SC-14b): the success title, not any 'Check-in' on the page. */
function successTitle(): string {
  return host?.querySelector('.result-screen__title')?.textContent?.trim() ?? ''
}

function typeComment(value: string): void {
  const ta = host?.querySelector('textarea') as HTMLTextAreaElement
  ta.value = value
  ta.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = user()
  routeParams.practiceId = 'p1'

  getPracticeMock.mockReset().mockResolvedValue(practice())
  getMyBookingsMock.mockReset().mockResolvedValue(bookingsPage([booking()]))
  upsertCheckinMock.mockReset().mockResolvedValue({ id: 'c1' } as never)
  listDiaryFeedMock.mockReset().mockResolvedValue({ items: [], next_cursor: null } as never)
  skipCheckinMock.mockReset().mockResolvedValue({ id: 'b1' } as never)
  push.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  vi.clearAllMocks()
  // No overlay purge: nothing in this tree teleports to document.body. See the
  // "TRAPS ABSENT" note in the banner -- this omission is deliberate, not missed.
})

describe('CheckinView', () => {
  describe('state ladder', () => {
    it('loading: shows the practice loader while the practice is in flight', async () => {
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.form-shell__loader')).not.toBeNull()
      expect(host?.querySelector('.hero-card')).toBeNull()
    })

    it('the form still RENDERS while the practice is in flight, but submit is held (№444)', async () => {
      // Half of this survived №444 and half of it was inverted, deliberately.
      //
      // The form is still fillable -- the check-in is about the USER's state and
      // the practiceId comes from the route, not the fetch, so blanking it behind
      // a slow catalog request would be the bug.
      //
      // But submit is now HELD while the start time is unknown, because
      // windowClosed fails CLOSED (.vue:130). The button is disabled here because
      // we do not KNOW the window, not because it is shut -- which is exactly why
      // the hint must stay empty (see below). It re-enables the moment the
      // practice lands.
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(text()).toContain('Как вы себя чувствуете?')
      expect(submitBtn()).toBeDefined()
      expect(submitBtn()?.disabled).toBe(true)
    })

    it('while loading, the disabled button does NOT claim the practice already started', async () => {
      // The hint is gated on `practice` (.vue:22). Without that gate, failing
      // closed would make the screen assert «Check-in закрыт — практика уже
      // началась» about a practice it has not even loaded -- trading a live
      // button for a confident lie. Disabled-and-silent is the honest state.
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(true)
      expect(disabledHint()).toBe('')
    })

    it('a loaded practice inside the window RE-ENABLES submit (the fail-closed default lifts)', async () => {
      // The non-vacuous other side: if windowClosed simply returned true forever,
      // every test above would still pass. This is what proves the default lifts.
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(false)
      expect(disabledHint()).toBe('')
    })

    it('content: renders the practice the store actually holds', async () => {
      getPracticeMock.mockResolvedValue(
        practice({ title: 'Вечерняя йога (эфир)', master_name: 'Мастер Лена' }),
      )
      mount()
      await flush()

      // cleanPracticeTitle strips the "(эфир)" suffix (FormShell.vue:172).
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Вечерняя йога')
      expect(text()).toContain('Мастер Лена')
    })

    it("SW4: the date is rendered in the VIEWER's timezone, not the practice's own", async () => {
      // formatDate(scheduled_at, viewerTz.value) -- .vue:153-154 (ПРОМТ №577
      // fix), matching PracticeDetailView/EntryView, this flow's siblings. The
      // fixture's practice.timezone (America/New_York, UTC-4 in July) is
      // deliberately DIFFERENT from the viewer's profile tz (Europe/Moscow,
      // UTC+3, set in beforeEach) so the two branches render different
      // HH:MM -- 13:00 UTC is "09:00" in the practice's own tz (the OLD buggy
      // value) but "16:00" in the viewer's (the correct one). Split into two
      // toContain so an ICU separator change between Node builds cannot break
      // a test that is really about the timezone and the instant.
      getPracticeMock.mockResolvedValue(
        practice({ scheduled_at: '2026-07-20T13:00:00.000Z', timezone: 'America/New_York' }),
      )
      mount()
      await flush()

      expect(text()).toContain('20 июля')
      expect(text()).toContain('16:00')
      expect(text()).not.toContain('09:00')
    })

    it('falls back to «Мастером» when the practice carries no master name', async () => {
      getPracticeMock.mockResolvedValue(practice({ master_name: null }))
      mount()
      await flush()

      expect(text()).toContain('Мастером')
    })

    it('does NOT re-fetch a practice the store already holds', async () => {
      // .vue:201 -- arriving from the detail card, `selected` is already this
      // practice. Re-fetching would be a wasted request on every check-in tap.
      const store = usePracticesStore()
      store.selected = practice({ title: 'Уже загружена' })
      mount()
      await flush()

      expect(getPracticeMock).not.toHaveBeenCalled()
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Уже загружена')
    })

    it('fetches the practice on a cold deep-link', async () => {
      mount()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
    })
  })

  // ===========================================================================
  // GATE 1 -- windowClosed (.vue:119, :137). Both sides of the boundary.
  // ===========================================================================
  describe('the check-in window', () => {
    it('OPEN: an hour before the start, submit is live and no hint is shown', async () => {
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T13:00:00.000Z' }))
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(false)
      expect(disabledHint()).toBe('')
    })

    it('CLOSED: one millisecond after the start, submit is dead and says why', async () => {
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T11:59:59.999Z' }))
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(true)
      expect(disabledHint()).toBe('Check-in закрыт — практика уже началась')
    })

    it('the boundary is STRICTLY greater: at the exact start instant the window is still OPEN', async () => {
      // `nowMs.value > new Date(s).getTime()` (.vue:122). A `>=` here would slam
      // the door on the user who taps at exactly the scheduled second, and the
      // backend's own window is inclusive of the start.
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T12:00:00.000Z' }))
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(false)
      expect(disabledHint()).toBe('')
    })

    it('CLOSED: the POST never leaves -- the disabled button swallows the tap', async () => {
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T11:00:00.000Z' }))
      mount()
      await flush()

      // SC-15: pin the positive first -- the form IS up and the button IS there,
      // so `not.toHaveBeenCalled()` cannot pass on an empty mount.
      const btn = submitBtn()
      expect(btn).toBeDefined()
      expect(btn?.disabled).toBe(true)

      btn?.click()
      await flush()

      expect(upsertCheckinMock).not.toHaveBeenCalled()
    })

    it('the .vue:137 windowClosed guard holds the TICK RACE, where the disabled attribute cannot', async () => {
      // THE reason the guard at .vue:137 exists, and the only way to reach it.
      // The user opens the form with 30s to go, sits there, the practice starts.
      // The 60s interval (.vue:211) fires and moves `nowMs` -- but Vue's
      // re-render is queued as a microtask, so for one frame the button in the
      // DOM is still enabled. The tap lands in that frame.
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T12:00:30.000Z' }))
      mount()
      await flush()
      expect(submitBtn()?.disabled).toBe(false)

      // The wall clock moves past the start, then the interval fires
      // SYNCHRONOUSLY -- no await, so nothing has repainted.
      vi.setSystemTime(new Date(NOW_MS + 90_000))
      vi.advanceTimersByTime(60_000)

      // Self-proving: if this were already true we would be testing the disabled
      // attribute again (SC-17) and the guard below would never be reached.
      const btn = submitBtn()
      expect(btn?.disabled).toBe(false)

      btn?.click()
      await flush()

      expect(upsertCheckinMock).not.toHaveBeenCalled()
      // ...and the repaint that follows does close the door properly.
      expect(submitBtn()?.disabled).toBe(true)
      expect(disabledHint()).toBe('Check-in закрыт — практика уже началась')
    })

    it('a FAILED practice load renders the error rung with the real message, not a form (№444)', async () => {
      // Both halves of the ruling, and they are halves: the rung alone would leave
      // the button live while loading, and failing closed alone would leave a dead
      // button and a mystery. Previously this pinned the opposite -- no rung at all
      // (FormShell had no error state and .vue never read selectedError) and submit
      // live with the window unknown.
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()

      // The rung is there and carries the REAL backend message, not a constant.
      expect(text()).toContain('Не удалось загрузить практику')
      expect(text()).toContain('Практика не найдена')
      // ...and the form is gone rather than offered for a POST that cannot land.
      expect(text()).not.toContain('Как вы себя чувствуется?')
      expect(submitBtn()).toBeUndefined()
      expect(host?.querySelector('.hero-card')).toBeNull()
      expect(host?.querySelector('.form-shell__loader')).toBeNull()
    })

    it('the error rung is not a dead end -- «Повторить» re-fetches', async () => {
      // A dead-end error state was its own bug class in this repo (11 of them,
      // fixed in 22dc824). Not adding a twelfth.
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()
      getPracticeMock.mockClear()

      const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('Повторить'),
      )
      expect(retry).toBeDefined()
      retry!.click()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
    })

    it('an UNKNOWN start time now fails CLOSED -- no data, no submit (№444)', async () => {
      // `if (!s) return true` (.vue:130). Driven through the store directly so the
      // window gate is proven on its own, independently of the error rung above --
      // otherwise the rung hiding the button would be doing all the work and this
      // would prove nothing about windowClosed.
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()
      expect(submitBtn()?.disabled).toBe(false)

      usePracticesStore().selected = null
      await flush()

      expect(submitBtn()?.disabled).toBe(true)
      expect(disabledHint()).toBe('')
    })
  })

  // ===========================================================================
  // GATE 2 -- alreadyCheckedIn (.vue:128, :137). A UI gate over a PERMISSIVE api:
  // upsertCheckin is an upsert and would accept a second call, overwriting the
  // recorded mood/comment (api/diary.ts:50-55). So the backend will not catch a
  // bug here and these tests are the only thing holding the gate.
  // ===========================================================================
  describe('one check-in per booking', () => {
    it('an existing check-in replaces the FORM with the success screen at mount', async () => {
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_checkin: true })]))
      mount()
      await flush()

      expect(successTitle()).toBe('Check-in отправлен')
      expect(submitBtn()).toBeUndefined()
      expect(text()).not.toContain('Как вы себя чувствуете?')
    })

    it('a check-in on a DIFFERENT practice does not lock this one', async () => {
      // `alreadyCheckedIn` keys on practice_id (.vue:129). Matching on the wrong
      // field would lock a user out of every later check-in after their first.
      getMyBookingsMock.mockResolvedValue(
        bookingsPage([booking({ id: 'b9', practice_id: 'p_other', has_checkin: true })]),
      )
      mount()
      await flush()

      expect(successTitle()).toBe('')
      expect(submitBtn()).toBeDefined()
      expect(submitBtn()?.disabled).toBe(false)
    })

    it('a booking with has_checkin FALSE leaves the form up', async () => {
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_checkin: false })]))
      mount()
      await flush()

      expect(text()).toContain('Как вы себя чувствуете?')
      expect(successTitle()).toBe('')
    })

    it('a check-in landing AFTER mount swaps the form out (the .vue:196 watch)', async () => {
      mount()
      await flush()
      expect(submitBtn()).toBeDefined()

      // The bookings list refreshes from elsewhere (another device, the
      // dashboard) and now carries has_checkin.
      const bookings = useBookingsStore()
      bookings.bookings = [booking({ has_checkin: true })]
      await flush()

      expect(successTitle()).toBe('Check-in отправлен')
      expect(submitBtn()).toBeUndefined()
    })

    it('the .vue:137 alreadyCheckedIn guard holds the race before the watch repaints', async () => {
      // Same shape as the tick race: the state flips, the watch is queued as a
      // microtask, and for one frame the form is still on screen. Without the
      // guard this tap would silently overwrite a check-in the user already
      // recorded -- the exact thing "one check-in per booking" forbids.
      mount()
      await flush()

      const bookings = useBookingsStore()
      bookings.bookings = [booking({ has_checkin: true })]

      // No await: the watch has not run and the form is still mounted.
      const btn = submitBtn()
      expect(btn).toBeDefined()
      expect(btn?.disabled).toBe(false)

      btn?.click()
      await flush()

      expect(upsertCheckinMock).not.toHaveBeenCalled()
      expect(successTitle()).toBe('Check-in отправлен')
    })
  })

  // ===========================================================================
  // GATE 3 -- checkinSubmitting (.vue:137). Re-entry.
  // ===========================================================================
  describe('re-entry', () => {
    it('two taps with NO repaint between them still send exactly ONE check-in', async () => {
      // SC-17: no `await` between the clicks. With one, VButton's
      // `:disabled="disabled || loading"` (VButton.vue:27) would have swallowed
      // the second tap and this test would be crediting the ref guard for the
      // DOM's work. `submitCheckin` flips checkinSubmitting SYNCHRONOUSLY before
      // its first await (diary.ts:71), so the ref really is the only defence in
      // this frame.
      let resolve!: (v: unknown) => void
      upsertCheckinMock.mockReturnValue(
        new Promise((r) => {
          resolve = r
        }) as never,
      )
      mount()
      await flush()

      const btn = submitBtn()
      expect(btn).toBeDefined()
      btn?.click()
      btn?.click()

      expect(upsertCheckinMock).toHaveBeenCalledTimes(1)

      resolve({ id: 'c1' })
      await flush()
    })

    it("the VIEW's own guard is what blocks the second tap -- not the store's", async () => {
      // `upsertCheckin` called once proves only that ONE of the two guards held:
      // the view's (.vue:137) or the store's (diary.ts:70). $onAction counts the
      // calls the VIEW makes, so this isolates .vue:137. Delete that line and
      // this test goes red while the one above stays green.
      const diary = useDiaryStore()
      let viewCalls = 0
      diary.$onAction(({ name }) => {
        if (name === 'submitCheckin') viewCalls++
      })

      let resolve!: (v: unknown) => void
      upsertCheckinMock.mockReturnValue(
        new Promise((r) => {
          resolve = r
        }) as never,
      )
      mount()
      await flush()

      const btn = submitBtn()
      btn?.click()
      btn?.click()

      expect(viewCalls).toBe(1)

      resolve({ id: 'c1' })
      await flush()
    })

    it('the button also disables itself while the check-in is in flight', async () => {
      // The OTHER mechanism, asserted separately and attributed correctly
      // (SC-17): FormShell binds `:loading="submitting"` (FormShell.vue:112) to
      // diaryStore.checkinSubmitting, and VButton folds loading into disabled.
      // This is the DOM rung; the test above is the ref rung.
      let resolve!: (v: unknown) => void
      upsertCheckinMock.mockReturnValue(
        new Promise((r) => {
          resolve = r
        }) as never,
      )
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(false)
      submitBtn()?.click()
      await flush()

      expect(submitBtn()?.disabled).toBe(true)

      resolve({ id: 'c1' })
      await flush()
    })
  })

  // ===========================================================================
  // The write itself.
  // ===========================================================================
  describe('submitting the check-in', () => {
    it('sends the DEFAULT mood and a null comment, and shows the success screen', async () => {
      // moodScore defaults to 6 -- the middle "Нормально" zone (.vue:108) -- so
      // a user who taps Отправить without touching anything sends a neutral
      // score, not a 1 or an empty body the backend would reject.
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertCheckinMock).toHaveBeenCalledTimes(1)
      expect(upsertCheckinMock).toHaveBeenCalledWith('p1', { mood: 6, comment: null })
      expect(successTitle()).toBe('Check-in отправлен')
      expect(text()).toContain('Ваше состояние записано, хорошей практики!')
    })

    it('sends the mood the SLIDER chose and the comment the user typed, trimmed', async () => {
      mount()
      await flush()

      // Tap the third mood card -> ZONE_CENTRE[2] = 9 (MoodSlider.vue:100-103).
      const cards = host?.querySelectorAll('.mood-slider__card')
      expect(cards?.length).toBe(3)
      ;(cards?.[2] as HTMLElement).click()
      typeComment('   Хорошо спал   ')
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertCheckinMock).toHaveBeenCalledWith('p1', { mood: 9, comment: 'Хорошо спал' })
    })

    it('a whitespace-only comment is sent as null, not as blanks', async () => {
      // `comment.value.trim() || null` (.vue:141).
      mount()
      await flush()

      typeComment('    ')
      await flush()
      submitBtn()?.click()
      await flush()

      expect(upsertCheckinMock).toHaveBeenCalledWith('p1', { mood: 6, comment: null })
    })

    it('sends the check-in for the practice in the ROUTE, not the one in the store', async () => {
      // practiceId is read off route.params (.vue:101) and is what the POST is
      // keyed on. A store-sourced id would write the check-in to whichever
      // practice happened to be `selected`.
      routeParams.practiceId = 'p42'
      getPracticeMock.mockResolvedValue(practice({ id: 'p42' }))
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ practice_id: 'p42' })]))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertCheckinMock).toHaveBeenCalledWith('p42', { mood: 6, comment: null })
    })

    it('refreshes the bookings after a successful submit -- at the NETWORK, not just a spy', async () => {
      // W27 (diary.ts:218-233): the store deliberately STOPPED refreshing
      // bookings, on the grounds that this view does it itself (.vue:155). If
      // that ever regresses, has_checkin stays stale and the dashboard keeps
      // offering a check-in the user already made. One GET at mount, one after
      // the submit.
      mount()
      await flush()
      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)

      submitBtn()?.click()
      await flush()

      expect(getMyBookingsMock).toHaveBeenCalledTimes(2)
    })

    it('refreshes the diary feed too -- the check-in is a timeline event', async () => {
      // submitCheckin -> refreshAfterDiaryMutation -> feed.refresh (diary.ts:76).
      // Verified one level down rather than from the .vue comment.
      mount()
      await flush()
      expect(listDiaryFeedMock).not.toHaveBeenCalled()

      submitBtn()?.click()
      await flush()

      expect(listDiaryFeedMock).toHaveBeenCalledTimes(1)
    })

    it('a FAILED feed refresh does not fail the check-in -- the POST already landed', async () => {
      // Promise.allSettled (diary.ts:235). The write succeeded server-side;
      // telling the user it failed would push them into a duplicate submit.
      listDiaryFeedMock.mockRejectedValue(new ApiResponseError(500, 'Лента недоступна'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(successTitle()).toBe('Check-in отправлен')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a FAILED submit surfaces the REAL backend message and never claims success', async () => {
      // extractApiError returns e.detail for an ApiResponseError
      // (useApiError.ts:26), so this is the backend's own words -- not a
      // hardcoded constant (contrast SC-05).
      upsertCheckinMock.mockRejectedValue(new ApiResponseError(400, 'Check-in window has closed'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Check-in window has closed')
      expect(successTitle()).toBe('')
      expect(text()).toContain('Как вы себя чувствуете?')
    })

    it('a FAILED submit does NOT refresh the bookings -- nothing changed', async () => {
      upsertCheckinMock.mockRejectedValue(new ApiResponseError(400, 'Check-in window has closed'))
      mount()
      await flush()
      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)

      submitBtn()?.click()
      await flush()

      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)
    })

    it("a non-API failure falls back to the store's own message", async () => {
      upsertCheckinMock.mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отправить check-in')
      expect(successTitle()).toBe('')
    })

    // P5 (ПРОМТ №594): the audience/block gate on POST .../checkin
    // (upsert_checkin, audience_service.py) -- covers the retroactive case
    // (a booking made before the master narrowed the audience or blocked
    // this viewer). The store surfaces the machine `code`; the view maps it
    // to the app's own Russian message, composing the groups case from the
    // ALREADY-LOADED practice's own audience_group_names (no raw backend
    // string, no second round-trip).
    describe('the closed-practice gate (P5, ПРОМТ №594)', () => {
      it('blocked_by_master shows the exact copy', async () => {
        upsertCheckinMock.mockRejectedValue(
          new ApiResponseError(403, 'You are blocked', 'blocked_by_master'),
        )
        mount()
        await flush()

        submitBtn()?.click()
        await flush()

        expect(toastError).toHaveBeenCalledWith('Мастер ограничил вам доступ к этой практике')
      })

      it('not_a_student shows the exact copy', async () => {
        upsertCheckinMock.mockRejectedValue(
          new ApiResponseError(403, 'Students only', 'not_a_student'),
        )
        mount()
        await flush()

        submitBtn()?.click()
        await flush()

        expect(toastError).toHaveBeenCalledWith('Эта практика доступна только ученикам мастера')
      })

      it('not_in_audience composes the group name(s) from the loaded practice', async () => {
        getPracticeMock.mockResolvedValue(practice({ audience_group_names: ['VIP', 'Утро'] }))
        upsertCheckinMock.mockRejectedValue(
          new ApiResponseError(403, 'Not a group member', 'not_in_audience'),
        )
        mount()
        await flush()

        submitBtn()?.click()
        await flush()

        expect(toastError).toHaveBeenCalledWith('Вы не состоите в группе «VIP», «Утро»')
      })

      it('not_in_audience with no group names on the practice falls back to a generic phrasing', async () => {
        getPracticeMock.mockResolvedValue(practice({ audience_group_names: [] }))
        upsertCheckinMock.mockRejectedValue(
          new ApiResponseError(403, 'Not a group member', 'not_in_audience'),
        )
        mount()
        await flush()

        submitBtn()?.click()
        await flush()

        expect(toastError).toHaveBeenCalledWith(
          'Вы не состоите в группе, которой открыта эта практика',
        )
      })
    })

    it('the form is submittable again after a failure -- the ref is released', async () => {
      // `finally { checkinSubmitting.value = false }` (diary.ts:82). A guard
      // left latched would strand the user on a form that ignores every tap.
      upsertCheckinMock.mockRejectedValueOnce(new ApiResponseError(500, 'Сервер недоступен'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()
      expect(successTitle()).toBe('')

      upsertCheckinMock.mockResolvedValue({ id: 'c1' } as never)
      submitBtn()?.click()
      await flush()

      expect(upsertCheckinMock).toHaveBeenCalledTimes(2)
      expect(successTitle()).toBe('Check-in отправлен')
    })
  })

  // ===========================================================================
  // Skip / navigation.
  // ===========================================================================
  describe('skipping', () => {
    it('persists the skip against the BOOKING id, dismisses it locally, and leaves', async () => {
      // .vue:169-171 looks the booking up by practice_id and sends
      // booking.id -- two different ids one line apart. Sending the practiceId
      // here would 404 (or worse, hit another resource) while the optimistic
      // dismiss still made it look like it worked.
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ id: 'b77', practice_id: 'p1' })]))
      mount()
      await flush()

      button('Пропустить')?.click()
      await flush()

      expect(skipCheckinMock).toHaveBeenCalledWith('b77')
      expect(useBookingsStore().dismissedCheckins).toContain('p1')
      expect(toastInfo).toHaveBeenCalledWith('Check-in пропущен')
      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('with no booking loaded, the skip still dismisses and navigates -- and calls no endpoint', async () => {
      // .vue:170 `if (booking)`. Fire-and-forget by design: the session dismiss
      // and the navigation must not depend on the list having loaded.
      getMyBookingsMock.mockResolvedValue(bookingsPage([]))
      mount()
      await flush()

      expect(button('Пропустить')).toBeDefined()
      button('Пропустить')?.click()
      await flush()

      expect(skipCheckinMock).not.toHaveBeenCalled()
      expect(useBookingsStore().dismissedCheckins).toContain('p1')
      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })

  describe('navigation', () => {
    it('back goes to the DASHBOARD, never router.back()', async () => {
      // .vue:177-182: router.back() here bounced the user into the detail card,
      // which itself calls router.back() -- a check-in <-> detail loop.
      mount()
      await flush()

      const backBtn = host?.querySelector('.v-back') as HTMLElement
      expect(backBtn).not.toBeNull()
      backBtn.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('«Начать практику» goes to the live screen for THIS practice', async () => {
      routeParams.practiceId = 'p42'
      getPracticeMock.mockResolvedValue(practice({ id: 'p42' }))
      getMyBookingsMock.mockResolvedValue(
        bookingsPage([booking({ practice_id: 'p42', has_checkin: true })]),
      )
      mount()
      await flush()

      expect(successTitle()).toBe('Check-in отправлен')
      button('Начать практику')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'practice-live', params: { practiceId: 'p42' } })
    })

    it('«На главную» goes to the dashboard', async () => {
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_checkin: true })]))
      mount()
      await flush()

      button('На главную')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })

  // NOT COVERED, deliberately -- limits of this file's seams, stated rather than
  // faked:
  //
  // 1. platform.hapticFeedback('medium') on a successful submit (.vue:146). It
  //    is wrapped in a bare try/catch with a silent fallback and returns
  //    nothing, so on the standalone platform this mount resolves to it is a
  //    no-op with no observable effect. Proving it fired would mean mocking
  //    @/platform purely to assert the mock (SC-02) -- the call has no product
  //    behaviour behind it to assert instead.
  //
  // 2. The 60s interval's normal duty cycle -- re-reading the clock every minute
  //    for the whole time the user sits on the form. The ONE frame that matters
  //    (the tick that closes the window, and the guard behind it) IS covered
  //    above; what is not covered is that it keeps ticking indefinitely, or that
  //    clearInterval on unmount (.vue:216-218) actually stops it. happy-dom
  //    plus fake timers can show the handle is cleared, but not that a leaked
  //    interval would cost anything, so the assertion would be circular.
  //
  // 3. [CLOSED in №444] There used to be no error rung to test -- the screen never
  //    read practicesStore.selectedError and FormShell had no error state, so a
  //    failed deep link rendered a live form for a POST the backend would refuse.
  //    Both halves are now covered above: the rung (with the real message and a
  //    working «Повторить»), and windowClosed failing CLOSED.
})
