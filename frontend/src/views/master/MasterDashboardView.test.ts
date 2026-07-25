// =============================================================================
// VELO Frontend -- MasterDashboardView Screen Tests
// =============================================================================
//
// The master's home screen, and the first thing they see every session. Nothing
// on it is stored: ten computeds turn a raw practice page plus one stats payload
// into the two numbers, the two cards and the one CTA a master reads to decide
// what to do today. Every value is DERIVED, so a wrong one is silent -- there is
// nothing on the screen to contradict it. Hence: these tests assert the VALUES
// the computeds produce («Завтра, 07:00 • 45 мин», «+23%», «12»), not that a
// fetch fired (SC-02). The two call-shape assertions in this file are flagged
// where they appear, and each is there because the argument IS the behaviour and
// nothing rendered can distinguish it.
//
// PATTERN C (hybrid), and both halves are driven per the skill's warning that
// mocking one layer for both guts the test:
//   - DATA HALF: profile + practices come from a REAL useMasterStore
//     (.vue:219,392-393); role / user / updateProfile from a REAL useAuthStore
//     (.vue:220). Real stores, not mocked ones -- `nearestPractices` hangs off
//     the store's reactive pagination list and `isNewMaster` off its `total`,
//     and a hand-rolled fake is exactly the kind of thing that is quietly
//     non-reactive: the test would then prove the fixture, not the screen.
//   - LOCAL-REF HALF: `period`, `stats` and the 60s `now` clock are the screen's
//     OWN refs (.vue:240,256,302), fed by a direct getMasterStats call. The
//     period toggle is driven by a real DOM click on the real VSegmentTrack.
//   Both stores read `@/api/masters` / `@/api/users`, so mocking those two
//   modules seams every half at once. ONE real Pinia goes to setActivePinia AND
//   app.use (SC-03).
//
// TIME IS PINNED to 2026-07-20T12:00:00Z, with fake timers, because this screen
// reads the WALL CLOCK in two places that decide what renders:
//   - `now = ref(Date.now())` + a 60s setInterval (.vue:302-303,384-386), which
//     `nearestPractices` cuts on via practiceHasEnded (.vue:308).
//   - formatDateShort (utils/format.ts:65-85) internally compares against
//     `new Date()` to emit «Сегодня» / «Завтра».
// Unpinned, the card list and every date line below are a different answer at a
// different hour, and a different one again in CI (SC-04). All fixtures are
// LITERAL datetimes chosen against that frozen instant, never `Date.now() + n`.
//
// THE RUNNER'S TIMEZONE CANNOT LEAK either, and that is a property of the
// FIXTURES, not of the config: this screen renders each practice in the
// practice's OWN zone (`formatDateShort(p.scheduled_at, p.timezone)`, .vue:319-320),
// so every fixture below carries an explicit `timezone` and no formatter is
// ever left to default to the host. TZ_SORT_A / TZ_SORT_B deliberately carry
// NON-UTC zones whose local-wall-clock order disagrees with their absolute
// order -- the only way to prove ordering is server-owned (T22-3, ПРОМТ №561:
// the old client-side localSortKey re-sort is retired) rather than re-derived.
//
// v-if, not v-show (SC-14): grepped -- this template has no v-show, so a pane
// that is not on screen is genuinely absent from the DOM and host.textContent
// spans only what is rendered. Queries are still scoped per practice block,
// because `.master-dashboard__empty-text` legitimately appears TWICE at once
// (the summary placeholder .vue:110 and the nearest-practice empty card .vue:190).
//
// NBSP (velo-idiom §11): no money is formatted here -- income_cents is returned
// by the stats endpoint and deliberately NOT rendered (.vue:253-254), formatMoney
// is not imported. The trap still gets its guard: Intl's date/time formatters
// emit U+00A0 on some ICU builds, and norm() costs nothing. Written as ESCAPES,
// never literal characters -- a literal NBSP is invisible in a diff and the next
// editor "tidies" it into a plain space without ever seeing what they broke.
// U+2212 (MINUS SIGN, the screen's own negative sign, .vue:274) and U+2014 (EM
// DASH, the "no data" placeholder, .vue:263) go through MINUS / DASH for the same
// reason: the glyphs are indistinguishable from their ASCII lookalikes.
//
// SC-13 -- the reap. This screen teleports ONE thing: the onboarding overlay
// (.vue:203-211). Unlike VModal / VBottomSheet it is a bare `v-if` with NO
// <Transition>, so app.unmount() really does reap it and SC-13b does not apply
// (`toBeNull()` on it is honest, and is used below). The afterEach purge is here
// anyway: unconditional, idempotent, free when unnecessary, and the day someone
// wraps that overlay in a <Transition> it is the difference between one red test
// and an afternoon debugging a healthy screen.
//
// TWO COMMENTS IN THE SOURCE ARE STALE, and the tests below assert the CODE:
//   - .vue:20-21 «Stats: only the practices total is real; participants/income +
//     all deltas and the Неделя/Месяц period scoping have no API -> toggle
//     visual-only». Untrue since E7: loadStats really calls
//     GET /masters/me/stats?period and watch(period) really refetches
//     (.vue:258-260,288-292). Asserted as the live behaviour it is.
//   - «Мои ученики (stub — no screen yet)». Untrue: onGroups() pushes to
//     'master-groups' (P2, ПРОМТ №591 -- was onStudents/'master-students')
//     and that route exists and resolves MasterGroupsView. It navigates.
// Both reported. Neither faked.
//
// No order dependence: every test mounts its own app, beforeEach builds a fresh
// Pinia and re-arms every mock. Declaration order is execution order (no shuffle
// is configured), but nothing here relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import MasterDashboardView from '@/views/master/MasterDashboardView.vue'
import * as mastersApi from '@/api/masters'
import * as usersApi from '@/api/users'
import * as practicesApi from '@/api/practices'
import { useMasterStore } from '@/stores/master'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import type {
  PracticeResponse,
  MasterProfileResponse,
  MasterStatsResponse,
  UserResponse,
} from '@/api/types'

// Both real stores under this screen read from these two modules, so auto-mocking
// them seams the data half whole. ApiResponseError stays REAL (it lives in
// @/api/client, untouched), so the profile-error branch is driven by the real class.
vi.mock('@/api/masters')
vi.mock('@/api/users')

// ПРОМТ №565: "Zoom", for kind==='personal', now goes through the same
// ticket flow "Начать" used before the two buttons merged -- only
// createZoomStartTicket is a network call worth mocking. zoomStartRedirectUrl
// is left REAL (a pure function over import.meta.env.VITE_API_BASE_URL,
// stubbed per-test via vi.stubEnv where the exact url matters).
vi.mock('@/api/practices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/practices')>()
  return { ...actual, createZoomStartTicket: vi.fn(), retryZoomMeeting: vi.fn() }
})

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))

