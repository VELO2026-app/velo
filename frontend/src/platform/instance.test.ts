// =============================================================================
// VELO Frontend -- Instance Passport tests (tz-whitelabel §1, F1)
// =============================================================================
// The ONE place that reads instance-level VITE_* values. Every seam carries
// today's behavior as its default, so this suite pins the golden contract:
// a build without a passport is indistinguishable from the app as it ships.
//
// brand/defaultLocale/locales/features are a module-eval snapshot (i18n and
// the manifest read them once), so env variants are exercised through
// resetModules + re-import. apiBaseUrl/telegramBotUrl are deliberate GETTERS:
// the read stays live, which keeps per-mount semantics for views and lets
// vi.stubEnv work after import -- the third block pins exactly that.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadInstance(): Promise<typeof import('@/platform/instance')> {
  vi.resetModules()
  return await import('@/platform/instance')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('INSTANCE -- golden defaults (a passport-less build is the golden build)', () => {
  it('every seam falls back to the shipped behavior', async () => {
    for (const name of [
      'VITE_API_BASE_URL',
      'VITE_TELEGRAM_BOT_URL',
      'VITE_BRAND',
      'VITE_DEFAULT_LOCALE',
      'VITE_LOCALES',
      'VITE_FEATURES',
    ]) {
      vi.stubEnv(name, undefined)
    }
    const { INSTANCE } = await loadInstance()

    expect(INSTANCE.apiBaseUrl).toBe('')
    expect(INSTANCE.telegramBotUrl).toBe('https://telegram.me/veloappbot')
    expect(INSTANCE.brand).toBe('VELO')
    expect(INSTANCE.defaultLocale).toBe('ru')
    expect(INSTANCE.locales).toEqual(['ru'])
    expect(INSTANCE.features).toEqual({ all: true })
  })
})

describe('INSTANCE -- locale parsing (tz-i18n 0.5)', () => {
  it('an unsupported default locale falls back to ru', async () => {
    vi.stubEnv('VITE_DEFAULT_LOCALE', 'xx')
    const { INSTANCE, isSupportedLocale } = await loadInstance()

    expect(INSTANCE.defaultLocale).toBe('ru')
    expect(isSupportedLocale('en')).toBe(true)
    expect(isSupportedLocale('xx')).toBe(false)
  })

  it('the locale set keeps only known locales, in the requested order', async () => {
    vi.stubEnv('VITE_LOCALES', 'en, ru, xx')
    const { INSTANCE } = await loadInstance()

    expect(INSTANCE.locales).toEqual(['en', 'ru'])
  })

  it('a locale set with nothing known collapses to ru', async () => {
    vi.stubEnv('VITE_LOCALES', 'xx,yy')
    const { INSTANCE } = await loadInstance()

    expect(INSTANCE.locales).toEqual(['ru'])
  })
})

describe('INSTANCE -- feature registry (tz-whitelabel §4, F3 consumes this)', () => {
  it("absent, empty and 'full' mean everything", async () => {
    vi.stubEnv('VITE_FEATURES', 'full')
    const { INSTANCE, hasFeature } = await loadInstance()

    expect(hasFeature(INSTANCE.features, 'payments')).toBe(true)
    expect(hasFeature(INSTANCE.features, 'anything-unheard-of')).toBe(true)
  })

  it('a comma list enables exactly the named modules; unknown names never match', async () => {
    vi.stubEnv('VITE_FEATURES', 'payments,ai')
    const { INSTANCE, hasFeature } = await loadInstance()

    expect(INSTANCE.features).toEqual({
      all: false,
      enabled: new Set(['payments', 'ai']),
    })
    expect(hasFeature(INSTANCE.features, 'payments')).toBe(true)
    expect(hasFeature(INSTANCE.features, 'ai')).toBe(true)
    expect(hasFeature(INSTANCE.features, 'diary')).toBe(false)
  })
})

describe('INSTANCE -- the URL seams read live (getter contract)', () => {
  // These two keep the per-mount read the former inline import.meta.env reads
  // had: stubbing AFTER the module is imported must still be visible.
  it('apiBaseUrl follows the env at access time', async () => {
    const { INSTANCE } = await loadInstance()

    expect(INSTANCE.apiBaseUrl).toBe('')

    vi.stubEnv('VITE_API_BASE_URL', 'https://velo-backend.test')
    expect(INSTANCE.apiBaseUrl).toBe('https://velo-backend.test')

    vi.stubEnv('VITE_API_BASE_URL', '')
    expect(INSTANCE.apiBaseUrl).toBe('')
  })

  it('telegramBotUrl falls back to the bot when the build has none', async () => {
    const { INSTANCE } = await loadInstance()

    vi.stubEnv('VITE_TELEGRAM_BOT_URL', 'https://t.me/schoolbot')
    expect(INSTANCE.telegramBotUrl).toBe('https://t.me/schoolbot')

    vi.stubEnv('VITE_TELEGRAM_BOT_URL', '')
    expect(INSTANCE.telegramBotUrl).toBe('https://telegram.me/veloappbot')
  })
})
