// =============================================================================
// VELO Frontend -- ReflectionView Screen Tests
// =============================================================================
//
// WHY: this is the third and last FormShell consumer, and the only one still
// UNWIRED after №444. Its sibling CheckinView had a real gap -- a deep link
// whose practice fetch FAILED rendered a live form for a POST the backend would
// refuse, because the screen never read `practicesStore.selectedError` and
// FormShell had no error rung. FormShell now HAS `loadError` + a `retry` emit.
// ReflectionView passes NEITHER and reads `selectedError` nowhere, so it carries
// the identical shape. This file PINS that shape as it is today (see THE GAP
// below) rather than fixing it -- coverage only.
//
// The screen is also a STUB by design (TD-REFLECTION, .vue:11): submitReflection
// persists NOTHING because `POST /practices/{id}/reflection` does not exist yet
// (diary.ts:130-145). That is not a defect to report -- it is the documented
// contract, and this file's job is to hold the UI honest to it: the flow
// completes, the dashboard banner is dismissed client-side, and NOT ONE byte
// reaches the diary API. The last part is asserted at the network (see
// "the stub is honest") and is the tripwire that fires the day the endpoint
// lands.
//
// PATTERN A (store-backed), all three stores REAL. The seam is @/api/practices
// (the only wrapper any of this actually calls). @/api/diary is auto-mocked NOT
// because anything calls it, but so the "nothing was sent" assertion is made
// against the whole module rather than a hand-picked export. @/api/bookings is
// left REAL and unmocked on purpose: ReflectionView never fetches bookings, it
// only calls the local `dismissReflection` mutator, so there is no network
// boundary there to fake. One pinia instance goes to both setActivePinia and
// app.use (SC-03).
//
// Real stores, not mocks, for the same reason CheckinView.test.ts gives: the
// re-entry path gates on `diaryStore.reflectionSubmitting`, a ref only the REAL
// store flips. A mocked diary store freezes it at `false` and the double-click
// test would pass for the wrong reason.
//
// TICKS = 6. Counted, not copied (SC-08). Both chains here are SHALLOW -- far
// shallower than CheckinView's 10, which is why that number is not reused:
//   mount:  onMounted -> fetchPractice (DETACHED, .vue:134 is not awaited) ->
//           await getPractice (1) -> assign selected + finally (2) -> re-render (3)
//   submit: onSubmit -> submitReflection (NO await inside it -- the stub's whole
//           body is synchronous, diary.ts:136-144) -> the `await` at .vue:98
//           resumes (1) -> dismissReflection + submitted=true -> re-render (2)
// 6 is double the deeper of the two. An over-count is harmless (velo-idiom §3);
// an under-count would fail loudly on the toEqual/text assertions.
//
// THE GAP, pinned deliberately (the deliverable of this file):
//   `a FAILED practice load renders the error rung, not a form` (wired №445)
//   and its two neighbours below. Today `practicesStore.selectedError` holds the
//   real backend message and the screen ignores it: no error rung, no «Повторить»,
//   submit fully enabled, and the submit "succeeds" onto the thank-you screen for
//   a practice that never loaded. Those tests assert TODAY'S behaviour, including
//   `expect(text()).not.toContain('Не удалось загрузить практику')`, so wiring
//   `:load-error="practicesStore.selectedError"` + `@retry` turns them RED. That
//   is the point: they are not approving the gap, they are a bell on it. When the
//   bell rings, invert them against CheckinView.test.ts:484-520, which is the
//   already-written shape of the answer.
//
// WHY the gap is NOT reported as a live bug: unlike CheckinView, this screen's
// submit reaches no endpoint at all (the stub), so a form offered over a failed
// load cannot currently produce a rejected POST -- only a thank-you screen for a
// practice nobody loaded, which is cosmetic. It becomes CheckinView's bug exactly
// when TD-REFLECTION lands. Latent, not live. Said precisely rather than loudly.
//
// TRAPS PRESENT:
//  - localStorage, and it CROSSES TESTS. `dismissReflection` PERSISTS to
//    'velo:dismissed-reflections' (bookings.ts:99-108, batch O stopgap) and
//    `dismissedReflections` is seeded FROM localStorage at store setup
//    (bookings.ts:98). A fresh pinia per test does NOT save you: the new store
//    re-reads the same surviving key, so test N's dismiss pre-dismisses test N+1.
//    Cleared in beforeEach. This is the SC-13 lesson in a different costume --
//    state that outlives the app that made it.
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
//  - SC-15: the "nothing was sent" and "no error rung" assertions are all
//    satisfied by a mount that rendered nothing. Every one of them pins the
//    positive FIRST -- the question is up, the button exists, the button is
//    enabled -- so the exclusion is real.
//  - SC-18: the fixture defaults ('Утренняя практика' / 'Мастер Аня') differ from
//    every value any test overrides, so a dropped `...overrides` fails loudly
//    instead of silently agreeing.
//  - SC-17, inverted: see "re-entry" below. The usual double-click test cannot be
//    written here because there is no guard left to catch -- and that is itself
//    pinned rather than papered over.
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
import { useBookingsStore } from '@/stores/bookings'
import { useDiaryStore } from '@/stores/diary'
import { usePracticesStore } from '@/stores/practices'
import { ApiResponseError } from '@/api/client'
import { getPractice } from '@/api/practices'
import * as diaryApi from '@/api/diary'
import type { PracticeResponse } from '@/api/types'

