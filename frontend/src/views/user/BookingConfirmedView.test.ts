// =============================================================================
// VELO Frontend -- BookingConfirmedView Screen Tests (probekit-screen-test v1.9)
// =============================================================================
//
// 190 lines, no test. PATTERN A, ONE real store (usePracticesStore) -- same
// single-store detail shape as CheckinView/FeedbackView (real Pinia, mock the
// api/practices seam: `getPractice`). No second store, no diary, no bookings
// here -- this screen only confirms a practice EXISTS, it does not read the
// user's booking at all.
//
// PROVEN ABSENT (grepped the whole template before writing a single test):
//  - NO practice-specific data is ever rendered. `practice` gates the ladder
//    but its title/master_name/scheduled_at/price are NEVER interpolated
//    anywhere in the content block -- the success card is 100% static copy
//    ("Практика забронирована!", a fixed 10-minute Zoom line). This directly
//    contradicts the assumed shape ("cover that the right data renders") --
//    there is no per-practice data to cover; two different fixtures produce
//    byte-identical visible text (proven below). STILL TRUE after the
//    ask-master rewrite: the practice's `master_id` is now READ (it is the
//    chat's target) but never rendered, so the byte-identity test below is
//    unaffected and the send-path test asserts the id through the API call.
//  - NO money anywhere -- no formatMoney, no price. No NBSP trap, no norm().
//  - NO wall clock -- no Date.now()/new Date() read by this screen at all
//    (the "10 minutes before" line is a hardcoded string, not computed).
//  - NO route-level guard (checked router/index.ts -- same as CalendarView/
//    PracticeLiveView, covered only by the root roleRedirect already tested
//    in guards.test.ts). Not duplicated here.
//
// ⭐ THE COMBINED ERROR/MISSING RUNG (.vue:34, `store.selectedError ||
// !practice`) -- the exact bug class just fixed on CalendarView (a guard
// reading "is there ANY data" where it should read "is there the RIGHT data
// for what's on screen"). TWO findings were surfaced against this rung
// (PROMPT №464); this file now reflects the outcome of BOTH:
//
//  (a) STRUCTURAL, NOT USER-VISIBLE -- STILL PRESENT, NOT FIXED (out of scope,
//      the owner's call): the guard's own literal DEFAULTS
//      (selectedLoading=false, selected=null, selectedError=null -- the
//      state before onMounted has run at all) satisfy `!practice` and fail
//      the loading guard -- so on the FIRST synchronous render, before
//      onMounted's fetchPractice() call has flipped `loading`, the DOM
//      technically matches the error rung. Reproduced below (zero-tick
//      assertion). BUT: the flip to loading=true happens within the SAME
//      microtask-flush cycle as the initial mount (no real network delay
//      between the "wrong" state and the fix), and browsers drain microtasks
//      before paint -- unlike CalendarView's bug, a real browser would very
//      likely never paint this frame. Left as a documented structural note.
//
//  (b) REAL AND BOUNDED -- FIXED HERE (PROMPT №466). `practice` (.vue:91) used
//      to be bare `store.selected`, with NO check that it belongs to THIS
//      screen's route practiceId. usePracticesStore is a session-lifetime
//      singleton; a stale DIFFERENT practice left in store.selected by an
//      earlier screen satisfied `!practice = false` for the entire duration
//      of a fetch for a NEW id, skipping the loader and letting the
//      (harmless, since static) success card render while the real
//      confirmation was still in flight -- or, on a failing fetch, flashing
//      "Практика забронирована!" before "Практика не найдена" for a practice
//      that was never confirmed. FIX: `practice` now reads
//      `store.selected?.id === practiceId ? store.selected : null` -- a
//      stale different-id value is treated as not-yet-loaded, not as
//      content. The two tests below that used to document the bug now assert
//      the FIXED behavior and serve as its regression test, mutation-proved
//      (revert the fix -> both go red -> restore -- git diff clean before
//      commit).
//
// TICKS: fetchPractice's own chain is one `await getPractice(id)` (not
// awaited by onMounted itself, fire-and-forget) + a final re-render -- flush()
// uses 4, generous per velo-idiom §3 (an over-count is harmless).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import BookingConfirmedView from '@/views/user/BookingConfirmedView.vue'
import { usePracticesStore } from '@/stores/practices'
import { getPractice } from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import * as chatsApi from '@/api/chats'
import type { PracticeResponse } from '@/api/types'

