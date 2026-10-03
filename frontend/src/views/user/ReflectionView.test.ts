// =============================================================================
// VELO Frontend -- ReflectionView Screen Tests
// =============================================================================
//
// WHY: this is the third and last FormShell consumer. Its sibling CheckinView
// had a real gap -- a deep link whose practice fetch FAILED rendered a live form
// for a POST the backend would refuse. FormShell grew `loadError` + a `retry`
// emit in №444 and this screen was wired to them in №445; the error-rung tests
// below hold that wiring.
//
// SUBMIT (BE-108): submitReflection POSTs `/practices/{id}/reflection` through
// `createReflection`, and on success the view refreshes the bookings list so the
// server's `has_reflection` hides PracticeDetailView's button. Until BE-108 the
// screen was a stub that sent nothing and remembered the submit in
// localStorage; that stub, its tripwires and its persisted dismissal are gone,
// and the tests that pinned them now assert the call, its body and the refresh.
//
// PATTERN A (store-backed), all three stores REAL. Seams: @/api/practices
// (getPractice), @/api/bookings (getMyBookings -- the refresh after a submit is
// a real network boundary now), and @/api/diary auto-mocked wholesale, so "only
// createReflection was called" is asserted against the whole module rather than
// a hand-picked export. One pinia instance goes to both setActivePinia and
// app.use (SC-03).
//
// Real stores, not mocks, for the same reason CheckinView.test.ts gives: the
// re-entry path gates on `diaryStore.reflectionSubmitting`, a ref only the REAL
// store flips. A mocked diary store freezes it at `false` and the double-click
// test would pass for the wrong reason.
//
// TICKS = 6. Counted, not copied (SC-08):
//   mount:  onMounted -> fetchPractice (DETACHED, not awaited) ->
//           await getPractice (1) -> assign selected + finally (2) -> re-render (3)
//   submit: onSubmit -> submitReflection -> await createReflection (1) ->
//           finally + return (2) -> the view's `await` resumes (3) ->
//           submitted=true -> re-render (4)
// 6 covers the deeper chain with room. An over-count is harmless (velo-idiom
// §3); an under-count would fail loudly on the toEqual/text assertions.
//
// TRAPS PRESENT:
//  - window.history.state, read at CLICK time inside onBack (.vue:120), NOT at
//    setup -- so it is seeded per-test with replaceState before the tap, not
//    before the mount (SKILL.md's two history.state rows; this screen is
//    explicitly listed on the handler row). Reset in beforeEach so a seeded test
//    cannot leak the `back` key into the fallback test.
//  - SC-14b: 'Практика' is the header's back-label AND a prefix of the error copy
//    'Не удалось загрузить практику'; 'Как ваше самочувствие?' is variant p2's
//    SUBTITLE and also variant p1's... no -- but the three variants share
//    vocabulary, so every copy assertion is read off the scoped .form-shell__question
//    h3/p, never off the host.
//  - SC-15: the "no error rung" and "no other diary call" assertions are all
//    satisfied by a mount that rendered nothing. Every one of them pins the
//    positive FIRST -- the question is up, the button exists, the button is
//    enabled -- so the exclusion is real.
//  - SC-18: the fixture defaults ('Утренняя практика' / 'Мастер Аня') differ from
//    every value any test overrides, so a dropped `...overrides` fails loudly
//    instead of silently agreeing.
//  - SC-17: see "re-entry" below -- the double tap is caught by the ref the
//    real store holds across the await.
//
// TRAPS ABSENT (grepped the whole tree -- ReflectionView, FormShell, ResultScreen,
// PracticeHeroCard, VHeader, VBackButton, VTextarea, VButton, VEmptyState,
// VLoader, useKeyboardFieldScroll -- so the next agent does not cargo-cult setup
// onto a screen that has none):
//  - NO overlays. Nothing here mounts VModal or VBottomSheet: no `.v-*__overlay`
//    exists in the tree, so there is no SC-13/13b/13c afterEach purge. VHeader owns
//    the tree's only <Teleport> (VHeader.vue:23) and it is `:disabled="!floating"`
//    with `floating = useFloatingHeader()` -- no MobileLayout ancestor in a bare
//    mount, so it renders INLINE inside host. Nothing lands on document.body, so
//    every query below is host-scoped on purpose.
//  - NO v-show anywhere in the tree. FormShell is `v-if="submitted"` / `v-else`
//    and its error/form split is `v-if="loadError"` / `v-else`, so no two branches
//    are ever mounted together -- SC-14's impossible assertion cannot happen and
//    whole-host queries are safe where used.
//  - NO wall clock. Unlike CheckinView there is no `nowMs`, no interval, no
//    windowClosed, and no date is rendered at all: the meta line is the static
//    «Не состоялась» (.vue:45), because a no-show has no time worth showing. So
//    NO vi.setSystemTime, NO fake timers, and no fixture is dated relative to an
//    instant (SC-04 cannot bite what reads no clock).
//  - NO money. No formatMoney, no Intl.NumberFormat -> no ru NBSP trap
//    (velo-idiom §11) and no norm() helper.
//  - NO IntersectionObserver, no scroll/layout reads, no navigator.clipboard, no
//    window.location assignment, no waitUntilReady, no timezone.
//  - useKeyboardFieldScroll reads window.visualViewport, but ONLY inside the
//    textarea's @focus handler (FormShell.vue:116). No test focuses it, and it is
//    guarded for the no-visualViewport case anyway. Left real, no seam.
//  - @/platform is NOT mocked and needs no seam: platform/index.ts picks
//    standalonePlatform when window.Telegram.WebApp.initData is absent (it is),
//    and standalone's hapticFeedback() is a no-op inside a try/catch besides
//    (.vue:104). Left real on purpose.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import ReflectionView from '@/views/user/ReflectionView.vue'
import { useDiaryStore } from '@/stores/diary'
import { usePracticesStore } from '@/stores/practices'
import { ApiResponseError } from '@/api/client'
import { getPractice } from '@/api/practices'
import { getMyBookings } from '@/api/bookings'
import * as diaryApi from '@/api/diary'
import type { PracticeResponse, ReflectionResponse } from '@/api/types'