// -- the only live seam: the practices store's wrapper (velo-idiom §4).
vi.mock('@/api/practices', async () => {
  const actual = await vi.importActual<typeof import('@/api/practices')>('@/api/practices')
  return { ...actual, getPractice: vi.fn() }
})

// -- @/api/diary is auto-mocked wholesale (velo-idiom §4, the bare form) so the
// "the stub sends NOTHING" assertion can sweep EVERY export instead of a list I
// chose. No real export needs preserving: ApiResponseError lives in @/api/client.
// The day `upsertReflection` is added and called, the sweep goes red on a name
// this file never had to know.
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

const DISMISSED_KEY = 'velo:dismissed-reflections'

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
  ) as HTMLButtonElement | undefined
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

/**
 * Every export of @/api/diary, asserted untouched. Swept rather than listed so a
 * future `upsertReflection` is covered without this file being edited.
 */
function expectDiaryApiSilent(): void {
  const called = Object.entries(diaryApi)
    .filter(([, fn]) => vi.isMockFunction(fn))
    .filter(([, fn]) => (fn as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    .map(([name]) => name)
  expect(called).toEqual([])
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  routeParams.practiceId = 'p1'

  // The dismiss is PERSISTED (bookings.ts:103) and the store re-seeds from it at
  // setup (bookings.ts:98), so a surviving key would pre-dismiss the next test.
  localStorage.removeItem(DISMISSED_KEY)
  // onBack reads this at CLICK time (.vue:120). Reset so a seeded test cannot
  // leak `back` into the no-history fallback test.
  window.history.replaceState({}, '')

  getPracticeMock.mockReset().mockResolvedValue(practice())
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  localStorage.removeItem(DISMISSED_KEY)
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
      // .vue:40-47. The date is the one thing a no-show must not dwell on, and
      // this screen renders none -- unlike its two FormShell siblings, which both
      // put a formatted scheduled_at in this slot. That asymmetry is the design
      // («Не состоялась», F1), so it is worth a test rather than an assumption.
      getPracticeMock.mockResolvedValue(practice({ scheduled_at: '2026-07-20T13:00:00.000Z' }))
      mount()
      await flush()

      expect(text()).toContain('Не состоялась')
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
  // THE GAP -- the deliverable. FormShell gained `loadError` + `retry` in №444;
  // ReflectionView passes neither and reads `selectedError` nowhere. These three
  // tests assert TODAY'S behaviour and are BUILT TO GO RED when the wiring lands.
  // Invert them against CheckinView.test.ts:484-520 when they do.
  // ===========================================================================
  describe('a FAILED practice load renders the error rung, not a form (№445)', () => {
    it('surfaces the REAL backend message the store holds', async () => {
      // The two halves that made this a gap rather than a missing feature: the data
      // was always there (practicesStore.selectedError, one property from the
      // template) and FormShell could always render it (:68) -- only the binding was
      // missing. Asserting the store side still proves the rung shows the REAL
      // message and not a constant of its own (SC-05).
      getPracticeMock.mockRejectedValue(new ApiResponseError(404, 'Практика не найдена'))
      mount()
      await flush()

      expect(usePracticesStore().selectedError).toBe('Практика не найдена')
      expect(errorRung()).not.toBeNull()
      expect(text()).toContain('Не удалось загрузить практику')
      expect(text()).toContain('Практика не найдена')
      expect(button('Повторить')).toBeDefined()
    })

    it('replaces the form entirely -- no context-free reflection form is offered', async () => {
      // This screen's gap was LATENT, not reachable: its submit is a stub with no
      // endpoint, so nothing was ever fired into a refusal. It is fixed anyway,
      // because the day TD-REFLECTION lands it becomes CheckinView's №444 bug
      // verbatim -- and by then nobody would remember to look.
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
  // The submit. There is no network to assert against (the stub), so the values
  // asserted are the screen's OWN transformation of its input -- captured off
  // $onAction, which sees exactly what .vue:98 built -- plus the store state it
  // moves. Never "the mock was called" (SC-02).
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
      // `comment.value.trim() || null` (.vue:99). A bare '' would be a row of
      // nothing the day this actually persists.
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
      expect(useBookingsStore().dismissedReflections).toEqual(['p42'])
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

    it('the dashboard banner is dismissed for this practice', async () => {
      // .vue:110. There is no backend `has_reflection` flag (TD-REFLECTION), so
      // this client-side set is the ONLY thing that stops the dashboard re-asking
      // (UserDashboardView.vue:287 reads it). Asserted as store state, which is
      // what the dashboard actually consumes.
      mount()
      await flush()
      expect(useBookingsStore().dismissedReflections).toEqual([])

      submitBtn()?.click()
      await flush()

      expect(useBookingsStore().dismissedReflections).toEqual(['p1'])
    })

    it('the dismissal SURVIVES a reload -- it is persisted, not session-only', async () => {
      // bookings.ts:99-108 (batch O stopgap). Its sibling `dismissCheckin`
      // (bookings.ts:74-78) is deliberately session-only and writes nothing -- the
      // two mutators sit four lines apart and differ, so the persistence half is
      // pinned here rather than assumed from the neighbour.
      mount()
      await flush()

      submitBtn()?.click()
      await flush()

      expect(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? 'null')).toEqual(['p1'])
    })

    it('the stub is HONEST: submitting sends NOTHING to the diary API', async () => {
      // The contract at .vue:11-15 / diary.ts:122-129, held at the network. The UI
      // completes and claims nothing was "saved" -- and nothing was.
      //
      // TRIPWIRE (the good kind): when TD-REFLECTION lands and submitReflection
      // starts calling `upsertReflection`, this sweep goes red without naming it.
      // At that point this test inverts to assert the call and its body -- and the
      // GAP tests above stop being cosmetic on the same day.
      mount()
      await flush()

      typeComment('Что-то важное')
      await flush()
      submitBtn()?.click()
      await flush()

      // SC-15: pin the positive first -- the submit DID run end-to-end.
      expect(successTitle()).toBe('Спасибо, что поделились')
      expect(useBookingsStore().dismissedReflections).toEqual(['p1'])

      expectDiaryApiSilent()
    })
  })

  // ===========================================================================
  // Re-entry (SC-17). Read the comments -- this is NOT the usual shape, and the
  // difference is the finding.
  // ===========================================================================
  describe('re-entry', () => {
    it('PINNED: two taps with no repaint run the submit TWICE -- both guards are unreachable today', async () => {
      // The canonical SC-17 test cannot be written here, and pretending otherwise
      // would be the exact lie SC-17 warns about. There are TWO guards on this
      // path -- the view's (.vue:96) and the store's (diary.ts:134) -- and today
      // NEITHER can fire, because `submitReflection`'s body has NO await
      // (diary.ts:136-144): it flips reflectionSubmitting true, returns, and the
      // `finally` flips it back, all in ONE synchronous frame. So by the time the
      // second tap reads the ref it is already false again.
      //
      // This is NOT a bug and is NOT reported as one: the guards are correct FOR
      // THE REAL IMPLEMENTATION. The day `await upsertReflection(...)` lands, the
      // ref stays true across the await, the view's guard fires, and this test
      // goes RED at `toBe(2)`. That is the tripwire -- and the red is the SIGNAL
      // that the guard finally works. Change the 2 to a 1 then, not before.
      //
      // Harmless today for two reasons worth stating, since they are what makes
      // this pinnable rather than reportable: nothing is sent (no API), and
      // `dismissReflection` is idempotent (bookings.ts:100).
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
      // `:disabled="disabled || loading"` (VButton.vue:27) would swallow the second
      // and this would be crediting a ref for the DOM's work. Not that it could --
      // see above; the ref is false by now either way.
      btn?.click()
      btn?.click()
      await flush()

      expect(viewCalls).toBe(2)
      // The user still lands somewhere honest, and the dismiss did not double up.
      expect(successTitle()).toBe('Спасибо, что поделились')
      expect(useBookingsStore().dismissedReflections).toEqual(['p1'])
      expectDiaryApiSilent()
    })

    it('the DOM rung is wired independently: an in-flight submit disables the button', async () => {
      // SC-17's other half, asserted separately and attributed to the right
      // mechanism. FormShell binds `:submitting` -> VButton `:loading` -> disabled
      // (.vue:29, FormShell.vue:127, VButton.vue:27). The stub never holds the ref
      // long enough for a repaint to see it (above), so the ref is driven DIRECTLY
      // here -- which proves the BINDING, the only part of this rung that is this
      // screen's to get wrong. When the endpoint lands, the ref will hold itself
      // and this rung starts working for real; the binding is already correct.
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
  // 2. The FAILURE branch of onSubmit -- `toast.error(result.error)` (.vue:113).
  //    It is UNREACHABLE today, and not for want of trying: `submitReflection`
  //    returns ok:false on exactly one path (its own re-entry guard, diary.ts:134),
  //    the view's identical guard (.vue:96) sits in front of it and would return
  //    first, and neither can fire anyway because the stub never awaits (see the
  //    re-entry test). The try block cannot throw -- it is `void practiceId; void
  //    body; return { ok: true }`. So there is no input, from any seam this file
  //    has, that reaches that line. Reaching it would mean mocking the diary store
  //    wholesale, which would then be asserting my own fixture rather than the
  //    screen (SC-02) and would cost the real-ref re-entry test above. It becomes
  //    reachable, and testable, the day the endpoint lands -- alongside the
  //    toast.error('') an empty `error` string would produce, which is worth a look
  //    at that point.
  //
  // 3. That the reflection is PERSISTED. It is not, by design (TD-REFLECTION), and
  //    the honest assertion is the inverse -- "the stub is HONEST" above, which
  //    holds the whole diary API silent.
})
