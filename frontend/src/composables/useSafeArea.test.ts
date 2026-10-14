// =============================================================================
// VELO Frontend -- useSafeArea tests (BE-149)
// =============================================================================
//
// Pins WHICH top clearance each platform gets:
//   standalone -> env(safe-area-inset-top, 0px)  (installed app / browser)
//   telegram   -> the device-tuned SDK formula in px, unchanged by BE-149,
//                 and 0px when the viewport never mounted (older clients) --
//                 NOT env(): the branch is by platform, not by "mounted".
//
// The SDK is module-mocked: each viewport signal is a Vue ref and useSignal
// hands it straight back, so the tests drive the same reactivity the real
// useSignal provides. Standalone is only tested with an unmounted viewport --
// outside Telegram the viewport never mounts (telegram-sdk.ts never inits it),
// and a test building that state by hand would document the impossible.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Ref } from 'vue'

const platformMock = vi.hoisted(() => ({ name: 'standalone' as 'telegram' | 'standalone' }))
vi.mock('@/platform', () => ({ platform: platformMock }))

vi.mock('@tma.js/sdk-vue', async () => {
  const { ref } = await import('vue')
  return {
    viewport: {
      isMounted: ref(false),
      safeAreaInsetTop: ref<number | undefined>(0),
      contentSafeAreaInsetTop: ref<number | undefined>(0),
    },
    useSignal: <T>(signal: Ref<T>): Ref<T> => signal,
  }
})

import { viewport } from '@tma.js/sdk-vue'
import { STANDALONE_SAFE_TOP, useSafeArea } from '@/composables/useSafeArea'

const vp = viewport as unknown as {
  isMounted: Ref<boolean>
  safeAreaInsetTop: Ref<number | undefined>
  contentSafeAreaInsetTop: Ref<number | undefined>
}

function setTelegramViewport(mounted: boolean, safe?: number, content?: number): void {
  vp.isMounted.value = mounted
  vp.safeAreaInsetTop.value = safe
  vp.contentSafeAreaInsetTop.value = content
}

beforeEach(() => {
  platformMock.name = 'standalone'
  setTelegramViewport(false, 0, 0)
})

describe('useSafeArea -- outside Telegram', () => {
  it('standalone -> the system inset, as a CSS env() length', () => {
    const { contentSafeTopCss } = useSafeArea()

    expect(STANDALONE_SAFE_TOP).toBe('env(safe-area-inset-top, 0px)')
    expect(contentSafeTopCss.value).toBe(STANDALONE_SAFE_TOP)
  })
})

describe('useSafeArea -- inside Telegram (unchanged by BE-149)', () => {
  beforeEach(() => {
    platformMock.name = 'telegram'
  })

  it('viewport never mounted (older client) -> 0px, NOT env()', () => {
    const { contentSafeTopCss } = useSafeArea()

    expect(contentSafeTopCss.value).toBe('0px')
  })

  it('fullscreen: 44 + 46 - 20 overlap -> 70px (device-verified values)', () => {
    setTelegramViewport(true, 44, 46)

    expect(useSafeArea().contentSafeTopCss.value).toBe('70px')
  })

  it('in-chat: both insets 0 -> 0px, the overlap is never subtracted into negative', () => {
    setTelegramViewport(true, 0, 0)

    expect(useSafeArea().contentSafeTopCss.value).toBe('0px')
  })

  it('a sum smaller than the overlap clamps at 0px', () => {
    setTelegramViewport(true, 10, 5)

    expect(useSafeArea().contentSafeTopCss.value).toBe('0px')
  })

  it('EMPTY signals (undefined insets on a mounted viewport) -> 0px', () => {
    setTelegramViewport(true, undefined, undefined)

    expect(useSafeArea().contentSafeTopCss.value).toBe('0px')
  })

  it('reactive: the inset arriving after first paint moves the value', () => {
    const { contentSafeTopCss } = useSafeArea()
    expect(contentSafeTopCss.value).toBe('0px')

    setTelegramViewport(true, 44, 46)

    expect(contentSafeTopCss.value).toBe('70px')
  })
})
