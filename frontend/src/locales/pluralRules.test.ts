// tz-i18n: the plural-mechanism contract tests.
//
// utils/plural.ts (the hand-rolled mod-10/100 ru pluralizer) is gone --
// ONE mechanism remains (tz-i18n §4.4): CLDR pipe-forms in the catalog,
// chosen by cldrPluralChoice (Intl.PluralRules) wired as pluralRules in
// src/locales/index.ts. These tests pin the boundary cases the deleted
// helper used to cover (0 / 1 / 2 / 5 / 11 / 21 / 101) plus the
// locale-correct behavior for a 2-form (en) message.
import { describe, expect, it } from 'vitest'
import { cldrPluralChoice } from '@/locales/index'
import { createI18n } from 'vue-i18n'

const ruChoice = cldrPluralChoice('ru')
const idx3 = (n: number) => ruChoice(n, 3)

describe('cldrPluralChoice ru (3-form messages)', () => {
  it('one: 1, 21, 101', () => {
    expect(idx3(1)).toBe(0)
    expect(idx3(21)).toBe(0)
    expect(idx3(101)).toBe(0)
  })
  it('few: 2-4, 22-24', () => {
    expect(idx3(2)).toBe(1)
    expect(idx3(4)).toBe(1)
    expect(idx3(22)).toBe(1)
  })
  it('many: 0, 5-20, 11-14, 111', () => {
    expect(idx3(0)).toBe(2)
    expect(idx3(5)).toBe(2)
    expect(idx3(11)).toBe(2)
    expect(idx3(14)).toBe(2)
    expect(idx3(111)).toBe(2)
  })
})

describe('cldrPluralChoice en (2-form messages)', () => {
  const enChoice = cldrPluralChoice('en')
  it('one -> first form, everything else -> second', () => {
    expect(enChoice(1, 2)).toBe(0)
    expect(enChoice(2, 2)).toBe(1)
    expect(enChoice(0, 2)).toBe(1)
    expect(enChoice(101, 2)).toBe(1)
  })
})

describe('pipe messages render the agreed form end-to-end', () => {
  const i18n = createI18n({
    legacy: false,
    locale: 'ru',
    pluralRules: { ru: cldrPluralChoice('ru') },
    missingWarn: false,
    fallbackWarn: false,
    messages: {
      ru: { k: '{n} участник | {n} участника | {n} участников' },
    },
  })
  const t = i18n.global.t
  it.each([
    [1, '1 участник'],
    [2, '2 участника'],
    [5, '5 участников'],
    [11, '11 участников'],
    [21, '21 участник'],
    [101, '101 участник'],
  ])('%i -> %s', (n, expected) => {
    expect(t('k', n)).toBe(expected)
  })
})