const toastInfo = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastInfo, success: toastSuccess, error: toastError }),
}))

// The Zoom button routes through the platform abstraction (.vue:339-345), not
// window.open -- mocking the seam the screen imports (velo-idiom §4). `name` is
// here because the REAL auth store imports this module too (stores/auth.ts:19).
//
// A GETTER over a mutable module-scope object, not a bare `openLink` in the
// literal (velo-idiom §5, verbatim from stores/auth.test.ts:53-59). This is not
// style: vi.mock is hoisted above the imports, and stores/auth.ts imports
// @/platform, so this factory RUNS during the import of the .vue -- before the
// test file's own consts are initialised. A bare reference is evaluated right
// there and dies with «Cannot access 'openLink' before initialization». The
// vue-router / useToast factories above survive it only because their spies sit
// inside a NESTED arrow (useRouter()) that nobody calls until mount. The getter
// buys this one the same deferral.
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
// The frozen instant, and the characters that lie in a diff
// -----------------------------------------------------------------------------

const NOW = new Date('2026-07-20T12:00:00Z')

/** U+2212 MINUS SIGN -- the screen's own negative delta sign (.vue:274), NOT '-'. */
const MINUS = '\u2212'
/** U+2014 EM DASH -- the "no data yet" stat placeholder (.vue:263,266). */
const DASH = '\u2014'

const EMPTY_NEW = `Данных пока нет ${DASH} создайте первую практику`

// -----------------------------------------------------------------------------
// Fixtures. Every datetime is a literal picked against NOW; every practice
// carries an explicit timezone (see the banner).
// -----------------------------------------------------------------------------

function practice(id: string, overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id,
    master_id: 'm1',
    practice_type: 'live',
    status: 'scheduled',
    title: `Практика ${id}`,
    description: null,
    scheduled_at: '2026-07-25T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 5,
    zoom_link: null,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

// Tomorrow 07:00 UTC, 45 min -> «Завтра, 07:00 • 45 мин». The soonest.
const P_SOON = practice('p1', {
  title: 'Утренняя практика',
  scheduled_at: '2026-07-21T07:00:00Z',
  duration_minutes: 45,
  current_participants: 5,
  max_participants: 20,
  checkin_count: 3,
  zoom_link: 'https://zoom.us/j/111',
})
// Five days out, 90 min -> «25 июля, 10:00 • 1 ч 30 м». Second in the list.
const P_LATER = practice('p2', {
  title: 'Вечерняя практика',
  scheduled_at: '2026-07-25T10:00:00Z',
  duration_minutes: 90,
  current_participants: 8,
  max_participants: 12,
})
// Third-soonest: exists only to prove the slice(0,2) preview cap (.vue:313).
const P_THIRD = practice('p3', {
  title: 'Третья практика',
  scheduled_at: '2026-07-28T10:00:00Z',
})
// Started 15 min ago, still running -> practiceHasEnded is false, status 'live'.
// Sorts FIRST, ahead of P_SOON.
const P_LIVE = practice('p4', {
  title: 'Идёт сейчас',
  status: 'live',
  scheduled_at: '2026-07-20T11:45:00Z',
  duration_minutes: 60,
})
// Ends at EXACTLY the frozen instant (11:00 + 60 min = 12:00:00Z). practiceHasEnded
// is `nowMs >= end` (utils/practiceStatus.ts:54), so this is the boundary case and
// it must be treated as OVER. Chosen deliberately: an off-by-one to `>` would keep
// a finished practice on the dashboard, and only an exact-boundary fixture catches it.
const P_JUST_ENDED = practice('p5', {
  title: 'Только что закончилась',
  scheduled_at: '2026-07-20T11:00:00Z',
  duration_minutes: 60,
})
const P_DRAFT = practice('p6', { title: 'Черновик', status: 'draft' })
const P_CANCELLED = practice('p7', { title: 'Отменённая', status: 'cancelled' })
const P_COMPLETED = practice('p8', { title: 'Завершённая', status: 'completed' })

// A series, for the meta rows the live card renders only when the data exists.
const P_SERIES = practice('s1', {
  title: 'Серия',
  practice_type: 'series',
  scheduled_at: '2026-07-22T09:00:00Z',
  recurrence_days: [1, 3, 5],
  total_sessions: 8,
  completed_sessions: 3,
  checkin_count: 4,
  max_participants: 10,
  current_participants: 6,
})

// -- The local-wall-clock sort pair (CR-1/CR-2, .vue:310-312). --
// In ABSOLUTE UTC terms A (20:00Z) precedes B (22:00Z). In the LOCAL times the
// cards actually SHOW, B is 21 July 18:00 (New York) and A is 22 July 05:00
// (Tokyo) -- so B must render first, or the list reads out of order against its
// own visible times. A getTime() sort passes every other test in this file and
// fails only this one.
const TZ_SORT_A = practice('tz-a', {
  title: 'Токио',
  scheduled_at: '2026-07-21T20:00:00Z',
  timezone: 'Asia/Tokyo',
})
const TZ_SORT_B = practice('tz-b', {
  title: 'Нью-Йорк',
  scheduled_at: '2026-07-21T22:00:00Z',
  timezone: 'America/New_York',
})

const PROFILE: MasterProfileResponse = {
  user_id: 'm1',
  status: 'verified',
  display_name: 'Мастер',
  bio: null,
  methods: [],
  languages: [],
  experience_years: 3,
  frozen_cents: 0,
  available_cents: 0,
  min_withdrawal_cents: 1000,
  withdrawal_fee_cents: 0,
  payout: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: null,
  rejection_reason: null,
}

// Week vs month differ on EVERY figure on purpose -- equal numbers would let a
// toggle that refetches nothing pass. -8.6 rounds to -9 (JS rounds away from
// zero), which is the rounding the screen relies on (.vue:272).
const STATS_WEEK: MasterStatsResponse = {
  practices_count: 12,
  practices_delta_pct: 23.4,
  participants_count: 148,
  participants_delta_pct: -8.6,
  income_cents: 123456,
  income_delta_pct: 10,
}
// practices_delta_pct: 0 -> «0%» + muted. participants_delta_pct: null -> hidden.
const STATS_MONTH: MasterStatsResponse = {
  practices_count: 40,
  practices_delta_pct: 0,
  participants_count: 500,
  participants_delta_pct: null,
  income_cents: 900000,
  income_delta_pct: null,
}

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'm1',
    telegram_id: 1,
    role: 'master',
    first_name: 'Мастер',
    last_name: null,
    avatar_url: null,
    timezone: 'UTC',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    // The steady state: a master who has already seen the carousel. Set false in
    // the onboarding block below, and ONLY there -- otherwise the overlay would
    // sit over every other test in this file.
    master_onboarding_completed: true,
    phone: null,
    bio: null,
    email: null,
    notifications: {} as UserResponse['notifications'],
    master_notifications: null,
    role_switch: null,
    ...overrides,
  }
}

