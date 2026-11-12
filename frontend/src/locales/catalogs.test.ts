// FE-157: what the i18n singleton holds when. The ru core is eager; the
// zone catalogs (ZONE_CATALOGS) arrive only through ensureCatalogs; the
// timezones seed is never a message catalog; the brand and instance
// overlays are message functions that survive every later load -- also
// with the message compiler dropped, as in the production bundle.
//
// test-setup.ts preloads every zone catalog into the shared singleton, so
// each test here works on a FRESH module instance (vi.resetModules).
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { compileMessage } from '@/locales/messageFunction'

type LocalesModule = typeof import('@/locales')
type Tree = Record<string, unknown>

async function fresh(): Promise<LocalesModule> {
  vi.resetModules()
  return import('@/locales')
}

const ruFiles = import.meta.glob<Tree>('./ru/*.json', { eager: true, import: 'default' })
const rootsOf = (file: string): string[] => Object.keys(ruFiles[`./ru/${file}.json`] ?? {})
const heldRoots = (mod: LocalesModule, locale: string): string[] =>
  Object.keys(mod.default.global.getLocaleMessage(locale))

// The production bundle has no message compiler (vite.config.ts,
// dropMessageCompiler); the unit suite does. core-base reads this global at
// every compile, so flipping it makes the suite's composer behave like the
// bundle's: a string message then renders as raw text.
type DropFlag = { __INTLIFY_DROP_MESSAGE_COMPILER__?: boolean }
function withoutCompiler<T>(run: () => T): T {
  const flag = globalThis as DropFlag
  const before = flag.__INTLIFY_DROP_MESSAGE_COMPILER__
  flag.__INTLIFY_DROP_MESSAGE_COMPILER__ = true
  try {
    return run()
  } finally {
    flag.__INTLIFY_DROP_MESSAGE_COMPILER__ = before
  }
}

afterEach(() => {
  localStorage.clear()
  vi.doUnmock('virtual:skin-brand')
})

describe('catalog split', () => {
  it('ru starts with its core only: no zone catalog, no timezones seed', async () => {
    const mod = await fresh()
    const held = heldRoots(mod, 'ru')
    const lazyFiles = [...mod.ZONE_CATALOGS, 'timezones'] as string[]
    const coreFiles = Object.keys(ruFiles)
      .map((path) => path.slice('./ru/'.length, -'.json'.length))
      .filter((file) => !lazyFiles.includes(file))
    expect(coreFiles.length).toBeGreaterThan(10)
    for (const file of coreFiles) expect(held, file).toEqual(expect.arrayContaining(rootsOf(file)))
    for (const zone of mod.ZONE_CATALOGS) {
      for (const root of rootsOf(zone)) expect(held, `${zone}: ${root}`).not.toContain(root)
    }
    for (const root of rootsOf('timezones')) expect(held).not.toContain(root)
  })

  it('ensureCatalogs merges exactly the zones asked for; timezones never arrive', async () => {
    const mod = await fresh()
    await mod.ensureCatalogs(['master'])
    let held = heldRoots(mod, 'ru')
    expect(held).toEqual(expect.arrayContaining(rootsOf('master')))
    for (const root of rootsOf('admin')) expect(held).not.toContain(root)

    await mod.ensureCatalogs(mod.ZONE_CATALOGS)
    held = heldRoots(mod, 'ru')
    expect(held).toEqual(expect.arrayContaining([...rootsOf('master'), ...rootsOf('admin')]))
    for (const root of rootsOf('timezones')) expect(held).not.toContain(root)
  })

  it('a zone loads for the active and the fallback locale, and follows a later switch', async () => {
    const mod = await fresh()
    const key = 'masterScreens.masterOnboarding.welcome.text'
    const { te } = mod.default.global
    await mod.setLocale('en')
    expect(te(key, 'en')).toBe(false)

    await mod.ensureCatalogs(['master'])
    expect(te(key, 'en')).toBe(true)
    // ru is the fallback locale: a key the en catalog lacks falls back there.
    expect(te(key, 'ru')).toBe(true)
    // te() is true for message leaves only -- these keys are leaves.
    expect(te('moderation.category', 'en')).toBe(false)

    await mod.setLocale('uk')
    expect(te(key, 'uk')).toBe(true)
    expect(te('moderation.category', 'uk')).toBe(false)
  })

  it('a zone asked for during a switch is in the new locale when it flips', async () => {
    const mod = await fresh()
    const switching = mod.setLocale('en')
    await mod.ensureCatalogs(['admin'])
    await switching
    expect(mod.getLocale()).toBe('en')
    expect(mod.default.global.te('moderation.category', 'en')).toBe(true)
  })
})

