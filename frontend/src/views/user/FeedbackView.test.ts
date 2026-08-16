// =============================================================================
// VELO Frontend -- FeedbackView Screen Tests
// =============================================================================
//
// WHY: this is the second of three FormShell consumers and it was the LAST
// user-zone write with no coverage at all. `POST /practices/{id}/feedback` is an
// upsert (api/diary.ts:96-102 -- "repeated calls overwrite"), so unlike its
// sibling CheckinView the backend will accept a second one and this screen's own
// guards are thinner: `onSubmit` (.vue:111) gates on `feedbackSubmitting` and
// NOTHING else, and `:submit-disabled="false"` (.vue:20) is a hard-coded literal.
// The whole surface between a tap and that POST is therefore ONE ref, and this
// file is the only thing holding it.
//
// PATTERN A/C HYBRID, and the split matters (skill Step 3). The DATA half is
// store-backed -- `practice` / `practiceLoading` are computeds over
// practicesStore (.vue:103-104) -- so the seam is the api wrapper the store
// imports (@/api/practices) and the ladder is driven by controlling that mock.
// The FORM half is local refs (`ratingScore`, `comment`, `submitted`,
// .vue:106-108) and is driven ONLY through real DOM: the slider card is clicked,
// the textarea receives a real input event. Poking those refs would assert this
// file's own fixture.
//
// All three stores are REAL (practices + diary + bookings), for the same reason
// CheckinView's are: the re-entry guard reads `diaryStore.feedbackSubmitting`, a
// ref only the real store flips (diary.ts:98). Mock the diary store and that ref
// is a frozen `false`, the double-click test exercises nothing, and it passes for
// the wrong reason. Real stores also let the post-submit refresh be proven at the
// NETWORK (getMyBookings) rather than as a spy call count (SC-02).
// ONE pinia instance goes to both setActivePinia and app.use (SC-03).
//
// TICKS = 12. Counted, not copied (SC-08). The submit chain:
//   onSubmit -> await submitFeedback -> await upsertFeedback (1) ->
//   await refreshAfterDiaryMutation -> await Promise.allSettled([feed.refresh()])
//   -> refresh -> await loadMore -> await listDiaryFeed (2) -> loadMore resumes
//   (3) -> refresh resumes (4) -> allSettled (5) -> refreshAfterDiaryMutation
//   resumes (6) -> submitFeedback's finally + return (7) -> onSubmit resumes,
//   sets submitted, fires the FIRE-AND-FORGET `void refreshBookings()` (.vue:127)
//   (8) -> that chain is itself two deep: pagination.refresh -> await loadMore ->
//   await getMyBookings (9) -> resumes (10) -> +1 final re-render = ~11.
// 12 is one over the deepest chain. This is TWO more than CheckinView's 10
// because that file's deepest assertion stops at the submit; here the detached
// refreshBookings tail is asserted at the network, and it is the longest thing
// on the screen. The MOUNT chain is much shallower (~3): onMounted ->
// fetchPractice -> await getPractice -> re-render. Over-counting is harmless
// (velo-idiom §3); an under-count would fail loudly on the toEqual bodies.
//
// ============================================================================
// THE GAP THIS FILE PINNED, AND THEN CLOSED -- read before touching the rung tests.
// ============================================================================
// №444 gave FormShell an optional `loadError` prop + a `retry` emit and wired
// CheckinView to them, deliberately leaving FeedbackView and ReflectionView
// unwired because they were uncovered -- wiring behaviour you cannot test is how
// the next silent bug ships. This file was that coverage; №445 then wired it.
//
// Before the wiring, a deep link whose practice fetch FAILED rendered a live,
// submittable form for a POST the backend would refuse (feedback requires
// booking.status == attended AND practice.status == completed --
// api/diary.ts:99-101). Of the three FormShell consumers, THIS screen's gap was
// the only one a user could actually reach: the POST really left. `submit-disabled`
// is still the literal `false` (.vue:20) and that is correct -- there is no window
// gate here, unlike CheckinView; the rung is what stands in for it now.
//
// FIXED in №445, the prompt after this file landed: covering the screen is what
// opened the gate, exactly as with DiaryFeedView. The three tests that pinned the
// gap were rehearsed first (temporarily wiring :load-error turned EXACTLY those
// three red and nothing else), then inverted when the wiring landed for real --
// not weakened (SC-10). They now assert the rung.
//
// ReflectionView.vue is the THIRD sibling and was unwired the same way; it was
// covered and wired in the same pass, so all three FormShell consumers now render
// the rung and the class is closed rather than left two-thirds done.
//
// But the three are NOT equally urgent, and the difference is this screen's whole
// point. ReflectionView's gap is LATENT -- its submit is a stub that reaches no
// endpoint (diary.ts:130-145), so a form over a failed load produces only a
// cosmetic thank-you. THIS screen's gap is LIVE: `upsertFeedback` is a real POST
// to a real endpoint that will refuse it. FeedbackView is therefore the only one
// of the three where the CheckinView bug is currently reachable by a user.
// ============================================================================
//
// TRAPS PRESENT:
//  - SC-17. `:disabled="disabled || loading"` (VButton.vue:27) means a re-entry
//    test that ticks between clicks proves the disabled ATTRIBUTE, not the ref.
//    The double click below has NO await between the two clicks; the disabled
//    rung is asserted SEPARATELY and credited to the DOM. Note the guard is NOT
//    double-gated the way CheckinView's is -- `submitDisabled` is the literal
//    `false`, so `feedbackSubmitting` is the ONLY defence in any frame, which is
//    precisely why the no-tick shape is mandatory rather than pedantic.
//  - TWO guards sit behind one POST: the view's (.vue:111) and the store's own
//    (diary.ts:97). `upsertFeedback` called once proves only that ONE held.
//    $onAction counts the VIEW's calls, isolating .vue:111.
//  - SC-15. Every `not.toHaveBeenCalled` / `not.toContain` first pins the
//    positive -- the form is up, the question is on screen, the button exists --
//    so no exclusion can pass on a mount that rendered nothing. This is load
//    bearing for the tripwire block, whose whole claim is about ABSENT things.
//  - SC-14b. The word «feedback» is unfailable here: it is the header back-label
//    ("Feedback", .vue:13), a substring of the submit label («Отправить
//    feedback»), and a substring of the success title («Спасибо за feedback!»).
//    `text()).toContain('feedback')` can never fail. The success title is read
//    off `.result-screen__title` and never off the host.
//  - window.history.state, read in an EVENT HANDLER (.vue:137) -- `onBack` only
//    touches it when tapped, so seeding after mount is correct (skill Step 4,
//    corrected in v1.3.0). Reset via replaceState in beforeEach AND afterEach:
//    happy-dom's history is per-file module state and leaks between tests.
//    Precedent: CreatePracticeView.test.ts:357,1284.
//
// TRAPS ABSENT (grepped the whole tree -- FeedbackView, FormShell, MoodSlider,
// ResultScreen, PracticeHeroCard, VHeader, VTextarea, VButton, VLoader,
// VEmptyState -- so the next agent does not cargo-cult setup onto a screen with
// none of it):
//  - NO WALL CLOCK, and this is the sharpest difference from CheckinView. That
//    screen reads `Date.now()` (.vue:119) behind a 60s interval; this one reads
//    the clock NOWHERE. Its meta cell is the static literal «Завершена»
//    (.vue:34), not a formatDate call, so there is no timezone to pin either.
//    NO fake timers, NO vi.setSystemTime, NO NOW constant -- copying CheckinView's
//    time setup here would be dead setup carrying a false justification.
//  - NO overlays. Nothing in this tree mounts VModal or VBottomSheet, so there is
//    no `.v-*__overlay` to reap and no SC-13/13b/13c afterEach purge. VHeader owns
//    the tree's only <Teleport> and it is `:disabled="!floating"` with
//    `floating = inject(KEY, false)`; a bare mount has no MobileLayout ancestor,
//    so it renders INLINE inside host and nothing reaches document.body.
//  - NO v-show. FormShell is `v-if="submitted"` / `v-else` and its error rung is
//    `v-if="loadError"` / `v-else`, so the panes are genuinely mutually exclusive
//    -- SC-14's impossible assertion cannot happen and whole-host queries are safe
//    (subject to SC-14b above, which is a different hazard).
//  - NO money, no formatMoney, no Intl.NumberFormat anywhere in the chain -> the
//    ru NBSP trap (velo-idiom §11) does not apply and there is no norm() helper.
//    This file has no Intl output of any kind to assert.
//  - NO IntersectionObserver / ResizeObserver, no scroll or layout reads, no
//    navigator.clipboard, no window.location assignment, no waitUntilReady.
//  - NO EMPTY RUNG. This screen fetches ONE record; fetchPractice
//    (stores/practices.ts:78-109) lands in exactly selected-or-error. There is no
//    empty state to build and manufacturing one would assert a state the store
//    cannot produce.
//  - @/platform is NOT mocked and needs no seam: platform/index.ts picks
//    standalonePlatform when window.Telegram.WebApp.initData is absent (it is),
//    and standalone's hapticFeedback() is a no-op. The .vue:120 call sits inside a
//    bare try/catch besides. Left real on purpose.
//
// NO ORDER DEPENDENCE. Declaration order is execution order; nothing relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import FeedbackView from '@/views/user/FeedbackView.vue'
import { usePracticesStore } from '@/stores/practices'
// The REAL store, read where the assertion is about the has_feedback gate reading
// the live list rather than a fixture the test handed it.
import { useBookingsStore } from '@/stores/bookings'
import { useDiaryStore } from '@/stores/diary'
import { ApiResponseError } from '@/api/client'
import { upsertFeedback, listDiaryFeed } from '@/api/diary'
import { getMyBookings } from '@/api/bookings'
import { getPractice } from '@/api/practices'
import type { BookingWithPracticeResponse, PracticeResponse } from '@/api/types'

