// FE-261: the language a signed-out device starts in. One test per rule of
// pickBrowserLocale -- the pure part; signedOutLocale.test.ts pins what the
// app does with the answer.
import { describe, expect, it } from 'vitest'

import { pickBrowserLocale } from '@/locales/browserLocale'
import type { Locale } from '@/platform/instance'

const GOODO: readonly Locale[] = ['uk', 'ru', 'en']

describe('pickBrowserLocale', () => {
  it('takes the browser language the instance offers, region ignored', () => {
    expect(pickBrowserLocale(['en-US'], GOODO, 'uk')).toBe('en')
    expect(pickBrowserLocale(['uk-UA'], GOODO, 'ru')).toBe('uk')
  })

  it('reads case and a `_` separator the same way', () => {
    expect(pickBrowserLocale(['EN_gb'], GOODO, 'uk')).toBe('en')
  })

  it('falls back to the instance default when the browser language is not offered', () => {
    expect(pickBrowserLocale(['de-DE'], GOODO, 'uk')).toBe('uk')
  })

  it('does not take a language the product has but the instance does not offer', () => {
    expect(pickBrowserLocale(['ru-RU'], ['uk', 'en'], 'uk')).toBe('uk')
  })

  it('takes the first offered language of the list, not the first entry', () => {
    expect(pickBrowserLocale(['de-DE', 'en-US', 'ru'], GOODO, 'uk')).toBe('en')
  })

  it('falls back to the instance default when the browser lists nothing', () => {
    expect(pickBrowserLocale([], GOODO, 'uk')).toBe('uk')
    expect(pickBrowserLocale([''], GOODO, 'uk')).toBe('uk')
  })
})