vi.mock('@/api/practices', async () => {
  const actual = await vi.importActual<typeof import('@/api/practices')>('@/api/practices')
  return { ...actual, getPractice: vi.fn() }
})
const getPracticeMock = vi.mocked(getPractice)

// The ask-master seam: TWO calls in order (open-or-get the thread, then post
// the text into it), so both are mocked and both are asserted -- a test that
// only checked openChat would pass on a screen that opens a thread and drops
// the user's words.
vi.mock('@/api/chats')

const push = vi.fn()
const routeParams: { practiceId: string } = { practiceId: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

const toastInfo = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: toastInfo }),
}))

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'master_1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Утренняя медитация',
    description: null,
    scheduled_at: '2026-07-20T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 5,
    zoom_link: null,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    direction: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(BookingConfirmedView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

function loader(): HTMLElement | null {
  return host?.querySelector('.booking-confirmed__loader') ?? null
}
function content(): HTMLElement | null {
  return host?.querySelector('.booking-confirmed__content') ?? null
}
function emptyState(): HTMLElement | null {
  return host?.querySelector('.v-empty') ?? null
}
function emptyTitle(): string {
  return (emptyState()?.querySelector('.v-empty__title')?.textContent ?? '').trim()
}
function emptyDesc(): string {
  return (emptyState()?.querySelector('.v-empty__desc')?.textContent ?? '').trim()
}
function homeBtn(): HTMLButtonElement | null {
  return emptyState()?.querySelector<HTMLButtonElement>('button') ?? null
}
function textarea(): HTMLTextAreaElement | null {
  return host?.querySelector<HTMLTextAreaElement>('.v-textarea__field') ?? null
}
function sendBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.booking-confirmed__ask .v-btn') ?? null
}
/** Drive VTextarea's v-model the way a keystroke does (it emits on `input`). */
function type(value: string): void {
  const el = textarea()
  if (!el) throw new Error('the request textarea did not render')
  el.value = value
  el.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  getPracticeMock.mockReset()
  toastInfo.mockReset()
  toastError.mockReset()
  vi.mocked(chatsApi.openChat).mockReset()
  vi.mocked(chatsApi.sendChatMessage).mockReset()
  push.mockReset()
  routeParams.practiceId = 'p1'
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('BookingConfirmedView', () => {
  // ===========================================================================
  describe('the ladder', () => {
    it('loading: once the reactivity flush lands, the loader shows and neither the error/missing rung nor content does', async () => {
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await nextTick() // one tick is enough for loading=true to flush (SC finding (a))

      expect(loader()).not.toBeNull()
      expect(emptyState()).toBeNull()
      expect(content()).toBeNull()
    })

    it("(finding a, structural) the FIRST synchronous frame -- zero ticks after mount() -- already matches the error/missing rung, because the guard's own literal defaults (loading=false, practice=null, error=null) satisfy `!practice` before onMounted's fetchPractice() write has been flushed by Vue's scheduler", () => {
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount() // NO await at all -- inspecting the pre-flush DOM on purpose

      expect(emptyState()).not.toBeNull()
      expect(emptyTitle()).toBe('Практика не найдена')
      expect(loader()).toBeNull()
    })

    it('error: the real backend message renders in the combined rung', async () => {
      getPracticeMock.mockRejectedValue(
        new ApiResponseError(404, 'Практика не существует', 'not_found'),
      )
      mount()
      await flush()

      expect(emptyTitle()).toBe('Практика не найдена')
      expect(emptyDesc()).toBe('Практика не существует')
      expect(loader()).toBeNull()
      expect(content()).toBeNull()
    })

    it('error fallback: a non-ApiResponseError shows the hardcoded fallback, not a raw exception message', async () => {
      getPracticeMock.mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(emptyDesc()).toBe('Не удалось загрузить практику')
    })

    it('content: a successful fetch renders the static success card', async () => {
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()

      expect(loader()).toBeNull()
      expect(emptyState()).toBeNull()
      expect(content()).not.toBeNull()
      expect(content()?.textContent).toContain('Практика забронирована!')
      expect(content()?.textContent).toContain('Ссылка на Zoom появится за 10 минут до начала.')
    })

    it('proves absence: content shows the SAME static text regardless of which practice was fetched -- no title/master/time is ever rendered', async () => {
      getPracticeMock.mockResolvedValue(
        practice({ id: 'p1', title: 'Утренняя медитация', master_name: 'Аня' }),
      )
      mount()
      await flush()
      const textA = content()?.textContent

      app?.unmount()
      host?.remove()
      getPracticeMock.mockResolvedValue(
        practice({ id: 'p2', title: 'Совершенно другая практика', master_name: 'Борис' }),
      )
      routeParams.practiceId = 'p2'
      mount()
      await flush()
      const textB = content()?.textContent

      expect(textA).toBe(textB)
      expect(textA).not.toContain('Утренняя медитация')
      expect(textA).not.toContain('Аня')
    })

    it('goToDashboard: "На главную" from the error/missing rung navigates to the dashboard', async () => {
      getPracticeMock.mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      homeBtn()?.click()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })

  // ===========================================================================
  describe('mount', () => {
    it('fetches the practice by the route practiceId', () => {
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      routeParams.practiceId = 'p_specific'
      mount()

      expect(getPracticeMock).toHaveBeenCalledWith('p_specific')
    })
  })

  // ===========================================================================
  describe('⭐ regression (finding b, №464, fixed №466): a stale different-id store.selected no longer fools the loading guard', () => {
    it('a stale DIFFERENT practice already in store.selected: the loader shows (not stale content) while the real fetch for THIS practice is in flight', async () => {
      // Populate store.selected with a DIFFERENT practice first, exactly as a
      // real session would after viewing/purchasing it on another screen.
      const store = usePracticesStore()
      getPracticeMock.mockResolvedValue(practice({ id: 'p_other' }))
      await store.fetchPractice('p_other')
      expect(store.selected?.id).toBe('p_other')

      // Now mount THIS screen for a DIFFERENT id, with its fetch left pending.
      routeParams.practiceId = 'p_new'
      getPracticeMock.mockReset()
      getPracticeMock.mockReturnValue(new Promise(() => {}))
      mount()
      await nextTick() // let loading=true flush -- same one tick as the plain loading test

      // FIXED: `practice` now requires store.selected.id === practiceId, so
      // the stale p_other no longer counts as "we have data" -- the loader
      // correctly shows instead of the stale success card.
      expect(loader()).not.toBeNull()
      expect(content()).toBeNull()
    })

    it('...and if that in-flight fetch then fails, the screen goes straight to the error rung -- it never shows "Практика забронирована!" for a practice that was never confirmed', async () => {
      const store = usePracticesStore()
      getPracticeMock.mockResolvedValue(practice({ id: 'p_other' }))
      await store.fetchPractice('p_other')

      routeParams.practiceId = 'p_new'
      let reject!: (e: unknown) => void
      getPracticeMock.mockReset()
      getPracticeMock.mockReturnValue(new Promise((_, rej) => (reject = rej)))
      mount()
      await nextTick()

      // FIXED: still genuinely loading -- the loader shows, not the stale content.
      expect(loader()).not.toBeNull()
      expect(content()).toBeNull()
      expect(emptyState()).toBeNull()

      reject(new ApiResponseError(404, 'Практика не существует', 'not_found'))
      await flush()

      // The screen goes DIRECTLY to the error rung -- no "success" flash ever happened.
      expect(emptyTitle()).toBe('Практика не найдена')
      expect(content()).toBeNull()
    })
  })

  // ===========================================================================
  // ask-master, REAL (was the TD-ASK-MASTER stub: field hard-disabled, button
  // hard-disabled, a «Вопросы мастеру — скоро» hint and a handler that only
  // toasted). It now opens-or-gets the DM with THIS practice's master and posts
  // the typed text as a message. The two tests that pinned the stub are gone --
  // they asserted `disabled === true` unconditionally, which is exactly the
  // behaviour being removed.
  describe('ask-master (real: opens the DM and sends the text)', () => {
    const THREAD = { id: 'thread-7', created_at: '2026-08-01T10:30:00+00:00' }
    const SENT = {
      id: 'msg-1',
      thread_id: 'thread-7',
      sender: 'user_1',
      body: 'Болит колено',
      created_at: '2026-08-01T10:30:01+00:00',
    }

    it('the textarea is editable now -- typing into it actually updates the model (the stub`s disabled field could not)', async () => {
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()

      expect(textarea()?.disabled).toBe(false)
      type('Болит колено')
      await nextTick()

      expect(textarea()?.value).toBe('Болит колено')
    })

    it('the send button is disabled while the field is blank and enabled once there is text -- same rule as the chat composer', async () => {
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()
      expect(sendBtn()?.disabled).toBe(true)

      type('Болит колено')
      await nextTick()

      expect(sendBtn()?.disabled).toBe(false)
    })

    it('whitespace alone does NOT enable it -- the guard trims', async () => {
      getPracticeMock.mockResolvedValue(practice())
      mount()
      await flush()

      type('   \n  ')
      await nextTick()

      expect(sendBtn()?.disabled).toBe(true)
    })

    it("sending: opens the thread with the fetched practice's OWN master_id, posts the trimmed text, then navigates into the thread", async () => {
      getPracticeMock.mockResolvedValue(practice({ master_id: 'master_specific' }))
      vi.mocked(chatsApi.openChat).mockResolvedValue(THREAD)
      vi.mocked(chatsApi.sendChatMessage).mockResolvedValue(SENT)
      mount()
      await flush()

      type('  Болит колено  ')
      await nextTick()
      sendBtn()?.click()
      await flush()

      expect(chatsApi.openChat).toHaveBeenCalledWith('master_specific')
      // The thread id comes from the OPEN response, not from anywhere else.
      expect(chatsApi.sendChatMessage).toHaveBeenCalledWith('thread-7', 'Болит колено')
      expect(push).toHaveBeenCalledWith({ name: 'user-chat', params: { id: 'thread-7' } })
    })

    it('a successful send clears the field, so returning to this screen does not offer to send the same text again', async () => {
      getPracticeMock.mockResolvedValue(practice())
      vi.mocked(chatsApi.openChat).mockResolvedValue(THREAD)
      vi.mocked(chatsApi.sendChatMessage).mockResolvedValue(SENT)
      mount()
      await flush()

      type('Болит колено')
      await nextTick()
      sendBtn()?.click()
      await flush()

      expect(textarea()?.value).toBe('')
      expect(sendBtn()?.disabled).toBe(true)
    })

    it("a failed OPEN surfaces the backend's own message and does not navigate -- and the text survives for a retry", async () => {
      getPracticeMock.mockResolvedValue(practice())
      vi.mocked(chatsApi.openChat).mockRejectedValue(
        new ApiResponseError(502, 'Сервис сообщений недоступен', 'bad_gateway'),
      )
      mount()
      await flush()

      type('Болит колено')
      await nextTick()
      sendBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Сервис сообщений недоступен')
      expect(chatsApi.sendChatMessage).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(textarea()?.value).toBe('Болит колено')
    })

    it('a thread that opens but a message that fails is NOT treated as success: no navigation, the text stays, and the failure is named', async () => {
      getPracticeMock.mockResolvedValue(practice())
      vi.mocked(chatsApi.openChat).mockResolvedValue(THREAD)
      vi.mocked(chatsApi.sendChatMessage).mockRejectedValue(
        new ApiResponseError(500, 'Сообщение не доставлено', 'internal_error'),
      )
      mount()
      await flush()

      type('Болит колено')
      await nextTick()
      sendBtn()?.click()
      await flush()

      expect(chatsApi.openChat).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Сообщение не доставлено')
      expect(push).not.toHaveBeenCalled()
      expect(textarea()?.value).toBe('Болит колено')
    })

    it('a non-ApiResponseError falls back to the screen`s own copy, not a raw exception message', async () => {
      getPracticeMock.mockResolvedValue(practice())
      vi.mocked(chatsApi.openChat).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      type('Болит колено')
      await nextTick()
      sendBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отправить запрос')
    })

    it('re-entry: two clicks with no tick between them open ONE thread and send ONE message', async () => {
      getPracticeMock.mockResolvedValue(practice())
      vi.mocked(chatsApi.openChat).mockResolvedValue(THREAD)
      vi.mocked(chatsApi.sendChatMessage).mockResolvedValue(SENT)
      mount()
      await flush()

      type('Болит колено')
      await nextTick()
      const btn = sendBtn()
      btn?.click()
      btn?.click()
      await flush()

      expect(chatsApi.openChat).toHaveBeenCalledTimes(1)
      expect(chatsApi.sendChatMessage).toHaveBeenCalledTimes(1)
    })
  })
})