// -- seams: the api wrappers the three real stores import (velo-idiom §4).
// importActual + spread keeps every other export real (notably ApiResponseError
// via @/api/client, which is never mocked) -- only the network boundary is faked.
//
// @/api/bookings is mocked even though this screen never fetches bookings at
// mount: `void bookingsStore.refreshBookings()` (.vue:127) fires on a successful
// submit, and an unmocked wrapper would reach the real client. It is also the
// seam the post-submit refresh is PROVEN at, rather than as a spy call.
vi.mock('@/api/diary', async () => {
  const actual = await vi.importActual<typeof import('@/api/diary')>('@/api/diary')
  return { ...actual, upsertFeedback: vi.fn(), listDiaryFeed: vi.fn() }
})
vi.mock('@/api/bookings', async () => {
  const actual = await vi.importActual<typeof import('@/api/bookings')>('@/api/bookings')
  return { ...actual, getMyBookings: vi.fn() }
})
vi.mock('@/api/practices', async () => {
  const actual = await vi.importActual<typeof import('@/api/practices')>('@/api/practices')
  return { ...actual, getPractice: vi.fn() }
})

// `back` is a real spy here, unlike CheckinView's throwaway: onBack (.vue:133-143)
// picks between router.back() and router.push() off window.history.state, and both
// arms are asserted.
const push = vi.fn()
const back = vi.fn()
const routeParams: { practiceId: string } = { practiceId: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

const upsertFeedbackMock = vi.mocked(upsertFeedback)
const listDiaryFeedMock = vi.mocked(listDiaryFeed)
const getMyBookingsMock = vi.mocked(getMyBookings)
const getPracticeMock = vi.mocked(getPractice)

/**
 * SC-18: every default here DIFFERS from every value any test overrides
 * (title/master_name/id/status), so a dropped `...overrides` fails loudly
 * instead of silently agreeing with the assertion.
 *
 * SC-18b: `status: 'completed'` and `practice_type: 'live'` are the real unions
 * from api/types, not plausible-looking strings -- vue-tsc is the only thing that
 * can catch a fixture describing a record the backend cannot send. A feedback is
 * post-practice, so `completed` is the state this screen actually meets.
 */
function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'm1',
    master_name: 'Мастер Аня',
    practice_type: 'live',
    status: 'completed',
    title: 'Утренняя практика',
    description: null,
    scheduled_at: '2026-07-20T13:00:00.000Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 10,
    current_participants: 3,
    parent_practice_id: null,
    is_free: false,
    price_cents: 2500,
    currency: 'EUR',
    direction: null,
    difficulty: null,
    ...overrides,
  } as PracticeResponse
}

