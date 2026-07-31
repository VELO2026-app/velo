// =============================================================================
// VELO Frontend -- TopupCancelView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// Where Stripe drops the user who backed out of checkout. Pure presentation +
// two router pushes -- no store, no API, no onMounted, no computed. It scores
// LOW on the probekit-screen-test ranking (+4 money path, -3 pure presentation)
// and is covered only because it sits on the money path and costs ~20 lines.
// The honest value here is the two routes and the "your balance did not change"
// promise; do not read more into it than that.
//
// vue-router mocked, never built (velo-idiom §6). No pinia -- this screen takes
// no store, so wiring one would mock a layer it does not have.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import TopupCancelView from '@/views/user/TopupCancelView.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TopupCancelView)
  app.mount(host)
  return host
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
  push.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('TopupCancelView', () => {
  it('tells the user the payment was cancelled and the balance is untouched', () => {
    // The one thing this screen owes a user who just abandoned a payment: an
    // unambiguous "no money moved".
    mount()

    expect(text()).toContain('Оплата отменена')
    expect(text()).toContain('Ваш баланс не изменился')
  })

  it('«Попробовать снова» returns to the topup form, NOT to a fresh checkout', () => {
    // Routing straight back into a payment attempt from a cancel screen would
    // trap a user who is trying to leave.
    mount()

    button('Попробовать снова')?.click()

    expect(push).toHaveBeenCalledWith({ name: 'user-topup' })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('«На главную» goes to the user dashboard', async () => {
    mount()

    button('На главную')?.click()
    await nextTick()

    expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
  })
})