function page(items: PracticeResponse[], total = items.length, offset = 0) {
  return { items, total, limit: 20, offset }
}

// T22-3 (ПРОМТ №561): the server now owns both the filter AND the ordering
// per bucket -- nearestPractices no longer re-sorts client-side (.vue), so
// the fake server must actually behave like one. Mirrors
// listing_service.py's bucket semantics: "upcoming" = draft/scheduled/live,
// nearest first BY ABSOLUTE INSTANT (not local wall-clock -- that re-sort is
// retired, see the CR-1 test below); "past" = completed only, most-recent
// first. fetchMyPractices() fetches BOTH buckets, so every test that mocks
// getMyPractices needs a bucket-aware response regardless of which bucket
// the test cares about.
function mockBucketedPractices(items: PracticeResponse[]): void {
  vi.mocked(mastersApi.getMyPractices).mockImplementation(
    async (bucket: 'upcoming' | 'past', limit = 20, offset = 0) => {
      const filtered = items
        .filter((p) =>
          bucket === 'upcoming'
            ? p.status === 'draft' || p.status === 'scheduled' || p.status === 'live'
            : p.status === 'completed',
        )
        .sort((a, b) => {
          const diff = new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
          return bucket === 'upcoming' ? diff : -diff
        })
      return page(filtered.slice(offset, offset + limit), filtered.length, offset)
    },
  )
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// The SAME pinia instance goes to setActivePinia and app.use (SC-03): two
// instances means the test drives one store while the screen renders another,
// and every assertion passes while proving nothing.
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterDashboardView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). The deepest chain onMounted
// (.vue:383-397) kicks off is the SEQUENTIAL profile -> practices one:
//   (1) await getMyMasterProfile inside fetchMyProfile
//   (2) fetchMyProfile's promise resolves -> onMounted resumes
//   (3) await getMyPractices inside usePagination.loadMore
//   (4) loadMore resolves -> (5) refresh's continuation -> (6) fetchMyPractices'
//   (7) onMounted resumes -> the final re-render.
// The fire-and-forget loadStats() runs alongside and is 2 deep. Seven counted;
// ten written. Over-counting is free, under-counting fails loudly, and this
// chain grows the moment anything joins that onMounted.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

// Intl groups / spaces with U+00A0, U+202F or U+2009 depending on the Node/ICU
// build, so all three are flattened rather than pinning one and breaking on a
// runtime upgrade for no reason. ESCAPES, never literals (see the banner).
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

function text(): string {
  return norm(host?.textContent)
}

// -----------------------------------------------------------------------------
// Scoped queries
// -----------------------------------------------------------------------------

function blocks(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.master-dashboard__practice-block') ?? [])
}
function titles(): string[] {
  return blocks().map(
    (b) => b.querySelector('.master-dashboard__practice-title')?.textContent?.trim() ?? '',
  )
}
function subOf(b: HTMLElement): string {
  return norm(b.querySelector('.master-dashboard__practice-sub')?.textContent).trim()
}
function metaOf(b: HTMLElement): string[] {
  return Array.from(b.querySelectorAll('.master-dashboard__meta-item')).map((e) =>
    norm(e.textContent).trim(),
  )
}
/** The card body (tappable), as distinct from the actions row beneath it. */
function cardOf(b: HTMLElement): HTMLElement {
  const card = b.querySelector<HTMLElement>('.master-dashboard__practice-card')
  if (!card) throw new Error('the practice card did not render')
  return card
}
function actionIn(b: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(
    b.querySelectorAll<HTMLButtonElement>('.master-dashboard__practice-actions button'),
  ).find((btn) => btn.textContent?.trim() === label)
}

/** A stat card's value / delta, found by its LABEL -- the cards are positional otherwise. */
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
function statDelta(label: string): HTMLElement | null {
  return statCard(label).querySelector<HTMLElement>('.v-stat__delta')
}

function periodButton(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

/** VCards in document order: [0] is always the «Саммари недели» card (.vue:106-111);
 *  [1] is the nearest-practices empty card, present only when there is nothing to show. */
function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-card') ?? [])
}
function summaryCard(): HTMLElement {
  const card = cards()[0]
  if (!card) throw new Error('the summary card did not render')
  return card
}
function nearestEmptyCard(): HTMLElement | undefined {
  return cards()[1]
}

function sectionTitles(): string[] {
  return Array.from(host?.querySelectorAll('.velo-section-title') ?? []).map(
    (h) => h.textContent?.trim() ?? '',
  )
}

/** The zero-state CTA (.vue:89-96). Matched on exact text so the Zoom / Check-ins
 *  card actions can never be mistaken for it. */
function createCta(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Создать практику',
  )
}

function onboardingOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.master-onboarding-overlay')
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  // Fake timers, not a bare setSystemTime: the screen installs a 60s setInterval
  // (.vue:384-386) that this file drives directly in the clock test below. Nothing
  // in the mount chain awaits a timer (the API is mocked and usePagination holds
  // none), and microtasks are not faked, so flush() is unaffected.
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(mastersApi.getMyMasterProfile).mockReset().mockResolvedValue(PROFILE)
  vi.mocked(mastersApi.getMyPractices).mockReset()
  mockBucketedPractices([P_LATER, P_SOON, P_THIRD])
  vi.mocked(mastersApi.getMasterStats)
    .mockReset()
    .mockImplementation(async (period) => (period === 'month' ? STATS_MONTH : STATS_WEEK))
  vi.mocked(usersApi.updateMe)
    .mockReset()
    .mockImplementation(async () => user({ master_onboarding_completed: true }))

  useAuthStore().user = user()

  push.mockReset()
  toastInfo.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  platformState.openLink.mockReset()
  vi.mocked(practicesApi.createZoomStartTicket).mockReset()
  vi.mocked(practicesApi.retryZoomMeeting).mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13. This screen's ONLY teleport is the onboarding overlay (.vue:203-211),
  // and it is a bare v-if with no <Transition>, so unmount() genuinely reaps it
  // and this purge is a no-op today. Kept unconditional and idempotent because
  // the day it gains a leave-transition, Vue will park the closed overlay on
  // document.body pending a transitionend happy-dom never fires -- and the next
  // test would then read a corpse belonging to an unmounted app while this
  // screen was innocent. Free insurance against the most expensive mistake in
  // this skill's history.
  document.body.querySelectorAll('.master-onboarding-overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MasterDashboardView', () => {
  // ===========================================================================
  describe('the ladder', () => {
    it('loading: shows the skeleton and NOTHING else while the profile is in flight', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.master-dashboard__skeleton')).not.toBeNull()
      // The whole body is behind the same v-if (.vue:28-34), so the bell, the
      // stats and the sections must all be absent -- not merely "the loader is
      // also there".
      expect(host?.querySelector('.master-dashboard__bell')).toBeNull()
      expect(host?.querySelectorAll('.v-stat')).toHaveLength(0)
      expect(sectionTitles()).toEqual([])
    })

    it('loading: the practices half has its OWN loader, under a resolved profile', async () => {
      // .vue:120-124 -- practicesLoading gates only the «Ближайшие практики»
      // section, so the stats and the summary stay on screen while it spins.
      vi.mocked(mastersApi.getMyPractices).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.master-dashboard__skeleton')).toBeNull()
      expect(host?.querySelector('.master-dashboard__loading-row')).not.toBeNull()
      expect(blocks()).toHaveLength(0)
      expect(statValue('Практик')).toBe('12')
    })

    it('empty: a brand-new master gets the zero state, not an empty list', async () => {
      mockBucketedPractices([])
      mount()
      await flush()

      expect(blocks()).toHaveLength(0)
      expect(createCta()).toBeDefined()
      expect(norm(nearestEmptyCard()?.textContent).trim()).toBe(EMPTY_NEW)
      expect(sectionTitles()).toEqual(['Саммари недели', 'Ближайшая практика'])
    })

    it('content: renders each upcoming practice with its own date, time and duration', async () => {
      mount()
      await flush()

      expect(titles()).toEqual(['Утренняя практика', 'Вечерняя практика'])
      // formatDateShort resolves «Завтра» against the FROZEN instant, in the
      // practice's zone -- this line is the whole reason time is pinned.
      expect(subOf(blocks()[0]!)).toBe('Завтра, 07:00 • 45 мин')
      expect(subOf(blocks()[1]!)).toBe('25 июля, 10:00 • 1 ч 30 м')
      expect(host?.querySelector('.master-dashboard__loading-row')).toBeNull()
      expect(nearestEmptyCard()).toBeUndefined()
    })

    it('content: the meta row carries participants and the owner check-in count', async () => {
      mount()
      await flush()

      // formatParticipants -> «5/20»; checkinLabel -> «3/20» (checkin_count /
      // max_participants, utils/practiceCardMeta.ts:32-36).
      expect(metaOf(blocks()[0]!)).toEqual(['5/20', '3/20'])
    })

    it('content: omits the check-in badge entirely when the count is null', async () => {
      // checkin_count is null for a non-owner read. «0/12» there would fabricate
      // a count for a viewer not entitled to one, so the v-if drops the badge
      // (.vue:156-158). P_LATER carries no checkin_count.
      mount()
      await flush()

      expect(metaOf(blocks()[1]!)).toEqual(['8/12'])
    })

    it('content: a series adds its weekday list and its remaining-sessions row', async () => {
      mockBucketedPractices([P_SERIES])
      mount()
      await flush()

      // recurrenceLabel([1,3,5]) -> the weekday abbreviations; 8 - 3 = 5 left.
      expect(metaOf(blocks()[0]!)).toEqual([
        '6/10',
        '4/10',
        'Пн, Ср, Пт',
        'Осталось 5 из 8 занятий',
      ])
      expect(blocks()[0]?.querySelector('.master-dashboard__practice-meta--row2')).not.toBeNull()
    })

    it('a FAILED profile load renders a normal-looking dashboard (known gap)', async () => {
      // Asserted because it is what the screen DOES, not because it is right.
      // fetchMyProfile swallows into profileError (stores/master.ts:65-71), and
      // this template never binds it -- there is no error rung at all. The
      // skeleton is gated on `profileLoading && !profile` (.vue:28), which is
      // false once the request has failed, so the master sees a complete,
      // confident dashboard built on a profile that never arrived. Reported as
      // a finding; this test is the tripwire for the day it is repaired.
      vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(
        new ApiResponseError(503, 'Профиль недоступен', 'profile_down'),
      )
      mount()
      await flush()

      expect(host?.querySelector('.master-dashboard__skeleton')).toBeNull()
      expect(host?.querySelector('.master-dashboard__bell')).not.toBeNull()
      expect(text()).not.toContain('Профиль недоступен')
      expect(titles()).toEqual(['Утренняя практика', 'Вечерняя практика'])
    })

    it('a FAILED practices load reads as «you have no practices» (known gap)', async () => {
      // Same shape, and the more costly one: usePagination catches into `error`
      // (composables/usePagination.ts:67-70), the store re-exports it as
      // practicesError, and this template never binds it either. A network
      // failure is therefore rendered as the factual CLAIM that the master has
      // no practices -- with the «Создать практику» CTA under it, inviting them
      // to make a duplicate. Reported; asserted as the tripwire.
      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(new TypeError('network down'))
      mount()
      await flush()

      expect(blocks()).toHaveLength(0)
      expect(norm(nearestEmptyCard()?.textContent).trim()).toBe(EMPTY_NEW)
      expect(createCta()).toBeDefined()
      expect(host?.querySelector('.master-dashboard__loading-row')).toBeNull()
    })
  })

  // ===========================================================================
  describe('nearestPractices -- which practices survive the filter', () => {
    it('keeps only scheduled and live, dropping draft / cancelled / completed', async () => {
      mockBucketedPractices([P_DRAFT, P_CANCELLED, P_COMPLETED, P_SOON])
      mount()
      await flush()

      expect(titles()).toEqual(['Утренняя практика'])
    })

    it('keeps a LIVE practice and sorts it ahead of the next scheduled one', async () => {
      mockBucketedPractices([P_SOON, P_LIVE])
      mount()
      await flush()

      expect(titles()).toEqual(['Идёт сейчас', 'Утренняя практика'])
    })

    it('drops a practice the instant it ends -- boundary is inclusive', async () => {
      // P_JUST_ENDED ends at EXACTLY the frozen instant. practiceHasEnded is
      // `now >= end`, so it is over; P_LIVE ends 45 min later and stays.
      mockBucketedPractices([P_JUST_ENDED, P_LIVE])
      mount()
      await flush()

      expect(titles()).toEqual(['Идёт сейчас'])
    })

    it('renders the SERVER order verbatim -- no client re-sort (T22-3, ПРОМТ №561)', async () => {
      // Was CR-1 ("sorts by LOCAL wall clock, not by the absolute instant"):
      // nearestPractices used to re-derive its own order via localSortKey. That
      // client-side re-sort is gone by owner decision -- the server now owns
      // ordering entirely (listing_service.py's bucket ordering), so this
      // proves the negative: the two practices' absolute (UTC) order and their
      // local-wall-clock order DISAGREE, and the dashboard renders whatever
      // order the (correctly UTC-ascending) server response gave it.
      //   TZ_SORT_A (Токио)     20:00Z -> local wall-clock 22 July 05:00
      //   TZ_SORT_B (Нью-Йорк)  22:00Z -> local wall-clock 21 July 18:00
      // By local wall-clock, Нью-Йорк would sort first (21 July before 22 July)
      // -- the old CR-1 assertion. The server orders ascending by the absolute
      // instant instead (TZ_SORT_A 20:00Z < TZ_SORT_B 22:00Z), and the
      // dashboard must preserve exactly that order.
      mockBucketedPractices([TZ_SORT_A, TZ_SORT_B])
      mount()
      await flush()

      expect(titles()).toEqual(['Токио', 'Нью-Йорк'])
      // Proof the premise holds -- the rendered times really are the ones the
      // local-wall-clock ordering (now retired) would have disagreed on.
      expect(subOf(blocks()[0]!)).toBe('22 июля, 05:00 • 1 час')
      expect(subOf(blocks()[1]!)).toBe('Завтра, 18:00 • 1 час')
    })

    it('caps the preview at 2, regardless of how many are upcoming', async () => {
      mockBucketedPractices([P_THIRD, P_LATER, P_SOON])
      mount()
      await flush()

      expect(blocks()).toHaveLength(2)
      expect(titles()).toEqual(['Утренняя практика', 'Вечерняя практика'])
      expect(text()).not.toContain('Третья практика')
    })

    it('the 60s clock drops a card the moment its practice ends', async () => {
      // The whole point of `now` being a REACTIVE ref on a 60s interval
      // (.vue:302-303,384-386) rather than a value read once at setup: a master
      // who leaves the dashboard open must not keep seeing a finished practice.
      // P_LIVE ends at 12:45Z.
      mockBucketedPractices([P_LIVE, P_LATER])
      mount()
      await flush()
      expect(titles()).toEqual(['Идёт сейчас', 'Вечерняя практика'])

      vi.setSystemTime(new Date('2026-07-20T12:46:00Z'))
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()

      expect(titles()).toEqual(['Вечерняя практика'])
    })

    it('the heading follows the count: singular for one, plural for two', async () => {
      mockBucketedPractices([P_SOON])
      mount()
      await flush()
      expect(sectionTitles()).toEqual(['Саммари недели', 'Ближайшая практика'])

      app?.unmount()
      host?.remove()
      pinia = createPinia()
      setActivePinia(pinia)
      useAuthStore().user = user()
      mockBucketedPractices([P_SOON, P_LATER])
      mount()
      await flush()

      expect(sectionTitles()).toEqual(['Саммари недели', 'Ближайшие практики'])
    })
  })

  // ===========================================================================
  describe('isNewMaster -- the zero state is about PRACTICES EVER, not upcoming', () => {
    it('a master with only past practices is NOT new: real headings, real summary', async () => {
      // practicesTotal is 3 even though nothing is upcoming (.vue:247-249).
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([P_COMPLETED, P_JUST_ENDED, P_CANCELLED]),
      )
      mount()
      await flush()

      expect(text()).toContain('Статистика')
      expect(text()).not.toContain('Моя статистика')
      // The summary card is tappable and teases real content...
      expect(summaryCard().className).toContain('v-card--clickable')
      expect(summaryCard().textContent?.trim()).toBe('Сводка появится с аналитикой')
      // ...and the empty card says «нет предстоящих», not «нет данных».
      expect(norm(nearestEmptyCard()?.textContent).trim()).toBe('Нет предстоящих практик')
    })

    it('but still offers «Создать практику» -- the CTA tracks UPCOMING, not ever', async () => {
      // .vue:87-88: shown whenever there is no upcoming practice, not only to
      // brand-new masters. The «первую» wording was dropped for exactly this.
      mockBucketedPractices([P_COMPLETED])
      mount()
      await flush()

      expect(createCta()).toBeDefined()
      expect(text()).not.toContain('Создать первую практику')
    })

    it('a brand-new master gets «Моя статистика» and an inert summary card', async () => {
      mockBucketedPractices([])
      mount()
      await flush()

      expect(text()).toContain('Моя статистика')
      expect(summaryCard().className).not.toContain('v-card--clickable')
      expect(norm(summaryCard().textContent).trim()).toBe(EMPTY_NEW)

      summaryCard().click()
      await flush()
      expect(push).not.toHaveBeenCalled()
    })

    it('hides the CTA once something is upcoming', async () => {
      mount()
      await flush()

      expect(createCta()).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('the stats row (E7 -- period-scoped, despite the header comment)', () => {
    it('reads «—», not «0», before the fetch resolves', async () => {
      // .vue:262-267: `stats.value ? ... : '—'`. A 0 there would be the claim
      // that this master ran nothing this week; the em dash says "not known yet".
      vi.mocked(mastersApi.getMasterStats).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(statValue('Практик')).toBe(DASH)
      expect(statValue('Участников')).toBe(DASH)
      expect(statDelta('Практик')).toBeNull()
    })

    it('renders the week figures with signed, rounded, toned deltas', async () => {
      mount()
      await flush()

      expect(statValue('Практик')).toBe('12')
      expect(norm(statDelta('Практик')?.textContent).trim()).toBe('+23%')
      expect(statDelta('Практик')?.className).toContain('v-stat__delta--up')

      expect(statValue('Участников')).toBe('148')
      // -8.6 -> Math.round -> -9, rendered with U+2212, NOT an ASCII hyphen.
      expect(norm(statDelta('Участников')?.textContent).trim()).toBe(`${MINUS}9%`)
      expect(statDelta('Участников')?.className).toContain('v-stat__delta--down')
    })

    it('«Месяц» refetches and every figure moves', async () => {
      mount()
      await flush()
      expect(statValue('Практик')).toBe('12')

      periodButton('Месяц')?.click()
      await flush()

      expect(statValue('Практик')).toBe('40')
      expect(statValue('Участников')).toBe('500')
      expect(periodButton('Месяц')?.getAttribute('aria-selected')).toBe('true')
      expect(periodButton('Неделя')?.getAttribute('aria-selected')).toBe('false')
    })

    it('a flat period reads «0%» and is toned muted, not up', async () => {
      // deltaTone (.vue:277-280) returns 'muted' for a rounded zero: a teal «0%»
      // would read as growth. STATS_MONTH.practices_delta_pct is 0.
      mount()
      await flush()
      periodButton('Месяц')?.click()
      await flush()

      expect(norm(statDelta('Практик')?.textContent).trim()).toBe('0%')
      expect(statDelta('Практик')?.className).toContain('v-stat__delta--muted')
    })

    it('hides the delta entirely when the backend sends null', async () => {
      // null = the previous period had no baseline. «0%» there would claim flat.
      // deltaStr returns '' and VStatCard's `v-if="delta"` drops the node.
      mount()
      await flush()
      periodButton('Месяц')?.click()
      await flush()

      expect(statValue('Участников')).toBe('500')
      expect(statDelta('Участников')).toBeNull()
    })

    it('a FAILED stats fetch leaves «—» and the rest of the screen alive', async () => {
      // .vue:388-390 swallows deliberately. The practices list is unrelated data.
      vi.mocked(mastersApi.getMasterStats).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(statValue('Практик')).toBe(DASH)
      expect(titles()).toEqual(['Утренняя практика', 'Вечерняя практика'])
      expect(text()).not.toContain('boom')
    })

    it('a failed REFETCH keeps the previous figures rather than blanking them', async () => {
      // The watch's `.catch(() => {})` (.vue:288-292) is deliberate. Note what it
      // costs and what is asserted: the numbers on screen are now the WEEK's
      // while the toggle reads «Месяц», and nothing says so.
      mount()
      await flush()
      expect(statValue('Практик')).toBe('12')

      vi.mocked(mastersApi.getMasterStats).mockRejectedValue(new TypeError('boom'))
      periodButton('Месяц')?.click()
      await flush()

      expect(statValue('Практик')).toBe('12')
      expect(statValue('Участников')).toBe('148')
      expect(periodButton('Месяц')?.getAttribute('aria-selected')).toBe('true')
    })

    it('re-picking the CURRENT period does not refetch', async () => {
      // watch(period) fires on CHANGE only. One of two call-shape assertions in
      // this file: a no-op refetch renders identically, so nothing on screen can
      // distinguish it.
      mount()
      await flush()
      expect(mastersApi.getMasterStats).toHaveBeenCalledTimes(1)
      expect(mastersApi.getMasterStats).toHaveBeenCalledWith('week')

      periodButton('Неделя')?.click()
      await flush()

      expect(mastersApi.getMasterStats).toHaveBeenCalledTimes(1)
    })

    it('renders exactly two stat cards -- income is NOT one of them', async () => {
      // income_cents IS in the payload (STATS_WEEK: 123456) and is deliberately
      // not rendered here (.vue:61,253-254) -- it lives on Finance/Analytics.
      // This is also why the ru NBSP money trap does not bite this screen.
      mount()
      await flush()

      expect(host?.querySelectorAll('.v-stat')).toHaveLength(2)
      expect(text()).not.toContain('1 234,56')
      expect(text()).not.toContain('Доход')
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('tapping a practice card opens THAT practice, with its own id', async () => {
      mount()
      await flush()

      cardOf(blocks()[1]!).click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-practice-detail', params: { id: 'p2' } })
    })

    it('«Check-ins» opens attendance for THAT practice, not the detail screen', async () => {
      mount()
      await flush()

      actionIn(blocks()[0]!, 'Check-ins')?.click()
      await flush()

      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith({ name: 'master-attendance', params: { id: 'p1' } })
    })

    it('«Создать практику» opens the create form', async () => {
      mockBucketedPractices([])
      mount()
      await flush()

      createCta()?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-practice-new' })
    })

    it('«Мои группы» navigates to master-groups (P2, ПРОМТ №591)', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu-row')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-groups' })
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('the summary card opens the full weekly summary', async () => {
      mount()
      await flush()

      summaryCard().click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-summary' })
    })
  })

  // ===========================================================================
  describe('the stub actions (asserted as the stubs they are -- SC-09)', () => {
    it('the bell toasts and never navigates', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.master-dashboard__bell')?.click()
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Уведомления пока недоступны')
      expect(push).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('Zoom', () => {
    it('opens a real https link through the platform, not window.open', async () => {
      mount()
      await flush()

      actionIn(blocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(platformState.openLink).toHaveBeenCalledWith('https://zoom.us/j/111')
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('T21-1: with no link on either rung, the Zoom button is disabled (not just a nudge on click)', async () => {
      mount()
      await flush()

      // blocks()[1] carries no zoom_link and no host registrant link (T21-1
      // ПРОМТ №541 supersedes the old "click a live button, get a toast"
      // behaviour -- the button itself is now disabled, same posture as the
      // user-facing screens).
      const zoomBtn = actionIn(blocks()[1]!, 'Zoom')
      expect(zoomBtn?.disabled).toBe(true)
      zoomBtn?.click() // a disabled <button> fires no click handler in happy-dom
      await flush()
      expect(platformState.openLink).not.toHaveBeenCalled()
    })

    it('T21-1/ПРОМТ №565: a personal host registrant link (kind===personal) takes priority over the manual zoom_link, and starts the meeting as host via the ticket flow -- NOT by opening the raw registrant link', async () => {
      // zoom_host_join_url is a plain Zoom REGISTRANT join_url (see
      // MasterDashboardView.vue's onZoom comment) -- opening it directly, as
      // this test used to assert, lands the master on Zoom's "waiting for
      // the host" screen. kind==='personal' must now go through
      // createZoomStartTicket + zoomStartRedirectUrl instead.
      vi.stubEnv('VITE_API_BASE_URL', 'https://velo-backend.test')
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([
          practice('withHost', {
            title: 'С хост-ссылкой',
            zoom_link: 'https://zoom.us/j/manual',
            zoom_host_join_url: 'https://zoom.us/w/host?tk=xyz',
          }),
        ]),
      )
      vi.mocked(practicesApi.createZoomStartTicket).mockResolvedValue({ ticket: 'tkt_abc' })
      mount()
      await flush()

      actionIn(blocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(practicesApi.createZoomStartTicket).toHaveBeenCalledWith('withHost')
      expect(platformState.openLink).not.toHaveBeenCalledWith('https://zoom.us/w/host?tk=xyz')
      expect(platformState.openLink).toHaveBeenCalledWith(
        'https://velo-backend.test/api/v1/practices/zoom/start?ticket=tkt_abc',
      )
    })

    it('ПРОМТ №565: kind===personal, but no active meeting anymore (zoom_meeting_not_active) -- honest error, no crash', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://velo-backend.test')
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([practice('withHost', { zoom_host_join_url: 'https://zoom.us/w/host?tk=xyz' })]),
      )
      vi.mocked(practicesApi.createZoomStartTicket).mockRejectedValue(
        new ApiResponseError(
          400,
          'No active Zoom meeting for this practice',
          'zoom_meeting_not_active',
        ),
      )
      mount()
      await flush()

      actionIn(blocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Встреча Zoom для этой практики недоступна')
      expect(platformState.openLink).not.toHaveBeenCalled()
    })

    it('ПРОМТ №565/№557: kind===personal, VITE_API_BASE_URL not configured -- fails closed, no foreign redirect', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '')
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([practice('withHost', { zoom_host_join_url: 'https://zoom.us/w/host?tk=xyz' })]),
      )
      vi.mocked(practicesApi.createZoomStartTicket).mockResolvedValue({ ticket: 'tkt_abc' })
      mount()
      await flush()

      actionIn(blocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Функция временно недоступна')
      expect(platformState.openLink).not.toHaveBeenCalled()
    })

    it('ПРОМТ №565: the Zoom button is disabled while a start-ticket request is in flight', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://velo-backend.test')
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([practice('withHost', { zoom_host_join_url: 'https://zoom.us/w/host?tk=xyz' })]),
      )
      let resolveTicket!: (v: { ticket: string }) => void
      vi.mocked(practicesApi.createZoomStartTicket).mockReturnValue(
        new Promise((resolve) => {
          resolveTicket = resolve
        }),
      )
      mount()
      await flush()

      const zoomBtn = actionIn(blocks()[0]!, 'Zoom')
      zoomBtn?.click()
      await flush()

      expect(actionIn(blocks()[0]!, 'Zoom')?.disabled).toBe(true)

      resolveTicket({ ticket: 'tkt_abc' })
      await flush()

      expect(actionIn(blocks()[0]!, 'Zoom')?.disabled).toBe(false)
    })

    it('T21-1: no host link but a valid manual zoom_link -- button enabled, "not counted" mark shown', async () => {
      mount()
      await flush()

      // blocks()[0] is P_SOON: https zoom_link, no host link set.
      expect(actionIn(blocks()[0]!, 'Zoom')?.disabled).toBe(false)
      expect(host?.textContent).toContain('посещение не засчитается')
    })

    // =========================================================================
    // A4 V2 (ПРОМТ №572): create_failed replaces "Zoom" with "Повторить".
    // Before this, create_failed and pending_creation both rendered the
    // identical disabled "Zoom" button -- indistinguishable to the master,
    // and no way to act on the permanent one.
    // =========================================================================
    describe('create_failed: "Повторить" (A4 V2, ПРОМТ №572)', () => {
      it('shows "Повторить" instead of "Zoom", plus the honest failed badge', async () => {
        vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
          page([practice('failed1', { zoom_meeting_status: 'create_failed' })]),
        )
        mount()
        await flush()

        expect(actionIn(blocks()[0]!, 'Zoom')).toBeUndefined()
        expect(actionIn(blocks()[0]!, 'Повторить')).toBeDefined()
        expect(host?.textContent).toContain('Не удалось создать встречу Zoom')
      })

      it('pending_creation (still queued) keeps the disabled "Zoom" button -- no "Повторить"', async () => {
        // The discriminator: pending_creation must NOT get the retry button.
        vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
          page([practice('pending1', { zoom_meeting_status: 'pending_creation' })]),
        )
        mount()
        await flush()

        expect(actionIn(blocks()[0]!, 'Повторить')).toBeUndefined()
        expect(actionIn(blocks()[0]!, 'Zoom')?.disabled).toBe(true)
      })

      it('a successful retry toasts success and refreshes the list', async () => {
        vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
          page([
            practice('failed1', { title: 'Провалившаяся', zoom_meeting_status: 'create_failed' }),
          ]),
        )
        vi.mocked(practicesApi.retryZoomMeeting).mockResolvedValue(
          practice('failed1', { title: 'Провалившаяся', zoom_meeting_status: 'active' }),
        )
        mount()
        await flush()
        const callsBefore = vi.mocked(mastersApi.getMyPractices).mock.calls.length

        actionIn(blocks()[0]!, 'Повторить')?.click()
        await flush()

        expect(practicesApi.retryZoomMeeting).toHaveBeenCalledWith('failed1')
        expect(toastSuccess).toHaveBeenCalledWith('Встреча Zoom создана')
        expect(toastError).not.toHaveBeenCalled()
        // refreshMyPractices() re-fetches both buckets -- proof the list
        // was actually invalidated, not just the toast fired.
        expect(vi.mocked(mastersApi.getMyPractices).mock.calls.length).toBeGreaterThan(callsBefore)
      })

      it('a retry that fails AGAIN reports it honestly -- the endpoint resolves 200 either way', async () => {
        // attempt_zoom_meeting_create never raises (backend "never blocks"
        // contract) -- the endpoint itself returns 200 whether Zoom's own
        // attempt succeeded or not, so success/failure must be read off the
        // RETURNED zoom_meeting_status, not off a thrown error.
        vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
          page([practice('failed1', { zoom_meeting_status: 'create_failed' })]),
        )
        vi.mocked(practicesApi.retryZoomMeeting).mockResolvedValue(
          practice('failed1', { zoom_meeting_status: 'create_failed' }),
        )
        mount()
        await flush()

        actionIn(blocks()[0]!, 'Повторить')?.click()
        await flush()

        expect(toastError).toHaveBeenCalledWith(
          'Всё ещё не удалось создать встречу. Попробуйте позже',
        )
        expect(toastSuccess).not.toHaveBeenCalled()
      })

      it('the button is disabled while a retry is in flight, and does not double-submit', async () => {
        vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
          page([practice('failed1', { zoom_meeting_status: 'create_failed' })]),
        )
        let resolveRetry!: (v: PracticeResponse) => void
        vi.mocked(practicesApi.retryZoomMeeting).mockReturnValue(
          new Promise((resolve) => {
            resolveRetry = resolve
          }),
        )
        mount()
        await flush()

        const btn = actionIn(blocks()[0]!, 'Повторить')
        btn?.click()
        await nextTick()
        expect(actionIn(blocks()[0]!, 'Повторить')?.disabled).toBe(true)
        btn?.click()
        await nextTick()

        expect(practicesApi.retryZoomMeeting).toHaveBeenCalledTimes(1)

        resolveRetry(practice('failed1', { zoom_meeting_status: 'active' }))
        await flush()
      })
    })

    it('refuses a non-https link on EITHER rung rather than handing it to the platform', async () => {
      // resolveZoomLink's https guard (utils/zoomLink.ts). A stored `http://`
      // or a `javascript:` string must never reach openLink on either rung --
      // the guard is the point.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([practice('bad', { title: 'Плохая ссылка', zoom_link: 'http://zoom.us/j/222' })]),
      )
      mount()
      await flush()

      const zoomBtn = actionIn(blocks()[0]!, 'Zoom')
      expect(zoomBtn?.disabled).toBe(true)
      zoomBtn?.click()
      await flush()

      expect(platformState.openLink).not.toHaveBeenCalled()
    })

    it('tapping Zoom does not also open the practice', async () => {
      // The actions row is a SIBLING of the tappable card (.vue:175-184), not a
      // child, so no @click.stop is needed. Pinned: nest it and every Zoom tap
      // silently navigates away instead.
      mount()
      await flush()

      actionIn(blocks()[0]!, 'Zoom')?.click()
      await flush()

      expect(push).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('the post-approval onboarding overlay', () => {
    function armCarousel(): void {
      useAuthStore().user = user({ master_onboarding_completed: false })
    }

    it('shows for a verified master who has never completed it', async () => {
      armCarousel()
      mount()
      await flush()

      expect(onboardingOverlay()).not.toBeNull()
      expect(onboardingOverlay()?.textContent).toContain('Добро пожаловать')
    })

    it('stays away once the persisted server flag says done', async () => {
      // The default fixture: master_onboarding_completed true (E15).
      mount()
      await flush()

      expect(onboardingOverlay()).toBeNull()
    })

    it('stays away while the profile is not verified', async () => {
      armCarousel()
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue({ ...PROFILE, status: 'pending' })
      mount()
      await flush()

      expect(onboardingOverlay()).toBeNull()
    })

    it('stays away for an account that is not a master', async () => {
      useAuthStore().user = user({ role: 'user', master_onboarding_completed: false })
      mount()
      await flush()

      expect(onboardingOverlay()).toBeNull()
    })

    it('«Пропустить» hides it AND persists the flag', async () => {
      // toBeNull() is honest here, unlike on a VModal (SC-13b): this overlay is a
      // bare v-if inside the Teleport with NO <Transition> (.vue:203-211), so
      // there is no leave to park. Pinned present first, so it cannot always-pass.
      armCarousel()
      mount()
      await flush()
      expect(onboardingOverlay()).not.toBeNull()

      onboardingOverlay()?.querySelector<HTMLButtonElement>('.master-onboarding__skip')?.click()
      await flush()

      expect(onboardingOverlay()).toBeNull()
      // The second and last call-shape assertion in this file: persistence is
      // invisible in the DOM, and the WHOLE point of the E15 flag is that the
      // carousel stays gone on the next device. Nothing rendered can prove it.
      expect(usersApi.updateMe).toHaveBeenCalledWith({ master_onboarding_completed: true })
    })

    it('«Войти в кабинет» on the last slide finishes it too', async () => {
      armCarousel()
      mount()
      await flush()

      const primary = (): HTMLButtonElement | null =>
        onboardingOverlay()?.querySelector<HTMLButtonElement>('.master-onboarding__button') ?? null
      expect(primary()?.textContent?.trim()).toBe('Далее')
      primary()?.click()
      await flush()
      primary()?.click()
      await flush()
      expect(primary()?.textContent?.trim()).toBe('Войти в кабинет')

      primary()?.click()
      await flush()

      expect(onboardingOverlay()).toBeNull()
      expect(usersApi.updateMe).toHaveBeenCalledWith({ master_onboarding_completed: true })
    })

    it('a FAILED persist still keeps it hidden for this session', async () => {
      // .vue:371-380 is best-effort by design: the session guard already stops a
      // re-show, so a PATCH failure must never bounce the carousel back over the
      // dashboard the master is already reading.
      armCarousel()
      vi.mocked(usersApi.updateMe).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      onboardingOverlay()?.querySelector<HTMLButtonElement>('.master-onboarding__skip')?.click()
      await flush()

      expect(onboardingOverlay()).toBeNull()
      expect(text()).not.toContain('boom')
    })

    it('the session guard survives a remount, so it cannot re-show', async () => {
      // The guard lives in the STORE, not in the view (.vue:349-354,367), so
      // navigating away and back must not replay the carousel. Same pinia, same
      // store instance -- exactly what a route change does.
      armCarousel()
      mount()
      await flush()
      onboardingOverlay()?.querySelector<HTMLButtonElement>('.master-onboarding__skip')?.click()
      await flush()
      expect(useMasterStore().onboardingShownThisSession).toBe(true)

      app?.unmount()
      host?.remove()
      // The PATCH round-trip is what would normally flip the server flag; keep
      // the user object stale on purpose, so the SESSION guard is the only thing
      // that can be holding the overlay back.
      useAuthStore().user = user({ master_onboarding_completed: false })
      mount()
      await flush()

      expect(onboardingOverlay()).toBeNull()
    })
  })

  // ===========================================================================
  // NOT COVERED, deliberately
  //
  // - The unread bell BADGE (.vue:42): `unreadCount` is `computed(() => 0)`
  //   (.vue:295) with no feed behind it, so the badge is unreachable by any
  //   input. A test would assert a literal 0 the screen hardcodes, not a
  //   behaviour (SC-01). The bell's honest stub -- the toast -- IS covered.
  // - The practice ICON (`practiceIconFor`, .vue:141): a pure direction ->
  //   component lookup with its own test (utils/displayHelpers.test.ts). This
  //   screen only forwards `practice` to it.
  // - Keyboard activation of the practice card (@keydown.enter.space, .vue:137):
  //   the handler is the same openPractice already covered through the click
  //   path; a second test would assert Vue's modifier, not this screen.
  // - `contentSafeTop` on the onboarding overlay (.vue:207): useSafeArea reads
  //   Telegram viewport signals that are never mounted outside Telegram and
  //   return a constant 0 by design (useSafeArea.ts:57-63). Asserting
  //   `paddingTop: 0px` would assert the guard, not the formula. It is
  //   Telegram-runtime behaviour, out of reach of happy-dom.
  // - VStatCard / VSegmentTrack / VMenuRow / VCard internals: DS primitives with
  //   their own homes. Asserted here only through the values this screen feeds
  //   them and the classes it reads back.
  // - masterNoProfileGuard on this route (router/index.ts): guards are exercised
  //   BARE in router/guards.test.ts, per velo-idiom §6. A screen test that
  //   mocks vue-router cannot reach it, and building a real router to try is the
  //   thing that idiom exists to forbid.
  // - The onboarding CAROUSEL's own slide content and dots: MasterOnboardingView
  //   is a separate presentational view; this file asserts only the GATE that
  //   decides whether it appears and the `done` contract that dismisses it.
  // ===========================================================================
})