/**
 * SC-18: `has_feedback` defaults FALSE and every gate test overrides it to true,
 * so a dropped `...overrides` fails loudly instead of quietly asserting the
 * default. `status: 'completed'` mirrors what this screen actually meets -- a
 * feedback is post-practice.
 */
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
      status: 'completed',
      scheduled_at: '2026-07-20T13:00:00.000Z',
      duration_minutes: 60,
      timezone: 'UTC',
      master_id: 'm1',
      master_name: 'Мастер Аня',
      direction: null,
      is_free: false,
      price_cents: 2500,
      currency: 'EUR',
    },
  } as BookingWithPracticeResponse
}

function bookingsPage(items: BookingWithPracticeResponse[] = []) {
  return { items, total: items.length, limit: 20, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(FeedbackView)
  app.use(pinia)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await nextTick()
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
  return button('Отправить feedback')
}

/** Scoped read (SC-14b): «feedback» appears in three other places on this screen. */
function successTitle(): string {
  return host?.querySelector('.result-screen__title')?.textContent?.trim() ?? ''
}

/** FormShell's error rung (VEmptyState). Absent today -- that is the tripwire. */
function errorRung(): HTMLElement | null {
  return host?.querySelector('.v-empty') ?? null
}

function typeComment(value: string): void {
  const ta = host?.querySelector('textarea') as HTMLTextAreaElement
  ta.value = value
  ta.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  routeParams.practiceId = 'p1'

  getPracticeMock.mockReset().mockResolvedValue(practice())
  getMyBookingsMock.mockReset().mockResolvedValue(bookingsPage())
  upsertFeedbackMock.mockReset().mockResolvedValue({ id: 'f1' } as never)
  listDiaryFeedMock.mockReset().mockResolvedValue({ items: [], next_cursor: null } as never)
  push.mockReset()
  back.mockReset()
  toastError.mockReset()

  // onBack reads history.state at CLICK time; happy-dom's history is per-file
  // module state, so a `back` seeded by one test would leak into the next.
  window.history.replaceState({}, '')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.history.replaceState({}, '')
  vi.clearAllMocks()
  // No overlay purge and no vi.useRealTimers(): nothing in this tree teleports to
  // document.body and nothing reads the clock. Both omissions are deliberate --
  // see "TRAPS ABSENT" in the banner.
})

