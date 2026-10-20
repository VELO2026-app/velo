// tz-i18n phase 5: the boot-locale hint contract -- setLocale persists the
// last CHOSEN locale, readLocaleHint/clearLocaleHint round-trip it, and the
// app applies the hint BEFORE mount (app.ts) so a reopen renders in the
// chosen locale instead of flashing the default for the auth round-trip.
import { describe, expect, it, afterEach } from 'vitest'
import { setLocale, readLocaleHint, clearLocaleHint, getLocale } from '@/locales'

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
