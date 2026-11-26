// =============================================================================
// VELO Frontend -- useOverlayBackButton (FE-233, the tail of package 2)
// =============================================================================
//
// While an overlay is open the native Back button is up, and a tap on it
// closes the top overlay. Real kit overlays; the platform is the boundary and
// is mocked: its `showBackButton` keeps the handler the host would call.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { VModal } from '@/components/ui'
import { useOverlayBackButton } from '@/composables/useOverlayBackButton'

const platform = vi.hoisted(() => ({ showBackButton: vi.fn(), hideBackButton: vi.fn() }))
vi.mock('@/platform', () => ({ platform }))

let app: App | null = null
let host: HTMLElement | null = null
const first = ref(false)
const second = ref(false)
const closed: string[] = []

/** The app root: the composable plus two modals that close when asked to. */
function mountRoot(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    setup() {
      useOverlayBackButton()
      return () => [
        h(VModal, {
          open: first.value,
          onClose: () => {
            closed.push('first')
            first.value = false
          },
        }),
        h(VModal, {
          open: second.value,
          onClose: () => {
            closed.push('second')
            second.value = false
          },
        }),
      ]
    },
  }).use(createTestI18n())
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

/** What the Telegram host does when the person taps Back. */
function tapBack(): void {
  const handler = platform.showBackButton.mock.calls[0]?.[0] as (() => void) | undefined
  if (!handler) throw new Error('the Back button was never shown')
  handler()
}

beforeEach(() => {
  platform.showBackButton.mockReset()
  platform.hideBackButton.mockReset()
  closed.length = 0
  first.value = false
  second.value = false
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
})

describe('useOverlayBackButton', () => {
  it('shows Back once while overlays are open, hides it when the last one closes', async () => {
    mountRoot()
    await flush()
    expect(platform.showBackButton).not.toHaveBeenCalled()
    expect(platform.hideBackButton).not.toHaveBeenCalled()

    first.value = true
    await flush()
    second.value = true
    await flush()
    expect(platform.showBackButton).toHaveBeenCalledTimes(1)

    second.value = false
    await flush()
    expect(platform.hideBackButton).not.toHaveBeenCalled()

    first.value = false
    await flush()
    expect(platform.hideBackButton).toHaveBeenCalledTimes(1)
  })

  it('a tap on Back closes the top overlay only', async () => {
    mountRoot()
    first.value = true
    await flush()
    second.value = true
    await flush()

    tapBack()
    await flush()

    expect(closed).toEqual(['second'])
    expect(first.value).toBe(true)
  })

  it('the root going away takes the button down with it', async () => {
    mountRoot()
    first.value = true
    await flush()

    app?.unmount()
    app = null

    expect(platform.hideBackButton).toHaveBeenCalledTimes(1)
  })
})
