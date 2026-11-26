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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
    ['uk-UA', 'uk'],
  ] as const)('a %s browser gets %s when the instance offers it', async (browser, expected) => {
    const mod = await boot(GOODO, [browser])
    await mod.setBootLocale()
    expect(mod.getLocale()).toBe(expected)
    expect(mod.t('auth.tagline1')).toBe(TAGLINE[expected])
  })

  it('gold: a uk browser gets uk, an unoffered one gets the ru default', async () => {
    const uk = await boot(GOLD, ['uk-UA'])
    await uk.setBootLocale()
    expect(uk.t('auth.tagline1')).toBe(TAGLINE.uk)

    const de = await boot(GOLD, ['de-DE'])
    await de.setBootLocale()
    expect(de.getLocale()).toBe('ru')
    expect(de.t('auth.tagline1')).toBe(TAGLINE.ru)
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

describe('after sign-out', () => {
  it('returns to the browser language and leaves no hint behind', async () => {
    const mod = await boot(GOODO, ['en-US'])
    await mod.setLocale('ru')
    expect(localStorage.getItem(HINT_KEY)).toBe('ru')

    // What App.vue does when the user record goes away.
    mod.clearLocaleHint()
    await mod.setSignedOutLocale()

    expect(mod.getLocale()).toBe('en')
    expect(localStorage.getItem(HINT_KEY)).toBeNull()
  })
})
