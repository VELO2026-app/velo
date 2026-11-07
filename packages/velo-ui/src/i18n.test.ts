// =============================================================================
// @velo/ui -- i18n seam tests (FE-118, tz-ui-package.md §4 P3)
// =============================================================================
//
// Vitest's per-file isolation gives this file a FRESH i18n module, so the
// pre-configure behaviour (raw key + one dev warning) is testable from a
// cold start as the first test in the file. Component tests configure the
// seam with their own dictionary at the top of their file -- there is no
// global injection on purpose, so a component test can never inherit a
// translator it did not ask for.
// =============================================================================

import { describe, expect, it, vi, afterEach } from 'vitest'

import { t as untranslated } from './i18n'

// The pre-configure state is only visible before any configureUi call in
// THIS file; the lazy imports below pull the live module, not a copy.
import * as i18n from './i18n'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('i18n seam: before configureUi', () => {
  it('returns the raw key and warns once per key in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(untranslated('ui.expand')).toBe('ui.expand')
    expect(untranslated('ui.expand')).toBe('ui.expand')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('configureUi')
    // A different key warns exactly once more, then also goes quiet.
    expect(untranslated('ui.weekdays')).toBe('ui.weekdays')
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('i18n seam: configured translator', () => {
  it('translates registry keys through the injected host t', () => {
    const dict: Record<string, string> = {
      'ui.expand': 'Развернуть',
      'ui.noData': 'Данных пока нет',
    }
    i18n.configureUi({ t: (key) => dict[key] ?? key })
    expect(i18n.t('ui.expand')).toBe('Развернуть')
    expect(i18n.t('ui.noData')).toBe('Данных пока нет')
  })

  it('a second configureUi swaps the translator (test-only path)', () => {
    i18n.configureUi({ t: () => 'first' })
    expect(i18n.t('ui.close')).toBe('first')
    i18n.configureUi({ t: () => 'second' })
    expect(i18n.t('ui.close')).toBe('second')
  })

  it('day families type through the template-literal union', () => {
    const code = 'mon' as 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
    i18n.configureUi({ t: (key) => `[${key}]` })
    expect(i18n.t(`ui.dayFull.${code}`)).toBe('[ui.dayFull.mon]')
    expect(i18n.t(`ui.dayShort.${code}`)).toBe('[ui.dayShort.mon]')
  })
})

describe('UI_I18N_KEYS registry', () => {
  it('is the closed map the key-audit gate reads: 10 static keys + 14 day leaves', () => {
    expect(i18n.UI_I18N_KEYS).toHaveLength(24)
    const unique = new Set(i18n.UI_I18N_KEYS)
    expect(unique.size).toBe(24)
    const staticKeys = i18n.UI_I18N_KEYS.filter(
      (k) => !k.includes('dayFull') && !k.includes('dayShort'),
    )
    expect(staticKeys).toEqual([
      'ui.back',
      'ui.cancel',
      'ui.close',
      'ui.collapse',
      'ui.confirm',
      'ui.expand',
      'ui.menuAria',
      'ui.more',
      'ui.noData',
      'ui.weekdays',
    ])
    for (const family of ['ui.dayFull', 'ui.dayShort']) {
      for (const code of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
        expect(unique.has(`${family}.${code}` as i18n.UiMessageKey)).toBe(true)
      }
    }
  })
})