describe('FeedbackView', () => {
  // ===========================================================================
  // The ladder. This screen fetches ONE record, so it has loading + content +
  // (a MISSING error rung -- see the tripwire block) and no empty state.
  // ===========================================================================
  describe('state ladder', () => {
    it('loading: shows the practice loader while the practice is in flight', async () => {
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.form-shell__loader')).not.toBeNull()
      expect(host?.querySelector('.hero-card')).toBeNull()
    })

    it('the form is NOT gated by the practice fetch -- it renders and submits while loading', async () => {
      // Skill Step 5 rung 7. The feedback is about the USER's experience and the
      // practiceId comes from the route (.vue:101), not the fetch, so blanking or
      // disabling the form behind a slow catalog request would be its own bug.
      // Contrast CheckinView, which now DOES hold submit while loading because its
      // window gate fails closed -- this screen has no window gate at all
      // (`:submit-disabled="false"`, .vue:20).
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(text()).toContain('Как прошла практика?')
      expect(text()).toContain('Оцените своё состояние после')
      expect(submitBtn()).toBeDefined()
      expect(submitBtn()?.disabled).toBe(false)
    })

    it('content: renders the practice the store actually holds, title cleaned', async () => {
      getPracticeMock.mockResolvedValue(
        practice({ title: 'Вечерняя йога (эфир)', master_name: 'Мастер Лена' }),
      )
      mount()
      await flush()

      // cleanPracticeTitle strips the "(эфир)" suffix (FormShell.vue:194).
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Вечерняя йога')
      expect(text()).toContain('Мастер Лена')
    })

    it('content: the meta cell is the static «Завершена», not a formatted date', async () => {
      // .vue:34. The DIFFERENCE from CheckinView, which renders formatDate output
      // in this slot and therefore needs a pinned clock and timezone. A feedback
      // is always post-practice, so the status is a constant -- which is why this
      // file freezes no time at all.
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()

      expect(text()).toContain('Завершена')
      // The fixture's scheduled_at would render as «20 июля» if a date were shown.
      expect(text()).not.toContain('20 июля')
    })

    it('falls back to «Мастером» when the practice carries no master name', async () => {
      getPracticeMock.mockResolvedValue(practice({ master_name: null }))
      mount()
      await flush()

      expect(text()).toContain('Мастером')
    })

    it('fetches the practice on a cold deep-link', async () => {
      mount()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
    })

    it('does NOT re-fetch a practice the store already holds', async () => {
      // .vue:154 -- arriving from the dashboard banner or the detail card,
      // `selected` is already this practice. Re-fetching would be a wasted
      // request on every feedback tap.
      const store = usePracticesStore()
      store.selected = practice({ title: 'Уже загружена' })
      mount()
      await flush()

      expect(getPracticeMock).not.toHaveBeenCalled()
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Уже загружена')
    })

    it('re-fetches when the store holds a DIFFERENT practice', async () => {
      // The non-vacuous other side of the guard above: `selected?.id !== practiceId`
      // (.vue:154). If it matched on presence rather than identity, arriving here
      // from any other practice's detail card would render the WRONG practice's
      // card over this practice's form.
      const store = usePracticesStore()
      store.selected = practice({ id: 'p_other', title: 'Чужая практика' })
      getPracticeMock.mockResolvedValue(practice({ id: 'p1', title: 'Эта практика' }))
      mount()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Эта практика')
    })
  })

  // ===========================================================================
  // THE FORMSHELL GAP -- was the tripwire (№445), now the fix. These asserted the
  // BUG SHAPE that №444 fixed on CheckinView and deliberately left here until this
  // screen was covered. The wiring landed them red on cue; they are inverted, not
  // deleted (SC-10).
  //
  // This screen's gap was the only one of the three REACHABLE by a user: the POST
  // really left and the backend really refused it. ReflectionView's twin is latent
  // (its submit is a stub with no endpoint).
  // ===========================================================================
  describe('a FAILED practice load renders the error rung, not a form (№445)', () => {
    it('surfaces the generic fallback the store holds (no code set)', async () => {
      // The two halves that made this a gap rather than a design: the data was
      // always there (practicesStore.selectedError, stores/practices.ts:52) and
      // the shell could always render it (FormShell.vue:68) -- only the binding was
      // missing. Asserting the store side still proves the rung is wired to
      // it rather than a separate constant of its own (SC-05).
      // B8 (PROMPT №747): no third arg means code defaults to 'unknown' --
      // unmapped, lands on practices.ts's own fallback (:52).
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()

      expect(usePracticesStore().selectedError).toBe('Не удалось загрузить практику')
      expect(errorRung()).not.toBeNull()
      expect(text()).toContain('Не удалось загрузить практику')
      expect(button('Повторить')).toBeDefined()
    })

    it('replaces the form entirely -- no context-free rating form is offered', async () => {
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()

      expect(text()).not.toContain('Как прошла практика?')
      expect(submitBtn()).toBeUndefined()
      expect(host?.querySelector('.hero-card')).toBeNull()
      expect(host?.querySelector('.form-shell__loader')).toBeNull()
    })

    it('the POST can no longer LEAVE for a practice that failed to load', async () => {
      // The sharp end, and why this was worth fixing rather than tolerating. The
      // feedback endpoint requires booking.status == attended AND practice.status
      // == completed (api/diary.ts:99-101) -- facts this screen does not have when
      // the fetch failed. It used to fire into that refusal and hand the user the
      // backend's error toast for a failure it could have named up front.
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()

      expect(submitBtn()).toBeUndefined()
      expect(upsertFeedbackMock).not.toHaveBeenCalled()
    })

    it('«Повторить» re-fetches -- the rung is not a dead end', async () => {
      // A dead-end error state was its own bug class here (11 of them, 22dc824).
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()
      getPracticeMock.mockClear()

      button('Повторить')!.click()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
    })

    it('a HEALTHY load still renders the form -- the rung is not a blanket takeover', async () => {
      // Non-vacuous half: if loadError were bound to something always truthy, every
      // test above would pass and the screen would be permanently broken.
      mount()
      await flush()

      expect(errorRung()).toBeNull()
      expect(text()).toContain('Как прошла практика?')
      expect(submitBtn()).toBeDefined()
    })
  })

  // ===========================================================================
  // The write itself. VALUES, not mock calls (SC-02): every assertion below is
  // on the exact body the backend would receive.
  // ===========================================================================
  // ===========================================================================
  // ONE FEEDBACK PER PRACTICE (№446). A UI gate over a PERMISSIVE api: the
  // endpoint is an upsert and would accept a second call, overwriting the rating
  // already recorded. The backend will NOT catch a bug here, so these tests are
  // the only thing holding the gate.
  //
  // Why it is a gate and not an edit feature: the overwrite happened SILENTLY,
  // by navigating back into this screen, and the person never learned they had
  // erased their own earlier review. Feedback feeds the master's analytics too --
  // a "three stars" a master already read could quietly become five, with no trace.
  //
  // The mechanism mirrors CheckinView exactly (its :148 / :157 / :216 / :234).
  // Sibling screens diverging is the habit that has bitten this repo four times.
  // ===========================================================================
  describe('one feedback per practice', () => {
    it('an existing feedback replaces the FORM with the success screen at mount', async () => {
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_feedback: true })]))
      mount()
      await flush()

      expect(successTitle()).toBe('Спасибо за feedback!')
      expect(text()).not.toContain('Как прошла практика?')
      expect(submitBtn()).toBeUndefined()
    })

    it('a booking with NO feedback still renders the form (the gate is not always-on)', async () => {
      // The non-vacuous half: gate on a constant and every test above passes while
      // the screen is permanently unusable.
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_feedback: false })]))
      mount()
      await flush()

      expect(text()).toContain('Как прошла практика?')
      expect(submitBtn()).toBeDefined()
      expect(successTitle()).toBe('')
    })

    it('reads has_feedback for THIS practice, not just any booking', async () => {
      // The id match in the computed. Without it, one reviewed practice anywhere in
      // the list would lock every feedback form the user opens.
      getMyBookingsMock.mockResolvedValue(
        bookingsPage([booking({ id: 'b9', practice_id: 'p-other', has_feedback: true })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Как прошла практика?')
      expect(submitBtn()).toBeDefined()
    })

    it('the onSubmit gate holds even when the button is still on screen (SC-17 race)', async () => {
      // THIS TEST EXISTS BECAUSE A MUTATION CAUGHT ITS FIRST VERSION. The gate is
      // DOUBLE-gated -- once at the DOM (the watch swaps in the success screen, so
      // the button vanishes) and once inside onSubmit. The first version flipped
      // the flag, awaited, and asserted `not.toHaveBeenCalled()` WITHOUT CLICKING:
      // it passed with the onSubmit gate deleted, because nothing had happened at
      // all. SC-15's shape exactly.
      //
      // So reach the second rung the only way it can be reached: flip the flag
      // with NO await, so Vue has not repainted and the button is still live, then
      // tap. The pre-assertions pin that the button really is there and enabled in
      // that frame, so this cannot pass vacuously either.
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_feedback: false })]))
      mount()
      await flush()

      const btn = submitBtn()
      expect(btn).toBeDefined()
      expect(btn?.disabled).toBe(false)

      // No await: the ref is true, the DOM is stale, the button is still clickable.
      useBookingsStore().bookings[0]!.has_feedback = true
      btn!.click()
      await flush()

      expect(upsertFeedbackMock).not.toHaveBeenCalled()
      expect(successTitle()).toBe('Спасибо за feedback!')
    })

    it('the flag flipping while the form is OPEN swaps to the success screen', async () => {
      // The watch (mirrors CheckinView:216). Another screen refreshing the list
      // must not leave a live form standing over a review that already exists.
      getMyBookingsMock.mockResolvedValue(bookingsPage([booking({ has_feedback: false })]))
      mount()
      await flush()
      expect(text()).toContain('Как прошла практика?')

      useBookingsStore().bookings[0]!.has_feedback = true
      await flush()

      expect(successTitle()).toBe('Спасибо за feedback!')
      expect(submitBtn()).toBeUndefined()
    })
  })

  describe('submitting the feedback', () => {
    it('sends the DEFAULT rating and a null comment, and shows the success screen', async () => {
      // ratingScore defaults to 6 -- the middle «Хорошо» zone (.vue:106) -- so a
      // user who taps Отправить without touching the slider sends a neutral score,
      // not a 1 or an empty body the backend would reject.
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledTimes(1)
      expect(upsertFeedbackMock).toHaveBeenCalledWith('p1', { rating: 6, comment: null })
      expect(successTitle()).toBe('Спасибо за feedback!')
      expect(text()).toContain('Ваш отзыв поможет нам улучшить практики')
    })

    it('sends the rating the SLIDER chose and the comment the user typed, trimmed', async () => {
      // The Pattern-C form half, driven through real DOM rather than by poking
      // refs. Tapping the third card -> ZONE_CENTRE[2] = 9 (MoodSlider.vue:100-103).
      mount()
      await flush()

      const cards = host?.querySelectorAll('.mood-slider__card')
      expect(cards?.length).toBe(3)
      ;(cards?.[2] as HTMLElement).click()
      typeComment('   Было отлично   ')
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledWith('p1', { rating: 9, comment: 'Было отлично' })
    })

    it('sends the LOW rating from the first slider zone', async () => {
      // ZONE_CENTRE[0] = 2. The other end of the scale: a 1..10 field where only
      // the middle was ever exercised would hide an off-by-one in the zone map.
      mount()
      await flush()

      const cards = host?.querySelectorAll('.mood-slider__card')
      ;(cards?.[0] as HTMLElement).click()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledWith('p1', { rating: 2, comment: null })
    })

    it('sends the raw 1..10 value the range input emits, not a zone index', async () => {
      // The slider is a real <input type="range"> under the icons
      // (MoodSlider.vue:43-52) and the POST carries its raw value (.vue:114).
      // A zone index leaking into the body would send 0/1/2 for a 1..10 field.
      mount()
      await flush()

      const range = host?.querySelector('.mood-slider__input') as HTMLInputElement
      expect(range).not.toBeNull()
      range.value = '10'
      range.dispatchEvent(new Event('input'))
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledWith('p1', { rating: 10, comment: null })
    })

    it('a whitespace-only comment is sent as null, not as blanks', async () => {
      // `comment.value.trim() || null` (.vue:115).
      mount()
      await flush()

      typeComment('    ')
      await flush()
      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledWith('p1', { rating: 6, comment: null })
    })

    it('sends the feedback for the practice in the ROUTE, not the one in the store', async () => {
      // practiceId is read off route.params (.vue:101) and is what the POST is
      // keyed on. A store-sourced id would write the feedback against whichever
      // practice happened to be `selected`.
      routeParams.practiceId = 'p42'
      getPracticeMock.mockResolvedValue(practice({ id: 'p42' }))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledWith('p42', { rating: 6, comment: null })
    })

    it('refreshes the bookings after a successful submit -- at the NETWORK, not just a spy', async () => {
      // W27 (diary.ts:218-233): the store deliberately STOPPED refreshing bookings
      // on the grounds that this view does it itself (.vue:127). If that ever
      // regresses, has_feedback stays stale and the dashboard keeps offering a
      // feedback the user already left.
      //
      // The count is 1 -> 2, not 0 -> 1: since №446 this screen loads bookings at
      // MOUNT too, because that list is what the has_feedback gate reads. The
      // mount call is asserted first so the post-submit call is the delta and not
      // an off-by-one hiding a missing refresh.
      mount()
      await flush()
      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)

      submitBtn()?.click()
      await flush()

      expect(getMyBookingsMock).toHaveBeenCalledTimes(2)
    })

    it('refreshes the diary feed too -- the feedback is a timeline event', async () => {
      // submitFeedback -> refreshAfterDiaryMutation -> feed.refresh (diary.ts:103).
      // Verified one level down rather than from the .vue comment.
      mount()
      await flush()
      expect(listDiaryFeedMock).not.toHaveBeenCalled()

      submitBtn()?.click()
      await flush()

      expect(listDiaryFeedMock).toHaveBeenCalledTimes(1)
    })

    it('a FAILED feed refresh does not fail the feedback -- the POST already landed', async () => {
      // Promise.allSettled (diary.ts:235). The write succeeded server-side;
      // telling the user it failed would push them into a duplicate submit -- and
      // this endpoint is an upsert, so the duplicate would silently overwrite.
      listDiaryFeedMock.mockRejectedValue(new ApiResponseError(500, 'Лента недоступна'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(successTitle()).toBe('Спасибо за feedback!')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a FAILED bookings refresh does not fail the feedback either', async () => {
      // `void bookingsStore.refreshBookings()` (.vue:127) is fire-and-forget and
      // runs AFTER submitted flips. A rejection here must not unwind the success
      // screen for a write that already landed.
      getMyBookingsMock.mockRejectedValue(new ApiResponseError(500, 'Бронирования недоступны'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(successTitle()).toBe('Спасибо за feedback!')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a FAILED submit falls back to the generic message (no code set) and never claims success', async () => {
      // B8 (PROMPT №747): extractApiError no longer reads e.detail. No third
      // arg means code defaults to 'unknown' -- unmapped, lands on
      // diaryStore.submitFeedback's own fallback (stores/diary.ts:113).
      upsertFeedbackMock.mockRejectedValue(new ApiResponseError(400, 'Feedback window has closed'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отправить feedback')
      expect(successTitle()).toBe('')
      expect(text()).toContain('Как прошла практика?')
    })

    it('a FAILED submit does NOT refresh the bookings -- nothing changed', async () => {
      // The mount load (1) must still be the ONLY call: a failed write refreshes
      // nothing. Asserting `not.toHaveBeenCalled()` would be wrong now and would
      // fail for the wrong reason -- the point is no SECOND call.
      upsertFeedbackMock.mockRejectedValue(new ApiResponseError(400, 'Feedback window has closed'))
      mount()
      await flush()
      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)

      submitBtn()?.click()
      await flush()

      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)
    })

    it("a non-API failure falls back to the store's own message", async () => {
      upsertFeedbackMock.mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отправить feedback')
      expect(successTitle()).toBe('')
    })

    it('the form is submittable again after a failure -- the ref is released', async () => {
      // `finally { feedbackSubmitting.value = false }` (diary.ts:109). A guard left
      // latched would strand the user on a form that ignores every tap.
      upsertFeedbackMock.mockRejectedValueOnce(new ApiResponseError(500, 'Сервер недоступен'))
      mount()
      await flush()

      submitBtn()?.click()
      await flush()
      expect(successTitle()).toBe('')

      upsertFeedbackMock.mockResolvedValue({ id: 'f1' } as never)
      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenCalledTimes(2)
      expect(successTitle()).toBe('Спасибо за feedback!')
    })

    it('the comment the user typed survives a failed submit', async () => {
      // The form stays mounted on failure (FormShell's v-if never flips), so the
      // local `comment` ref must still hold the text -- retyping a 1000-char
      // reflection because the network blipped is how a user stops leaving them.
      upsertFeedbackMock.mockRejectedValueOnce(new ApiResponseError(500, 'Сервер недоступен'))
      mount()
      await flush()

      typeComment('Длинный отзыв')
      await flush()
      submitBtn()?.click()
      await flush()

      const ta = host?.querySelector('textarea') as HTMLTextAreaElement
      expect(ta.value).toBe('Длинный отзыв')

      upsertFeedbackMock.mockResolvedValue({ id: 'f1' } as never)
      submitBtn()?.click()
      await flush()

      expect(upsertFeedbackMock).toHaveBeenLastCalledWith('p1', {
        rating: 6,
        comment: 'Длинный отзыв',
      })
    })
  })

  // ===========================================================================
  // Re-entry. The ONLY gate this screen has (.vue:111) -- and the endpoint is an
  // upsert (api/diary.ts:96-102), so the backend will NOT catch a double submit.
  // It will cheerfully overwrite. These tests are the only thing holding it.
  // ===========================================================================
  describe('re-entry', () => {
    it('two taps with NO repaint between them still send exactly ONE feedback', async () => {
      // SC-17: no `await` between the clicks. With one, VButton's
      // `:disabled="disabled || loading"` (VButton.vue:27) would have swallowed the
      // second tap and this test would credit `feedbackSubmitting` for work the DOM
      // did. `submitFeedback` flips the ref SYNCHRONOUSLY before its first await
      // (diary.ts:98), so the ref really is the only defence in this frame.
      let resolve!: (v: unknown) => void
      upsertFeedbackMock.mockReturnValue(
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

      expect(upsertFeedbackMock).toHaveBeenCalledTimes(1)

      resolve({ id: 'f1' })
      await flush()
    })

    it("the VIEW's own guard is what blocks the second tap -- not the store's", async () => {
      // `upsertFeedback` called once proves only that ONE of the two guards held:
      // the view's (.vue:111) or the store's (diary.ts:97). $onAction counts the
      // calls the VIEW makes, so this isolates .vue:111. Delete that line and this
      // test goes red while the one above stays green.
      const diary = useDiaryStore()
      let viewCalls = 0
      diary.$onAction(({ name }) => {
        if (name === 'submitFeedback') viewCalls++
      })

      let resolve!: (v: unknown) => void
      upsertFeedbackMock.mockReturnValue(
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

      resolve({ id: 'f1' })
      await flush()
    })

    it('the button also disables itself while the feedback is in flight', async () => {
      // The OTHER mechanism, asserted separately and attributed correctly (SC-17):
      // FormShell binds `:loading="submitting"` (FormShell.vue:127) to
      // diaryStore.feedbackSubmitting, and VButton folds loading into disabled.
      // This is the DOM rung; the two tests above are the ref rung.
      let resolve!: (v: unknown) => void
      upsertFeedbackMock.mockReturnValue(
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

      resolve({ id: 'f1' })
      await flush()
    })
  })

  // ===========================================================================
  // Navigation. onBack (.vue:133-143) branches on window.history.state -- read at
  // CLICK time, so seeding after mount is correct here.
  // ===========================================================================
  describe('navigation', () => {
    it('back POPS to the real origin when there is history', async () => {
      // .vue:137-139. Feedback opens from the dashboard banner AND the practice
      // detail card; pushing a fixed route would send half the users somewhere
      // they did not come from.
      mount()
      await flush()
      window.history.replaceState({ back: '/user/practice/p1' }, '')

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })

    it('back on a COLD deep-link pushes the dashboard instead of dead-ending', async () => {
      // .vue:140-142. A Telegram deep link or a reload has no history entry, so
      // router.back() would strand the user on a dead screen.
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
      expect(back).not.toHaveBeenCalled()
    })

    it('a history entry whose `back` is null still pushes the dashboard', async () => {
      // `window.history.state?.back != null` (.vue:137). vue-router writes a state
      // object with an explicit `back: null` on the FIRST entry of a session, so
      // testing only the missing-state case would leave the real cold-start shape
      // -- state present, back null -- unproven.
      mount()
      await flush()
      window.history.replaceState({ back: null, current: '/user/feedback/p1' }, '')

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
      expect(back).not.toHaveBeenCalled()
    })

    it('«В дневник» on the success screen goes to the diary feed', async () => {
      mount()
      await flush()
      submitBtn()?.click()
      await flush()
      expect(successTitle()).toBe('Спасибо за feedback!')

      button('В дневник')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-diary' })
    })

    it('«На главную» on the success screen goes to the dashboard', async () => {
      mount()
      await flush()
      submitBtn()?.click()
      await flush()

      button('На главную')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('the success screen offers BOTH exits and no form', async () => {
      // SC-15's positive pin for the two tests above, and the success rung's own
      // content: FormShell's v-if swaps the form out entirely (FormShell.vue:48,57),
      // so a user cannot re-submit by tapping through.
      mount()
      await flush()
      submitBtn()?.click()
      await flush()

      expect(button('В дневник')).toBeDefined()
      expect(button('На главную')).toBeDefined()
      expect(submitBtn()).toBeUndefined()
      expect(host?.querySelector('textarea')).toBeNull()
      expect(text()).not.toContain('Как прошла практика?')
    })
  })

  // ===========================================================================
  // NOT COVERED, deliberately -- the limits of this file's seams, stated rather
  // than faked.
  //
  // 1. platform.hapticFeedback('medium') on a successful submit (.vue:120). It is
  //    wrapped in a bare try/catch with a silent fallback and returns nothing, so
  //    on the standalone platform this mount resolves to it is a no-op with no
  //    observable effect. Proving it fired would mean mocking @/platform purely to
  //    assert the mock (SC-02) -- there is no product behaviour behind the call to
  //    assert instead.
  //
  // 2. RATING_ZONES' per-zone icon COLOURS (.vue:88-92, RATING_ICON_COLOR ->
  //    --velo-rating-* tokens). MoodSlider binds them as an inline `color` style
  //    (MoodSlider.vue:32); asserting the literal `var(--velo-rating-fire)` string
  //    would pin the token NAME, not the rendered colour -- happy-dom has no
  //    cascade and getComputedStyle returns empty strings, so the value behind the
  //    var is unreachable. That belongs to the design-token audit
  //    (probekit-design-audit), not to a screen test.
  //
  // 3. The slider's live GROW/DIM behaviour (the active card scaling 0.92 -> 1.08).
  //    It is pure CSS on a class MoodSlider toggles; happy-dom has no layout, so
  //    the only assertable half is the class itself, which the rating-value tests
  //    already exercise through the same selectZone path.
  //
  // 4. NO «one feedback per practice» gate exists to test -- and unlike the gap in
  //    the tripwire block, its absence looks DELIBERATE. CheckinView blocks a
  //    second check-in via `alreadyCheckedIn` (CheckinView.vue:148), reading
  //    has_checkin off the bookings list; FeedbackView reads has_feedback nowhere
  //    and never loads bookings at mount, so a user who navigates back to this
  //    route overwrites their previous feedback. The endpoint permits it ("repeated
  //    calls overwrite", api/diary.ts:101) and CheckinView's own comment draws the
  //    line explicitly -- "a check-in is a moment, not a document" (.vue:137-138) --
  //    which reads as feedback being editable ON PURPOSE. Recorded here rather than
  //    pinned as a tripwire because pinning it would assert a product decision this
  //    file has no standing to make. Worth an operator ruling.
  // ===========================================================================
})
