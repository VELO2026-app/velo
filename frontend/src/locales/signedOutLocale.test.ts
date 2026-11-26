// FE-261: before sign-in the app speaks the browser's language when the
// instance offers it, and the instance's default language when it does not.
// The Goodo bug this pins: a uk-default instance rendered its signed-out
// screen in Russian under `<html lang="uk">` -- nothing loaded the uk catalog,
// so the default locale stayed on its ru placeholder.
//
// Each test boots a FRESH module (vi.resetModules): the instance values and
// the i18n singleton are read at module load.
import { afterEach, describe, expect, it, vi } from 'vitest'

import enAuth from '@/locales/en/auth.json'
import ruAuth from '@/locales/ru/auth.json'
import ukAuth from '@/locales/uk/auth.json'

type LocalesModule = typeof import('@/locales')

const TAGLINE = { ru: ruAuth.auth.tagline1, uk: ukAuth.auth.tagline1, en: enAuth.auth.tagline1 }
const HINT_KEY = 'velo.locale'

/** The instance the app boots as: its default, its languages, the browser's list. */
async function boot(
  instance: { defaultLocale: string; locales: string },
  browserLanguages: string[],
  browserLanguage = browserLanguages[0] ?? '',
): Promise<LocalesModule> {
  vi.resetModules()
  vi.stubEnv('VITE_DEFAULT_LOCALE', instance.defaultLocale)
  vi.stubEnv('VITE_LOCALES', instance.locales)
  vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(browserLanguages)
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(browserLanguage)
  return import('@/locales')
}

const GOODO = { defaultLocale: 'uk', locales: 'uk,ru,en' }
const GOLD = { defaultLocale: 'ru', locales: 'ru,en,uk' }

/** Launch the page as Telegram does: initDataUnsafe carries the person's language_code. */
function launchedByTelegram(languageCode: string): void {
  Object.defineProperty(window, 'Telegram', {
    configurable: true,
    value: {
      WebApp: { initDataUnsafe: { user: { id: 1, first_name: 'A', language_code: languageCode } } },
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.doUnmock('@/locales/en/auth.json')
  Reflect.deleteProperty(window, 'Telegram')
  localStorage.clear()
  document.documentElement.lang = ''
})

describe('the first render before sign-in', () => {
  it('a uk instance shows uk text, not its ru placeholder, for a browser it does not offer', async () => {
    const mod = await boot(GOODO, ['de-DE'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('uk')
    expect(mod.t('auth.tagline1')).toBe(TAGLINE.uk)
  })

  it.each([
    ['en-US', 'en'],
    ['ru-RU', 'ru'],
  ] as const)('a %s browser gets %s when the instance offers it', async (browser, expected) => {
    const mod = await boot(GOODO, [browser])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe(expected)
    expect(mod.t('auth.tagline1')).toBe(TAGLINE[expected])
  })

  it('a uk browser gets uk on an instance whose default is ru', async () => {
    const mod = await boot(GOLD, ['uk-UA'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('uk')
    expect(mod.t('auth.tagline1')).toBe(TAGLINE.uk)
  })

  it('a browser the instance does not offer gets the ru default', async () => {
    const mod = await boot(GOLD, ['de-DE'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('ru')
    expect(mod.t('auth.tagline1')).toBe(TAGLINE.ru)
  })

  it('a browser that reports no language list is read by its one language', async () => {
    const mod = await boot(GOODO, [], 'en-US')
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('en')
  })

  it('a language the browser guessed is not remembered as a choice', async () => {
    const mod = await boot(GOODO, ['en-US'])
    await mod.setBootLocale()
    expect(localStorage.getItem(HINT_KEY)).toBeNull()
  })

  it('the language the person chose last wins over the browser', async () => {
    localStorage.setItem(HINT_KEY, 'ru')
    const mod = await boot(GOODO, ['en-US'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('ru')
  })

  it('a hint that is not a product language is ignored', async () => {
    localStorage.setItem(HINT_KEY, 'xx')
    const mod = await boot(GOODO, ['en-US'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('en')
  })
})

describe('inside Telegram', () => {
  it("Telegram's language_code comes before the browser's language", async () => {
    launchedByTelegram('en')
    const mod = await boot(GOODO, ['ru-RU'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('en')
  })

  it("a language_code the instance does not offer leaves the choice to the browser's language", async () => {
    launchedByTelegram('de')
    const mod = await boot(GOODO, ['ru-RU'])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe('ru')
  })
})

describe('a switch that is overtaken', () => {
  it('a signed-out switch that finishes after the profile language was set does not overwrite it', async () => {
    const mod = await boot(GOODO, ['en-US'])
    // The browser's catalog (en) is still loading when the user record arrives
    // with ru, which is already in the bundle.
    const signedOut = mod.setSignedOutLocale()
    await mod.setLocale('ru')
    await signedOut
    expect(mod.getLocale()).toBe('ru')
  })
})

describe('a catalog that does not load', () => {
  it('the boot still finishes, in the language the app already holds', async () => {
    vi.doMock('@/locales/en/auth.json', () => {
      throw new Error('chunk failed to load')
    })
    const mod = await boot(GOODO, ['en-US'])
    await expect(mod.setBootLocale()).resolves.toBeUndefined()
    expect(mod.getLocale()).toBe('uk')
  })
})
