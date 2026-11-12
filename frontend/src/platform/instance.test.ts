// =============================================================================
// VELO Frontend -- Instance Passport tests (tz-whitelabel §1, F1)
// =============================================================================
// The ONE place that reads instance-level VITE_* values. Every seam carries
// today's behavior as its default, so this suite pins the golden contract:
// a build without a passport is indistinguishable from the app as it ships.
//
// Every seam is a GETTER (FE-129): the runtime config must be visible at any
// access time -- launch.ts applies it only after this module has first been
// imported -- and vi.stubEnv keeps working after import too. Env-variant
// suites still go through resetModules + re-import for clean module state.
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

describe('SUPPORTED_LOCALES -- the product locales (BE-188)', () => {
  it('is exactly ru, en, uk -- the catalogs in src/locales, the backend set', async () => {
    const { SUPPORTED_LOCALES, isSupportedLocale } = await loadInstance()

    expect([...SUPPORTED_LOCALES].sort()).toEqual(['en', 'ru', 'uk'])
    // Not product locales any more, and never were catalogs.
    expect(isSupportedLocale('de')).toBe(false)
    expect(isSupportedLocale('es')).toBe(false)
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

describe('INSTANCE -- runtime config.json (FE-129)', () => {
  it('runtime values win over the build env', async () => {
    const { INSTANCE, applyInstanceConfig } = await loadInstance()

    applyInstanceConfig({
      apiBaseUrl: 'https://api.school.example',
      telegramBotUrl: 'https://t.me/schoolbot',
      defaultLocale: 'en',
      locales: 'en,ru',
    })

    expect(INSTANCE.apiBaseUrl).toBe('https://api.school.example')
    expect(INSTANCE.telegramBotUrl).toBe('https://t.me/schoolbot')
    expect(INSTANCE.defaultLocale).toBe('en')
    expect(INSTANCE.locales).toEqual(['en', 'ru'])
  })

  it('empty runtime values fall through to the build env and golden defaults', async () => {
    const { INSTANCE, applyInstanceConfig } = await loadInstance()

    applyInstanceConfig({ apiBaseUrl: '', telegramBotUrl: '', defaultLocale: '', locales: '' })

    expect(INSTANCE.apiBaseUrl).toBe('')
    expect(INSTANCE.telegramBotUrl).toBe('https://telegram.me/veloappbot')
    expect(INSTANCE.defaultLocale).toBe('ru')
    expect(INSTANCE.locales).toEqual(['ru'])
  })

  it('a runtime defaultLocale outside the declared set falls back to ru', async () => {
    const { INSTANCE, applyInstanceConfig } = await loadInstance()

    applyInstanceConfig({ defaultLocale: 'de' })

    expect(INSTANCE.defaultLocale).toBe('ru')
  })

  it('null/undefined config resets to build env and golden', async () => {
    const { INSTANCE, applyInstanceConfig } = await loadInstance()

    applyInstanceConfig({ apiBaseUrl: 'api.school.example' })
    expect(INSTANCE.apiBaseUrl).toBe('https://api.school.example')

    applyInstanceConfig(null)
    expect(INSTANCE.apiBaseUrl).toBe('')
  })

  it('an unrendered envsubst placeholder is treated as empty', async () => {
    const { INSTANCE, applyInstanceConfig } = await loadInstance()

    // An env var absent at container start leaves `${NAME}` in /config.json.
    applyInstanceConfig({
      apiBaseUrl: '${API_BASE_URL}',
      telegramBotUrl: '${TELEGRAM_BOT_URL}',
      defaultLocale: '${DEFAULT_LANGUAGE}',
      locales: '${LANGUAGES}',
    })

    expect(INSTANCE.apiBaseUrl).toBe('')
    expect(INSTANCE.telegramBotUrl).toBe('https://telegram.me/veloappbot')
    expect(INSTANCE.defaultLocale).toBe('ru')
    expect(INSTANCE.locales).toEqual(['ru'])
  })

  it('the brand is a skin property: a runtime config never sets it (owner 09.11)', async () => {
    vi.stubEnv('VITE_BRAND', 'SKIN-BRAND')
    const { INSTANCE, applyInstanceConfig } = await loadInstance()

    // An old template could still ship the key -- it must be ignored.
    applyInstanceConfig({ brand: 'RUNTIME-BRAND' } as unknown as Parameters<
      typeof applyInstanceConfig
    >[0])

    expect(INSTANCE.brand).toBe('SKIN-BRAND')
  })
})

describe('normalizeApiBase -- two domains, the passport ships a host (owner 09.11)', () => {
  it('a bare host gets https://', async () => {
    const { normalizeApiBase } = await loadInstance()
    expect(normalizeApiBase('api.velo-test.xyz')).toBe('https://api.velo-test.xyz')
  })

  it('an explicit scheme is kept, the trailing slash dropped', async () => {
    const { normalizeApiBase } = await loadInstance()
    expect(normalizeApiBase('https://api.velo-test.xyz/')).toBe('https://api.velo-test.xyz')
    expect(normalizeApiBase('http://localhost:8000')).toBe('http://localhost:8000')
  })

  it('empty and whitespace stay same-origin', async () => {
    const { normalizeApiBase } = await loadInstance()
    expect(normalizeApiBase('')).toBe('')
    expect(normalizeApiBase('  ')).toBe('')
    expect(normalizeApiBase(undefined)).toBe('')
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

describe('isOptionEnabled -- instance options (FE-151, protocol 5.2.3)', () => {
  it('the six options of primer.yaml, in its order', async () => {
    const { OPTION_NAMES } = await loadInstance()
    expect(OPTION_NAMES).toEqual(['payments', 'schools', 'mcp', 'zoom', 'telegram', 'llm'])
  })

  it('no options block (local dev, no /config.json) is the golden build: every option on', async () => {
    const { OPTION_NAMES, applyInstanceConfig, isOptionEnabled } = await loadInstance()
    for (const name of OPTION_NAMES) expect(isOptionEnabled(name)).toBe(true)
    applyInstanceConfig({ apiBaseUrl: 'api.example.test' })
    for (const name of OPTION_NAMES) expect(isOptionEnabled(name)).toBe(true)
  })

  it("only the literal 'true' turns an option on", async () => {
    const { applyInstanceConfig, isOptionEnabled } = await loadInstance()
    applyInstanceConfig({
      options: { payments: 'true', schools: ' true ', mcp: 'false', zoom: 'TRUE', llm: '1' },
    })
    expect(isOptionEnabled('payments')).toBe(true)
    expect(isOptionEnabled('schools')).toBe(true)
    expect(isOptionEnabled('mcp')).toBe(false)
    expect(isOptionEnabled('zoom')).toBe(false)
    expect(isOptionEnabled('llm')).toBe(false)
    // Absent from the block: off.
    expect(isOptionEnabled('telegram')).toBe(false)
  })

  it('an empty value and an unrendered ${OPTION_X} (the variable unset) are off', async () => {
    const { applyInstanceConfig, isOptionEnabled } = await loadInstance()
    applyInstanceConfig({
      options: { payments: '', schools: '${OPTION_SCHOOLS}', mcp: '   ' },
    })
    expect(isOptionEnabled('payments')).toBe(false)
    expect(isOptionEnabled('schools')).toBe(false)
    expect(isOptionEnabled('mcp')).toBe(false)
  })

  it('a block of placeholders only still means "the instance decides": all off', async () => {
    const { OPTION_NAMES, applyInstanceConfig, isOptionEnabled } = await loadInstance()
    applyInstanceConfig({
      options: Object.fromEntries(OPTION_NAMES.map((n) => [n, `\${OPTION_${n.toUpperCase()}}`])),
    })
    for (const name of OPTION_NAMES) expect(isOptionEnabled(name)).toBe(false)
  })

  it('an unknown option is off, whatever the block says', async () => {
    const { applyInstanceConfig, isOptionEnabled } = await loadInstance()
    applyInstanceConfig({ options: { payments: 'true', diary: 'true' } })
    // @ts-expect-error -- an option primer.yaml does not declare
    expect(isOptionEnabled('diary')).toBe(false)
  })

  it('the switched-off literal is not a flag: off, and never a value of any seam', async () => {
    const { applyInstanceConfig, isOptionEnabled } = await loadInstance()
    applyInstanceConfig({ options: { payments: 'primer-switched-off' } })
    expect(isOptionEnabled('payments')).toBe(false)
  })

  it('a malformed options block (not an object) is ignored -- golden', async () => {
    const { applyInstanceConfig, isOptionEnabled } = await loadInstance()
    applyInstanceConfig({ options: 'payments' } as never)
    expect(isOptionEnabled('payments')).toBe(true)
    applyInstanceConfig({ options: ['payments'] } as never)
    expect(isOptionEnabled('payments')).toBe(true)
  })

  it('options never leak into the other seams', async () => {
    const { INSTANCE, applyInstanceConfig } = await loadInstance()
    vi.stubEnv('VITE_API_BASE_URL', undefined)
    applyInstanceConfig({ options: { payments: 'true' } })
    expect(INSTANCE.apiBaseUrl).toBe('')
  })
})
