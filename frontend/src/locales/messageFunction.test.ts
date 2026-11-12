// FE-157: runtime messages are message functions (the bundle has no message
// compiler). compileMessage must render exactly what the real compiler
// renders -- the unit suite still carries the compiler, so every catalog
// message of every locale is rendered both ways and compared, plus the
// syntax corners the catalogs do not happen to use.
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'

import { cldrPluralChoice } from '@/locales'
import { compileMessage, toMessageFunctions } from '@/locales/messageFunction'

type Tree = Record<string, unknown>

const files = import.meta.glob<Tree>('./*/*.json', { eager: true, import: 'default' })

function catalogOf(locale: string): Tree {
  const out: Tree = {}
  for (const [path, tree] of Object.entries(files)) {
    if (path.startsWith(`./${locale}/`) && !path.endsWith('/timezones.json')) {
      Object.assign(out, tree)
    }
  }
  return out
}

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') return key === '_comment' ? [] : [[path, value]]
    return value && typeof value === 'object' ? leaves(value as Tree, path) : []
  })
}

/** Two composers over the same messages: compiled strings vs functions. */
function pair(locale: string, messages: Tree) {
  const options = {
    legacy: false as const,
    locale,
    pluralRules: { [locale]: cldrPluralChoice(locale) },
    missingWarn: false,
    fallbackWarn: false,
    warnHtmlMessage: false,
  }
  const real = createI18n({ ...options, messages: { [locale]: { ...messages, brand: 'VELO' } } })
  const fn = createI18n({
    ...options,
    messages: { [locale]: { ...toMessageFunctions(messages), brand: () => 'VELO' } },
  })
  return { real: real.global, fn: fn.global }
}

/** Named values for every `{name}` of the source, rendered recognizably. */
function namedFor(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/\{\s*([A-Za-z_][\w$-]*)\s*\}/g)].map((m) => [m[1], `<${m[1]}>`]),
  )
}

describe('compileMessage renders every catalog message as the compiler does', () => {
  it.each(['ru', 'en', 'uk'])('%s catalogs', (locale) => {
    const catalog = catalogOf(locale)
    const { real, fn } = pair(locale, catalog)
    const all = leaves(catalog)
    expect(all.length).toBeGreaterThan(1000)
    for (const [path, source] of all) {
      const named = namedFor(source)
      expect(fn.t(path, named), path).toBe(real.t(path, named))
      if (!source.includes('|')) continue
      for (const count of [0, 1, 2, 5, 21]) {
        expect(fn.t(path, count), `${path} #${count}`).toBe(real.t(path, count))
        expect(fn.t(path, named, count), `${path} #${count}`).toBe(real.t(path, named, count))
      }
    }
  })
})

describe('compileMessage: syntax corners, compared with the compiler', () => {
  const corners: Tree = {
    escapes: 'a \\{b\\} \\@ \\| \\\\ c',
    literal: "mail{'@'}velo.app, {'{'}x{'}'}, {'\\u0041'}, {'it\\'s'}",
    spacedNamed: '{ n } and {n}',
    pipes: 'one  |  two | three ',
    tightPipes: 'a|b|c',
    multiline: 'first\nline | second\nline',
    linked: 'see @:brand now',
    linkedModifier: 'x @.upper:brand y',
    linkedNamed: 'open @:{target} now',
    linkedTail: 'end @:brand.',
    list: '{0} and {1}',
    leadTrail: '  lead and trail  ',
  }
  const { real, fn } = pair('ru', corners)

  it.each(Object.keys(corners))('%s', (key) => {
    const named = { n: 7, target: 'brand' }
    expect(fn.t(key, named)).toBe(real.t(key, named))
    for (const count of [1, 2, 5]) expect(fn.t(key, count)).toBe(real.t(key, count))
  })

  it('the rendered corners themselves (both sides could agree on a raw key)', () => {
    expect(fn.t('escapes')).toBe('a {b} @ | \\ c')
    expect(fn.t('literal')).toBe("mail@velo.app, {x}, A, it's")
    expect(fn.t('pipes', 1)).toBe('one')
    expect(fn.t('pipes', 5)).toBe('three ')
    expect(fn.t('linkedModifier')).toBe('x VELO y')
    expect(fn.t('linkedNamed', { target: 'brand' })).toBe('open VELO now')
  })

  it('list interpolation', () => {
    expect(fn.t('list', ['a', 'b'])).toBe(real.t('list', ['a', 'b']))
    expect(fn.t('list', ['a', 'b'])).toBe('a and b')
  })
})

describe('compileMessage: syntax the compiler rejects renders as text', () => {
  const i18n = createI18n({
    legacy: false,
    locale: 'ru',
    missingWarn: false,
    messages: {
      ru: {
        open: compileMessage('a {unclosed b'),
        bareAt: compileMessage('write to a@b.c'),
        stray: compileMessage('x } y'),
      },
    },
  })

  it('keeps the characters instead of throwing', () => {
    expect(i18n.global.t('open')).toBe('a {unclosed b')
    expect(i18n.global.t('bareAt')).toBe('write to a@b.c')
    expect(i18n.global.t('stray')).toBe('x } y')
  })
})

describe('toMessageFunctions', () => {
  it('maps string leaves and arrays, keeps functions and nesting, drops other values', () => {
    const keep = () => 'kept'
    const out = toMessageFunctions({ a: { b: 'x {n}', c: keep }, d: 3, e: ['one', 'two'] })
    expect(Object.keys(out)).toEqual(['a', 'e'])
    const nested = out.a as Tree
    expect(typeof nested.b).toBe('function')
    expect(nested.c).toBe(keep)
    expect((out.e as unknown[]).map((m) => typeof m)).toEqual(['function', 'function'])
  })
})
