// =============================================================================
// VELO Frontend -- UserMasterInviteView Screen Tests (invite screens)
// =============================================================================
//
// The page's whole contract while the invite is still the inbox simulation:
// render the invitation card (heading + text, no school card — there is no
// payload to fill one with) and hand «Принять» off to the apply wizard,
// the same hand-off the one-time claim flow uses. Nothing else may happen:
// no API call, no toast — no server state exists yet.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserMasterInviteView from '@/views/user/UserMasterInviteView.vue'

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push, back, replace: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserMasterInviteView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find((b) =>
    b.textContent?.trim().includes(label),
  )
}

beforeEach(() => {
  push.mockReset()
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('UserMasterInviteView', () => {
  it('renders the invitation card: heading, text, and the single CTA', async () => {
    mount()
    await flush()

    expect(text()).toContain('Вас приглашают стать мастером')
    expect(text()).toContain('Принять')
  })

  it("«Принять» hands off to the apply wizard — the claim flow's hand-off", async () => {
    mount()
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'master-apply' })
  })
})