// -- the only live seam: the practices store's wrapper (velo-idiom §4).
vi.mock('@/api/practices', async () => {
  const actual = await vi.importActual<typeof import('@/api/practices')>('@/api/practices')
  return { ...actual, getPractice: vi.fn() }
})

// -- the refresh after a submit (bookings store -> getMyBookings).
vi.mock('@/api/bookings', async () => {
  const actual = await vi.importActual<typeof import('@/api/bookings')>('@/api/bookings')
  return { ...actual, getMyBookings: vi.fn() }
})

// -- @/api/diary is auto-mocked wholesale (velo-idiom §4, the bare form) so
// "only createReflection was called" sweeps EVERY export instead of a list I
// chose. No real export needs preserving: ApiResponseError lives in @/api/client.
vi.mock('@/api/diary')

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

const getPracticeMock = vi.mocked(getPractice)
const getMyBookingsMock = vi.mocked(getMyBookings)
const createReflectionMock = vi.mocked(diaryApi.createReflection)

function reflectionResponse(): ReflectionResponse {
  return {
    id: 'r1',
    practice_id: 'p1',
    booking_id: 'b1',
    comment: null,
    created_at: '2026-07-20T15:00:00Z',
  }
}

/**
 * SC-18: every default here DIFFERS from every value any test overrides, so a
 * dropped `...overrides` fails loudly rather than agreeing with the test.
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

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ReflectionView)
  app.use(pinia)
  app.mount(host)
}

/** 6 ticks -- counted in the banner, not copied from CheckinView's 10. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  )
}

/** The primary submit. Only rendered on the FORM half of FormShell's v-if. */
function submitBtn(): HTMLButtonElement | undefined {
  return button('Отправить')
}

/** Scoped read (SC-14b): the variant copy, never any matching string on the host. */
function questionTitle(): string {
  return host?.querySelector('.form-shell__question h3')?.textContent?.trim() ?? ''
}

function questionSubtitle(): string {
  return host?.querySelector('.form-shell__question p')?.textContent?.trim() ?? ''
}

/** Scoped read (SC-14b): the success title, not any matching copy elsewhere. */
function successTitle(): string {
  return host?.querySelector('.result-screen__title')?.textContent?.trim() ?? ''
}

