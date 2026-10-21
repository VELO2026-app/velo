// tz-i18n phase 5: the boot-locale hint contract -- setLocale persists the
// last CHOSEN locale, readLocaleHint/clearLocaleHint round-trip it, and the
// app applies the hint BEFORE mount (app.ts) so a reopen renders in the
// chosen locale instead of flashing the default for the auth round-trip.
// loadLocale (the App.vue idle prefetch) must warm catalogs WITHOUT
// switching or writing the hint -- the "reverts to English by itself"
// regression: a prefetch built on setLocale left every mount on the LAST
// available locale (en) and rewrote the hint to match.
import { describe, expect, it, afterEach } from 'vitest'
import i18n from '@/locales'
import {
  setLocale,
  loadLocale,
  availableLocales,
  readLocaleHint,
  clearLocaleHint,
  getLocale,
} from '@/locales'

afterEach(async () => {
  clearLocaleHint()
  await setLocale('ru')
})

describe('locale boot hint', () => {
  it('setLocale persists the chosen locale as the hint', async () => {
    await setLocale('en')
    expect(getLocale()).toBe('en')
    expect(readLocaleHint()).toBe('en')
  })

  it('clearLocaleHint wipes it (the logout path)', () => {
    clearLocaleHint()
    expect(readLocaleHint()).toBeNull()
  })

  it('the hint survives a locale reset round-trip (reopen simulation)', async () => {
    await setLocale('en')
    expect(readLocaleHint()).toBe('en')
    await setLocale('ru')
    expect(readLocaleHint()).toBe('ru')
  })
})

describe('catalog prefetch (the App.vue idle warm-up loop)', () => {
  it('loadLocale warms every available locale without switching or writing the hint', async () => {
    clearLocaleHint()
    const active = getLocale()
    // The exact App.vue loop. On the setLocale-based prefetch this ended on
    // 'en' (the last entry of availableLocales()) with the hint rewritten.
    for (const locale of availableLocales()) await loadLocale(locale)
    expect(getLocale()).toBe(active)
    expect(readLocaleHint()).toBeNull()
  })

  it('a warmed locale still switches normally afterwards', async () => {
    for (const locale of availableLocales()) await loadLocale(locale)
    await setLocale('en')
    expect(getLocale()).toBe('en')
    expect(readLocaleHint()).toBe('en')
  })
})

describe('brand link (the @:brand key every locale must carry)', () => {
  it('a lazily loaded locale renders @:brand messages with the brand word', async () => {
    await setLocale('en')
    // auth.sameAccount links @:brand inside its text; linked keys do NOT
    // fall back across locales, so a locale without the merged brand key
    // renders an empty word ("The same account as the  app").
    const rendered = i18n.global.t('auth.sameAccount')
    expect(rendered).toContain('VELO')
    await setLocale('ru')
    expect(i18n.global.t('auth.sameAccount')).toContain('VELO')
  })
})