describe('brand (a message function)', () => {
  it.each(['ru', 'en', 'uk'])('renders in %s: core and zone messages link it', async (locale) => {
    const mod = await fresh()
    await mod.setLocale(locale)
    await mod.ensureCatalogs(['master'])
    expect(mod.getLocale()).toBe(locale)
    expect(mod.t('common.brandName')).toBe('VELO')
    expect(mod.t('chat.supportTitle')).toContain('VELO')
    expect(mod.t('masterScreens.masterOnboarding.welcome.text')).toContain('VELO')
  })

  it.each(['ru', 'en', 'uk'])('renders in %s without a compiler', async (locale) => {
    const mod = await fresh()
    await mod.setLocale(locale)
    // The suite's catalogs are strings (no build step); a message function
    // stands in for a precompiled catalog message that links the brand.
    mod.default.global.mergeLocaleMessage(locale, { probe: compileMessage('Support @:brand') })
    withoutCompiler(() => {
      expect(mod.t('brand')).toBe('VELO')
      expect(mod.t('probe')).toBe('Support VELO')
    })
  })

  it('renders a skin brand verbatim, message syntax and all', async () => {
    vi.doMock('virtual:skin-brand', () => ({ SKIN_BRAND: 'Yoga | {Life} @home' }))
    const mod = await fresh()
    expect(mod.t('common.brandName')).toBe('Yoga | {Life} @home')
    expect(mod.t('chat.supportTitle')).toContain('Yoga | {Life} @home')
  })
})

describe('instance overlays (applyInstanceOverrides)', () => {
  it('render with placeholders and plurals without a compiler', async () => {
    const mod = await fresh()
    mod.applyInstanceOverrides({ ru: { common: { skip: 'Later, {name}' } } })
    withoutCompiler(() => {
      expect(mod.t('common.skip', { name: 'Olga' })).toBe('Later, Olga')
      // The contrast: a raw string message stays raw without a compiler.
      mod.default.global.mergeLocaleMessage('ru', { common: { skip: 'Later, {name}' } })
      expect(mod.t('common.skip', { name: 'Olga' })).toBe('Later, {name}')
    })
  })

  it('survive a later zone load of the same locale', async () => {
    const mod = await fresh()
    const key = 'masterScreens.analytics.morePractices'
    mod.applyInstanceOverrides({
      ru: {
        masterScreens: {
          analytics: { morePractices: '{count} class | {count} classes | {count} lots' },
        },
      },
    })
    await mod.ensureCatalogs(['master'])
    withoutCompiler(() => {
      expect(mod.t(key, { count: 1 }, 1)).toBe('1 class')
      expect(mod.t(key, { count: 5 }, 5)).toBe('5 lots')
    })
    // The rest of the zone catalog is intact around the overlay.
    expect(mod.t('masterScreens.masterOnboarding.welcome.text')).toContain('VELO')
  })

  it('wait for a locale that is not loaded yet, then win over its catalog', async () => {
    const mod = await fresh()
    mod.applyInstanceOverrides({ en: { common: { skip: 'Not now' } } })
    // ru is untouched by an en overlay.
    expect(mod.t('common.skip')).not.toBe('Not now')
    await mod.setLocale('en')
    withoutCompiler(() => expect(mod.t('common.skip')).toBe('Not now'))
  })
})

// FE-167: vite.config.ts folds the en/uk core files into one chunk per
// locale; its regex excludes the zone files by hand. A zone added to
// ZONE_CATALOGS but not to that regex would ship in every en/uk core chunk.
describe('locale chunk regex (vite.config.ts)', () => {
  it('excludes every zone catalog', async () => {
    const { ZONE_CATALOGS } = await fresh()
    const config = readFileSync('vite.config.ts', 'utf8')
    const line = config.split('\n').find((l) => l.includes('(?!master'))
    expect(line).toBeDefined()
    for (const zone of ZONE_CATALOGS) expect(line).toContain(`${zone}\\.json`)
  })
})