/** The error rung FormShell would render IF this screen passed `loadError`. */
function errorRung(): HTMLElement | null {
  return host?.querySelector('.v-empty') ?? null
}

function typeComment(value: string): void {
  const ta = host?.querySelector('textarea') as HTMLTextAreaElement
  ta.value = value
  ta.dispatchEvent(new Event('input'))
}

/** Every export of @/api/diary that was called. Swept, not listed. */
function calledDiaryApi(): string[] {
  return Object.entries(diaryApi)
    .filter(([, fn]) => vi.isMockFunction(fn))
    .filter(([, fn]) => (fn as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    .map(([name]) => name)
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  routeParams.practiceId = 'p1'

  // onBack reads this at CLICK time (.vue:120). Reset so a seeded test cannot
  // leak `back` into the no-history fallback test.
  window.history.replaceState({}, '')

  getPracticeMock.mockReset().mockResolvedValue(practice())
  getMyBookingsMock.mockReset().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
  createReflectionMock.mockReset().mockResolvedValue(reflectionResponse())
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.history.replaceState({}, '')
  vi.clearAllMocks()
  // No overlay purge: nothing in this tree teleports to document.body. See the
  // "TRAPS ABSENT" note in the banner -- this omission is deliberate, not missed.
})

describe('ReflectionView', () => {
  describe('state ladder', () => {
    it('loading: shows the practice loader while the practice is in flight', async () => {
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.form-shell__loader')).not.toBeNull()
      expect(host?.querySelector('.hero-card')).toBeNull()
    })

    it('the form renders AND submit stays live while the practice is in flight', async () => {
      // Deliberately NOT CheckinView's post-№444 shape. That screen now holds
      // submit closed while the start time is unknown, because its POST is
      // window-gated. This one has no window and no POST: the reflection is about
      // the USER, the practiceId comes from the route, and `:submit-disabled` is
      // the literal `false` (.vue:31). So a slow catalog request must not blank or
      // gate the form -- and today it does not. Pinned as the current contract; if
      // a future ruling gates this screen too, this test is where it lands.
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(questionTitle()).toBe('Иногда тело просит паузы')
      expect(submitBtn()).toBeDefined()
      expect(submitBtn()?.disabled).toBe(false)
    })

    it('content: renders the practice the store actually holds', async () => {
      getPracticeMock.mockResolvedValue(
        practice({ title: 'Вечерняя йога (эфир)', master_name: 'Мастер Лена' }),
      )
      mount()
      await flush()

      // cleanPracticeTitle strips the "(эфир)" suffix (FormShell.vue:194).
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Вечерняя йога')
      expect(text()).toContain('Мастер Лена')
    })

    it('the meta line reports the honest no-show status and NO date', async () => {
      // .vue:40-49. The date is the one thing a no-show must not dwell on, and
      // this screen renders none -- unlike its two FormShell siblings, which both
      // put a formatted scheduled_at in this slot. That asymmetry is the design
      // (F1), so it is worth a test rather than an assumption.
      // B30 (PROMPT №747): was «Не состоялась» -- false, the practice DID
      // happen, the person missed it; now the owner's word, "Вы не пришли".
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T13:00:00.000Z' }))
      mount()
      await flush()

      expect(text()).toContain('Вы не пришли')
      expect(text()).not.toContain('20 июля')
      expect(text()).not.toContain('13:00')
    })

    it('falls back to «Мастером» when the practice carries no master name', async () => {
      getPracticeMock.mockResolvedValue(practice({ master_name: null }))
      mount()
      await flush()

      expect(text()).toContain('Мастером')
    })

    it('does NOT re-fetch a practice the store already holds', async () => {
      // .vue:133 -- arriving from the dashboard banner, `selected` is already this
      // practice.
      usePracticesStore().selected = practice({ title: 'Уже загружена' })
      mount()
      await flush()

      expect(getPracticeMock).not.toHaveBeenCalled()
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Уже загружена')
    })

    it('a DIFFERENT practice in the store is replaced, not reused', async () => {
      // The other side of the `selected?.id !== practiceId` check (.vue:133).
      // Matching on truthiness alone would show the user whichever practice they
      // last opened, under this practice's reflection copy.
      usePracticesStore().selected = practice({ id: 'p_other', title: 'Чужая практика' })
      getPracticeMock.mockResolvedValue(practice({ id: 'p1', title: 'Та самая' }))
      mount()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
      expect(host?.querySelector('.hero-card__title')?.textContent?.trim()).toBe('Та самая')
    })

    it('fetches the practice on a cold deep-link', async () => {
      mount()
      await flush()

      expect(getPracticeMock).toHaveBeenCalledWith('p1')
    })
  })

  // ===========================================================================
  // Shape. ReflectionView is the ONLY FormShell consumer that passes no
  // #selection slot, so its shell differs structurally from its two siblings --
  // verified here rather than assumed.
  // ===========================================================================
  describe('shape (the sibling-shaped things this screen does NOT have)', () => {
    it('renders NO rating slider and no selection block at all', async () => {
      // FormShell gates the whole wrapper on `$slots.selection` (FormShell.vue:105)
      // so ReflectionView gets no phantom gap. A no-show reflection must never rate
      // a practice the user did not attend (.vue:6-7) -- the slider's ABSENCE is
      // the product decision here, not an omission.
      mount()
      await flush()

      // SC-15: pin the positive first, or these three nulls are satisfied by a
      // mount that rendered nothing.
      expect(questionTitle()).toBe('Иногда тело просит паузы')
      expect(submitBtn()).toBeDefined()

      expect(host?.querySelector('.form-shell__selection')).toBeNull()
      expect(host?.querySelector('.mood-slider')).toBeNull()
      expect(host?.querySelectorAll('.mood-slider__card').length).toBe(0)
    })

    it('renders no «Пропустить» -- there is nothing to skip', async () => {
      // `showSkip` is not passed (.vue:22-38), unlike CheckinView which offers it.
      mount()
      await flush()

      expect(submitBtn()).toBeDefined()
      expect(button('Пропустить')).toBeUndefined()
    })

    it('renders no disabled hint -- submit is never disabled to explain', async () => {
      // `:submit-disabled="false"` is a literal (.vue:31) and `disabledHint` is not
      // passed, so FormShell.vue:132's `v-if` can never be true for this screen.
      mount()
      await flush()

      expect(submitBtn()?.disabled).toBe(false)
      expect(host?.querySelector('.form-shell__disabled-hint')).toBeNull()
    })

    it('the comment textarea IS the whole form', async () => {
      mount()
      await flush()

      expect(host?.querySelectorAll('textarea').length).toBe(1)
      expect(host?.querySelector('textarea')?.getAttribute('maxlength')).toBe('1000')
    })
  })

  // ===========================================================================
  // Rotating copy (utils/reflectionVariants). Stable per practiceId.
  // ===========================================================================
  describe('the copy variant', () => {
    it('p1 draws the third variant', async () => {
      // stableHash('p1') = 112+49 = 161; 161 % 3 = 2.
      mount()
      await flush()

      expect(questionTitle()).toBe('Иногда тело просит паузы')
      expect(questionSubtitle()).toBe('Что вам сегодня было нужно больше?')
    })

    it('p2 draws the FIRST variant -- the pool actually rotates', async () => {
      // 112+50 = 162; 162 % 3 = 0. Without this the "stable" test below would pass
      // on a function that returned one constant forever.
      routeParams.practiceId = 'p2'
      getPracticeMock.mockResolvedValue(practice({ id: 'p2' }))
      mount()
      await flush()

      expect(questionTitle()).toBe('Заметили, что вас сегодня не было')
      expect(questionSubtitle()).toBe('Как ваше самочувствие?')
    })

    it('p3 draws the SECOND variant', async () => {
      // 112+51 = 163; 163 % 3 = 1. All three variants now proven reachable.
      routeParams.practiceId = 'p3'
      getPracticeMock.mockResolvedValue(practice({ id: 'p3' }))
      mount()
      await flush()

      expect(questionTitle()).toBe('Мы скучали без вас')
      expect(questionSubtitle()).toBe('Расскажете, как прошел ваш день?')
    })

    it('the SAME practice gets the SAME copy on every mount -- no flicker', async () => {
      // The whole reason the pick is a hash and not Math.random (.vue:85-87): the
      // dashboard re-evaluates its banner every 60s, and a rotating title would
      // churn under the user. Two independent mounts of the same id.
      mount()
      await flush()
      const first = questionTitle()

      app?.unmount()
      host?.remove()
      mount()
      await flush()

      expect(questionTitle()).toBe(first)
      expect(first).toBe('Иногда тело просит паузы')
    })

    it('the copy is keyed on the ROUTE param, not on the loaded practice', async () => {
      // `pickReflectionVariant(practiceId)` runs at setup off route.params
      // (.vue:83,87) -- before any fetch resolves, and independent of it. A
      // store-sourced key would make the title depend on a request that may never
      // land (see THE GAP below, where it does not).
      routeParams.practiceId = 'p2'
      getPracticeMock.mockResolvedValue(practice({ id: 'p999' }))
      mount()
      await flush()

      expect(questionTitle()).toBe('Заметили, что вас сегодня не было')
    })
  })

  // ===========================================================================
  // The error rung (wired in №445). Since BE-108 the submit reaches a real
  // endpoint, so a form offered over a failed load would fire a POST into a
  // refusal -- CheckinView's №444 bug. These hold the rung in place.
  // ===========================================================================
  describe('a FAILED practice load renders the error rung, not a form (№445)', () => {
    it('surfaces the generic fallback the store holds (no code set)', async () => {
      // The two halves that made this a gap rather than a missing feature: the data
      // was always there (practicesStore.selectedError, one property from the
      // template) and FormShell could always render it (:68) -- only the binding was
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

    it('replaces the form entirely -- no context-free reflection form is offered', async () => {
      // With the real endpoint behind the submit, a form here would fire a POST
      // for a practice that never loaded -- CheckinView's №444 bug verbatim.
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()

      expect(host?.querySelector('.form-shell__question')).toBeNull()
      expect(submitBtn()).toBeUndefined()
      expect(host?.querySelectorAll('textarea').length).toBe(0)
      expect(host?.querySelector('.hero-card')).toBeNull()
      expect(host?.querySelector('.form-shell__loader')).toBeNull()
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
      // Non-vacuous half: bind loadError to anything always-truthy and every test
      // above passes while the screen is permanently broken.
      mount()
      await flush()

      expect(errorRung()).toBeNull()
      expect(questionTitle()).toBe('Иногда тело просит паузы')
      expect(submitBtn()).toBeDefined()
    })
  })

  // ===========================================================================
  // The submit. The body the VIEW builds is captured off $onAction (exactly what
  // onSubmit hands the store); what reaches the network is read off the
  // createReflection seam, and the refresh off getMyBookings.
  // ===========================================================================
  describe('submitting the reflection', () => {
    /** Captures the (practiceId, body) the VIEW hands the store at .vue:98-100. */
    function captureSubmits(): Array<[string, { comment: string | null }]> {
      const calls: Array<[string, { comment: string | null }]> = []
      useDiaryStore().$onAction(({ name, args }) => {
        if (name === 'submitReflection') {
          calls.push(args as [string, { comment: string | null }])
        }
      })
      return calls
    }

    it('sends the trimmed comment and shows the thank-you screen', async () => {
      mount()
      await flush()
      const calls = captureSubmits()

      typeComment('   Отдыхала весь день   ')
      await flush()
      submitBtn()?.click()
      await flush()

      expect(calls).toEqual([['p1', { comment: 'Отдыхала весь день' }]])
      expect(successTitle()).toBe('Спасибо, что поделились')
      expect(text()).toContain('Бережно к себе. Возвращайтесь, когда будете готовы.')
    })

    it('an untouched form sends a null comment, not an empty string', async () => {
      // `comment.value.trim() || null`. The server normalizes blank to null as
      // well (ReflectionRequest); the client does not lean on that.
      mount()
      await flush()
      const calls = captureSubmits()

      submitBtn()?.click()
      await flush()

      expect(calls).toEqual([['p1', { comment: null }]])
    })

    it('a whitespace-only comment is sent as null, not as blanks', async () => {
      mount()
      await flush()
      const calls = captureSubmits()

      typeComment('     ')
      await flush()
      submitBtn()?.click()
      await flush()

      expect(calls).toEqual([['p1', { comment: null }]])
    })

    it('sends the reflection for the practice in the ROUTE, not the one in the store', async () => {
      // practiceId is read off route.params (.vue:83). A store-sourced id would
      // key the reflection to whichever practice happened to be `selected`.
      routeParams.practiceId = 'p42'
      usePracticesStore().selected = practice({ id: 'p_stale' })
      getPracticeMock.mockResolvedValue(practice({ id: 'p42' }))
      mount()
      await flush()
      const calls = captureSubmits()

      submitBtn()?.click()
      await flush()

      expect(calls).toEqual([['p42', { comment: null }]])
      // The route's practice is also what reaches the network.
      expect(createReflectionMock).toHaveBeenCalledWith('p42', { comment: null })
    })

    it('the success screen swaps the form out entirely and shows the heart', async () => {
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(successTitle()).toBe('Спасибо, что поделились')
      // The #success-icon slot beats the empty `success-icon=""` prop (.vue:33,52).
      expect(host?.querySelector('.reflection__success-heart')).not.toBeNull()
      // FormShell's v-if, not a v-show: the form is GONE, not hidden.
      expect(submitBtn()).toBeUndefined()
      expect(host?.querySelector('textarea')).toBeNull()
    })

    it('a successful submit refreshes the bookings list -- has_reflection comes from the server', async () => {
      // Replaces "the dashboard banner is dismissed for this practice". That test
      // was right for the stub: with no backend flag, a client-side set of
      // dismissed practices was the only thing that stopped the screen
      // re-asking. BE-108 removed the set; the server's has_reflection is the
      // one source now, and the view's part in it is to refetch the list.
      mount()
      await flush()
      // SC-15: nothing fetched the list before the submit -- the screen itself
      // never loads bookings, so the call below is the refresh and nothing else.
      expect(getMyBookingsMock).not.toHaveBeenCalled()

      submitBtn()?.click()
      await flush()

      expect(successTitle()).toBe('Спасибо, что поделились')
      expect(getMyBookingsMock).toHaveBeenCalledTimes(1)
    })

    it('the "sent" state is not kept in the browser', async () => {
      // Replaces "the dismissal SURVIVES a reload -- it is persisted". That test
      // was right for the batch O stopgap, which persisted the dismissal to
      // localStorage because nothing else remembered the submit. BE-108 deleted
      // that stopgap whole: the submit is remembered by the server alone.
      // Positive half first (SC-15): the reflection DID go to the server.
      localStorage.clear()
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(createReflectionMock).toHaveBeenCalledWith('p1', { comment: null })
      expect(localStorage.length).toBe(0)
    })

    it('submitting POSTs the reflection -- the body the view built, and nothing else', async () => {
      // Replaces "the stub is HONEST: submitting sends NOTHING". That test was
      // right while no endpoint existed; it was built as the tripwire for this
      // day and is inverted as it asked: the call and its body are asserted.
      mount()
      await flush()

      typeComment('Что-то важное')
      await flush()
      submitBtn()?.click()
      await flush()

      expect(successTitle()).toBe('Спасибо, что поделились')
      expect(createReflectionMock).toHaveBeenCalledTimes(1)
      expect(createReflectionMock).toHaveBeenCalledWith('p1', { comment: 'Что-то важное' })
      expect(calledDiaryApi()).toEqual(['createReflection'])
    })

    it('a refusal is a toast, never the thank-you screen', async () => {
      // Direct entry onto a reflection already sent: the server says 409 and the
      // phrase for its code is what the user reads; the form stays.
      createReflectionMock.mockRejectedValue(
        new ApiResponseError(409, 'Reflection already submitted', 'reflection_already_submitted'),
      )
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Вы уже поделились -- спасибо')
      expect(successTitle()).toBe('')
      expect(submitBtn()).toBeDefined()
      // A refused submit changed nothing on the server -- no refresh either.
      expect(getMyBookingsMock).not.toHaveBeenCalled()
    })

    it('a booking that is not no_show reads the not-available phrase', async () => {
      createReflectionMock.mockRejectedValue(
        new ApiResponseError(404, 'No no_show booking', 'reflection_not_available'),
      )
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Поделиться можно только по пропущенной практике')
      expect(successTitle()).toBe('')
    })
  })

  // ===========================================================================
  // Re-entry (SC-17). Read the comments -- this is NOT the usual shape, and the
  // difference is the finding.
  // ===========================================================================
  describe('re-entry', () => {
    it('two taps with no repaint send ONE reflection -- the in-flight ref catches the second', async () => {
      // Replaces "PINNED: two taps with no repaint run the submit TWICE -- both
      // guards are unreachable today". That test was right for the stub: its
      // submitReflection had no await, so the ref flipped true and back within
      // one synchronous frame and neither guard could fire. It was built to go
      // red at `toBe(2)` the day the real call landed, and asked for a 1 then.
      // BE-108 is that day: the ref now stays true across `await
      // createReflection`, the view's guard returns on the second tap, and the
      // server sees one POST.
      mount()
      await flush()
      const diary = useDiaryStore()
      let viewCalls = 0
      diary.$onAction(({ name }) => {
        if (name === 'submitReflection') viewCalls++
      })

      const btn = submitBtn()
      expect(btn).toBeDefined()
      // No await between the clicks (SC-17): with one, VButton's
      // `:disabled="disabled || loading"` would swallow the second and this would
      // be crediting the ref for the DOM's work.
      btn?.click()
      btn?.click()
      await flush()

      expect(viewCalls).toBe(1)
      expect(createReflectionMock).toHaveBeenCalledTimes(1)
      expect(successTitle()).toBe('Спасибо, что поделились')
    })

    it('the DOM rung is wired independently: an in-flight submit disables the button', async () => {
      // SC-17's other half, asserted separately and attributed to the right
      // mechanism. FormShell binds `:submitting` -> VButton `:loading` -> disabled
      // (.vue:29, FormShell.vue:127, VButton.vue:27). The ref is driven DIRECTLY
      // here -- which proves the BINDING, the only part of this rung that is this
      // screen's to get wrong; the re-entry test above proves the ref holds.
      mount()
      await flush()
      expect(submitBtn()?.disabled).toBe(false)

      useDiaryStore().reflectionSubmitting = true
      await flush()

      expect(submitBtn()?.disabled).toBe(true)
    })
  })

  describe('navigation', () => {
    it('back returns to where the user came from when there IS history', async () => {
      // .vue:120 reads window.history.state at CLICK time, not at setup -- so
      // seeding here, after the mount, is on purpose and is sufficient.
      mount()
      await flush()
      window.history.replaceState({ back: '/user/dashboard' }, '')

      const backBtn = host?.querySelector('.v-back') as HTMLElement
      expect(backBtn).not.toBeNull()
      backBtn.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })

    it('back FALLS BACK to the dashboard on a direct link with no history', async () => {
      // The reason the branch exists (.vue:118-119): a Telegram deep link or a
      // reload has no back entry, and router.back() would leave the user on a dead
      // screen. beforeEach cleared the state, so this is the cold case.
      mount()
      await flush()
      ;(host?.querySelector('.v-back') as HTMLElement).click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
      expect(back).not.toHaveBeenCalled()
    })

    it('«На главную» on the success screen goes to the dashboard', async () => {
      mount()
      await flush()
      submitBtn()?.click()
      await flush()
      expect(successTitle()).toBe('Спасибо, что поделились')

      button('На главную')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })

  // NOT COVERED, deliberately -- limits of this file's seams, stated rather than
  // faked:
  //
  // 1. platform.hapticFeedback('medium') on a successful submit (.vue:104). Wrapped
  //    in a bare try/catch with a silent fallback and returns nothing, so on the
  //    standalone platform this mount resolves to it is a no-op with no observable
  //    effect. Proving it fired would mean mocking @/platform purely to assert the
  //    mock (SC-02) -- there is no product behaviour behind it to assert instead.
  //    Same call, same reasoning, same verdict as CheckinView.test.ts.
  //
  // The FAILURE branch of onSubmit and the call that reaches the network are
  // covered above ("a refusal is a toast", "submitting POSTs the reflection").
})
