// =============================================================================
// VELO Frontend -- telegram-sdk bootstrap tests
// =============================================================================
//
// Outside Telegram the SDK chunk is never requested; inside it is loaded
// lazily, init + viewport mount run, and a chunk that fails to load leaves the
// app running (safe-area at 0) with the gate released and a later start able
// to retry. The lazy seam (tma-viewport) is mocked.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadTmaSdk = vi.fn()
vi.mock('@/platform/tma-viewport', () => ({ loadTmaSdk: () => loadTmaSdk() }))

function fakeSdk() {
  const viewport = {
    mount: Object.assign(vi.fn().mockResolvedValue(undefined), { isAvailable: () => true }),
    bindCssVars: Object.assign(vi.fn(), { isAvailable: () => true }),
  }
  return { init: vi.fn(), viewport }
}

function setTelegram(initData: string | undefined): void {
  ;(window as unknown as { Telegram?: unknown }).Telegram = initData
    ? { WebApp: { initData } }
    : undefined
}

beforeEach(() => {
  vi.resetModules()
  loadTmaSdk.mockReset()
})

afterEach(() => {
  setTelegram(undefined)
})

describe('initTelegramSdk', () => {
  it('outside Telegram: never loads the SDK chunk', async () => {
    setTelegram(undefined)
    const sdk = await import('@/platform/telegram-sdk')

    sdk.initTelegramSdk()
    await sdk.viewportSettled()

    expect(loadTmaSdk).not.toHaveBeenCalled()
    expect(sdk.isTelegramSdkReady()).toBe(false)
  })

  it('inside Telegram: loads lazily, inits, mounts the viewport and binds CSS vars', async () => {
    setTelegram('query_id=1')
    const fake = fakeSdk()
    loadTmaSdk.mockResolvedValue(fake)
    const sdk = await import('@/platform/telegram-sdk')

    sdk.initTelegramSdk()
    await sdk.viewportSettled()

    expect(loadTmaSdk).toHaveBeenCalledTimes(1)
    expect(fake.init).toHaveBeenCalledTimes(1)
    expect(fake.viewport.mount).toHaveBeenCalledTimes(1)
    expect(fake.viewport.bindCssVars).toHaveBeenCalledTimes(1)
    expect(sdk.isTelegramSdkReady()).toBe(true)
  })

  it('a second start does not load the SDK again', async () => {
    setTelegram('query_id=1')
    loadTmaSdk.mockResolvedValue(fakeSdk())
    const sdk = await import('@/platform/telegram-sdk')

    sdk.initTelegramSdk()
    sdk.initTelegramSdk()
    await sdk.viewportSettled()

    expect(loadTmaSdk).toHaveBeenCalledTimes(1)
  })

  it('a chunk that fails to load: the gate still settles, the SDK is not ready, a later start retries', async () => {
    setTelegram('query_id=1')
    loadTmaSdk.mockRejectedValueOnce(new Error('chunk failed'))
    const sdk = await import('@/platform/telegram-sdk')

    sdk.initTelegramSdk()
    await expect(sdk.viewportSettled()).resolves.toBeUndefined()
    expect(sdk.isTelegramSdkReady()).toBe(false)

    const fake = fakeSdk()
    loadTmaSdk.mockResolvedValue(fake)
    sdk.initTelegramSdk()
    await sdk.viewportSettled()

    expect(loadTmaSdk).toHaveBeenCalledTimes(2)
    expect(fake.init).toHaveBeenCalledTimes(1)
    expect(sdk.isTelegramSdkReady()).toBe(true)
  })

  it('a viewport the client does not support does not break the start', async () => {
    setTelegram('query_id=1')
    const fake = fakeSdk()
    fake.viewport.mount.mockRejectedValue(new Error('unsupported'))
    loadTmaSdk.mockResolvedValue(fake)
    const sdk = await import('@/platform/telegram-sdk')

    sdk.initTelegramSdk()
    await expect(sdk.viewportSettled()).resolves.toBeUndefined()
    expect(sdk.isTelegramSdkReady()).toBe(true)
  })
})
