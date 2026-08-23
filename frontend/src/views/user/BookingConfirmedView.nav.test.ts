// =============================================================================
// VELO Frontend -- BookingConfirmedView back-navigation integration test
// =============================================================================
//
// [FE-2] Requirement: no request loop after the send (capability: user-booking)
// After «Отправить запрос» the back stack SHALL contain no trace of the request
// screen behind «Моя практика»: back from practice-detail SHALL land on the
// entry that preceded the practice screen (e.g. the calendar), and the chat
// thread SHALL NOT have been opened along the way.
//
// WHY A SEPARATE FILE: BookingConfirmedView.test.ts mocks vue-router wholesale
// (useRouter/useRoute stubs) -- perfect for the screen's own ladder and error
// paths, but it can only assert "back() was invoked", never WHERE the history
// actually lands. FE-2 is precisely a statement about history, so this file
// runs a REAL vue-router (createMemoryHistory -- the same navigation state
// machine createWebHistory uses in the browser) with the REAL view mounted
// through <RouterView/>, and asserts the actual currentRoute after every step.
//
// SCOPE HONESTY: memory history does NOT populate history.state.{back,...}
// (only createWebHistory builds those entries), so here the view always takes
// the REPLACE branch. What this file therefore proves end-to-end: the send
// lands on «Моя практика», the chat is never entered, the request screen is
// gone from the stack (visited exactly once), and back from «Моя практика»
// goes to the pre-practice entry -- the loop request -> messages -> request
// cannot reproduce. The router.back() branch itself (state.back matching
// /user/practices/:id -- a web-history-only contract) stays pinned by the
// [FE-1] unit tests' historyState mock; the two files are complementary.
//
// Scenario A: normal flow -- calendar -> practice -> booking-confirmed, send,
// then back from «Моя практика» lands on the CALENDAR, not the request screen.
//
// Scenario B: deep link -- straight into booking-confirmed (nothing usable
// behind), send, back lands on the pre-entry root; the request screen was
// REPLACED out of history (FE-1's deep-link branch).
//
// TRAPS ABSENT: no wall clock of the screen's own (scheduled_at is a fixed
// fixture), no money, no second store beyond the real practices singleton.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView, type Router } from 'vue-router'
import BookingConfirmedView from '@/views/user/BookingConfirmedView.vue'
import { getPractice } from '@/api/practices'
import * as chatsApi from '@/api/chats'
import type { PracticeResponse } from '@/api/types'

vi.mock('@/api/practices', async () => {
  const actual = await vi.importActual<typeof import('@/api/practices')>('@/api/practices')
  return { ...actual, getPractice: vi.fn() }
})
const getPracticeMock = vi.mocked(getPractice)

vi.mock('@/api/chats')

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

const StubChild = { template: '<div class="stub-child" />' }

function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'root', component: StubChild },
      { path: '/user/calendar', name: 'user-calendar', component: StubChild },
      { path: '/user/practices/:id', name: 'practice-detail', component: StubChild },
      {
        path: '/user/booking-confirmed/:practiceId',
        name: 'user-booking-confirmed',
        // The REAL view: mounted through <RouterView/>, so useRoute/useRouter
        // resolve against this very router -- the wiring the app ships with.
        component: BookingConfirmedView,
      },
      { path: '/user/profile/messages/:id', name: 'user-chat', component: StubChild },
    ],
  })
}

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
let router: Router
const visited: string[] = []

async function boot(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  router = buildRouter()
  router.afterEach((to) => visited.push(to.path))
  app = createApp({ render: () => h(RouterView) })
  app.use(pinia)
  app.use(router)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

// Router-side settling: vue-router's navigation chain (guards -> components ->
// finalize) resolves across a macrotask boundary, and router.back() returns
// void (it is go(-1), NOT a navigation promise), so awaiting it proves
// nothing -- the route must be read after the macrotask hop.
async function settle(): Promise<void> {
  await flush()
  await new Promise((r) => setTimeout(r, 0))
}

function textarea(): HTMLTextAreaElement | null {
  return host?.querySelector<HTMLTextAreaElement>('.v-textarea__field') ?? null
}
function sendBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.booking-confirmed__ask .v-btn') ?? null
}
async function send(text: string): Promise<void> {
  const el = textarea()
  if (!el) throw new Error('the request textarea did not render')
  el.value = text
  el.dispatchEvent(new Event('input'))
  await nextTick()
  sendBtn()?.click()
  await settle()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  visited.length = 0
  getPracticeMock.mockReset()
  getPracticeMock.mockResolvedValue(practice())
  vi.mocked(chatsApi.openChat).mockReset()
  vi.mocked(chatsApi.openChat).mockResolvedValue({
    id: 'thread-7',
    created_at: '2026-08-01T10:30:00+00:00',
  })
  vi.mocked(chatsApi.sendChatMessage).mockReset()
  vi.mocked(chatsApi.sendChatMessage).mockResolvedValue({
    id: 'msg-1',
    thread_id: 'thread-7',
    sender: 'user_1',
    body: 'x',
    created_at: '2026-08-01T10:30:01+00:00',
  })
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('BookingConfirmedView back-navigation [FE-2]', () => {
  it('normal flow: after the send we stand on «Моя практика», and back from there lands on the CALENDAR -- never back into the request screen, never the chat', async () => {
    await boot()
    await router.push('/user/calendar')
    await router.push('/user/practices/p1')
    await router.push('/user/booking-confirmed/p1')
    await flush()

    await send('Болит колено')

    // The send stepped us BACK onto the practice screen (no new entry)...
    expect(router.currentRoute.value.path).toBe('/user/practices/p1')
    // ...the chat thread was never entered along the way...
    expect(visited).not.toContain('/user/profile/messages/thread-7')
    // ...and the request screen was visited exactly once (the original push).
    expect(visited.filter((p) => p.startsWith('/user/booking-confirmed'))).toHaveLength(1)

    // The FE-2 core: back from «Моя практика» never resurrects the request
    // screen. In MEMORY history the send went through the replace branch
    // (state.back is a web-history-only field -- see the banner), so the
    // practice entry sits in the stack TWICE: the original push + the entry
    // that replaced the request screen. The first back lands on that ORIGINAL
    // practice entry; in the browser the back-branch collapses it into one
    // hop. Either way the loop request -> messages -> request is gone.
    await router.back()
    await settle()
    expect(router.currentRoute.value.path).not.toBe('/user/booking-confirmed/p1')
    expect(router.currentRoute.value.path).toBe('/user/practices/p1')

    // And the hop behind the practice screen is untouched by the whole flow.
    await router.back()
    await settle()
    expect(router.currentRoute.value.path).toBe('/user/calendar')
  })

  it('deep link: the request screen is REPLACED out of history -- back from «Моя практика» skips it entirely', async () => {
    await boot()
    // Straight into the confirmation (share link / reload): nothing usable
    // behind -- not the practice screen. Start from a real entry (the memory
    // history's implicit bottom is an unmatched empty path).
    await router.push('/user/calendar')
    await router.push('/user/booking-confirmed/p1')
    await flush()

    await send('Болит колено')

    expect(router.currentRoute.value.path).toBe('/user/practices/p1')

    // One hop back -- to what preceded the request screen, never to it again.
    await router.back()
    await settle()
    expect(router.currentRoute.value.path).not.toBe('/user/booking-confirmed/p1')
    expect(router.currentRoute.value.path).toBe('/user/calendar')
  })
})
