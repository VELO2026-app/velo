// =============================================================================
// VELO Frontend -- TopupSuccessView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// The landing page Stripe returns the user to after a successful charge. Its
// entire job is to prove the money arrived: refresh the balance from the server
// and show it. A stale number here tells a user who just paid that their money
// vanished -- so the refresh, and the loader that covers it, ARE the screen.
//
// PATTERN A (store-backed) with a local `loading` ref for the refresh window.
// useBalanceStore is REAL; it derives from useAuthStore (stores/balance.ts:25),
// so the seam is @/stores/auth, mocked wholesale behind getters (velo-idiom §5).
// Mocking @/stores/balance would delete the computation under test.
//
// vue-router is mocked, never built (velo-idiom §6).
// No time pinning needed -- this screen reads no clock.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import TopupSuccessView from '@/views/user/TopupSuccessView.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

const authState: { user: { balance_cents: number } | null } = { user: null }
const fetchMe = vi.fn()
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
    fetchMe,
  }),
}))

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TopupSuccessView)
  app.use(pinia)
  app.mount(host)
  return host
}

// FIVE ticks, not the usual three (velo-idiom §3). This screen awaits one hop
// DEEPER than MyBookingsView: onMounted awaits balanceStore.refresh(), which
// itself awaits authStore.fetchMe() (stores/balance.ts:51-53), and only then
// does `loading.value = false` run and trigger the re-render that drops the
// loader. At three ticks the loader is still up and every content assertion
// fails while the screen is behaving correctly -- count the awaits, do not
// copy the number.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  authState.user = { balance_cents: 0 }
  fetchMe.mockReset().mockResolvedValue(undefined)
  push.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('TopupSuccessView', () => {
  it('refreshes the balance from the server on mount', async () => {
    // The user is arriving from Stripe; the cached balance predates the charge.
    mount()
    await flush()

    expect(fetchMe).toHaveBeenCalledTimes(1)
  })

  it('shows the loader -- not a stale balance -- while the refresh is in flight', async () => {
    // TopupSuccessView.vue:16-18: v-if="loading" swaps the number for a spinner.
    // Painting the pre-charge balance for even a frame reads as "your money is
    // gone" on the one screen that must not say that.
    fetchMe.mockReturnValue(new Promise(() => {}))
    authState.user = { balance_cents: 500 }
    mount()
    await flush()

    expect(host?.querySelector('.topup-result__balance .v-loader')).not.toBeNull()
    expect(text()).not.toContain('5,00')
  })

  it('renders the refreshed balance once the fetch lands', async () => {
    fetchMe.mockImplementation(async () => {
      authState.user = { balance_cents: 2500 }
    })
    authState.user = { balance_cents: 500 }
    mount()
    await flush()

    expect(text()).toContain('25,00')
    expect(text()).toContain('Баланс пополнен!')
    expect(host?.querySelector('.topup-result__balance .v-loader')).toBeNull()
  })

  it('a zero balance renders as money, not «Бесплатно»', async () => {
    // stores/balance.ts:34-36 passes allowZero=true; formatMoney's default
    // would print «Бесплатно» for 0 (utils/format.ts:33).
    mount()
    await flush()

    expect(text()).toContain('0,00')
    expect(text()).not.toContain('Бесплатно')
  })

  describe('navigation', () => {
    it('«На главную» goes to the user dashboard', async () => {
      mount()
      await flush()

      button('На главную')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('«Пополнить ещё» goes back to the topup form', async () => {
      mount()
      await flush()

      button('Пополнить ещё')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-topup' })
    })
  })
})
