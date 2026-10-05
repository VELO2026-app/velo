// =============================================================================
// VELO Frontend -- textHighlight tests (diary live search, 2026-09-09)
// =============================================================================
//
// Pure util: the segment contract the result rows render. The invariants
// that matter downstream:
//   - concatenating every segment's text reproduces the input EXACTLY (the
//     row never drops or reorders characters);
//   - every hit segment's text equals the needle case-insensitively.

import { describe, it, expect } from 'vitest'
import { splitHighlight } from '@/utils/textHighlight'

describe('splitHighlight', () => {
  it('returns the whole text as one plain segment when the query is empty', () => {
    expect(splitHighlight('Летал во сне', '')).toEqual([{ text: 'Летал во сне', hit: false }])
    expect(splitHighlight('Летал во сне', '   ')).toEqual([{ text: 'Летал во сне', hit: false }])
  })

  it('returns the whole text as one plain segment when nothing matches', () => {
    expect(splitHighlight('Спокойно', 'сон')).toEqual([{ text: 'Спокойно', hit: false }])
  })

  it('marks the match case-insensitively and keeps the plain parts', () => {
    expect(splitHighlight('Сон про сны', 'СОН')).toEqual([
      { text: 'Сон', hit: true },
      { text: ' про сны', hit: false },
    ])
  })

  it('marks EVERY occurrence, not just the first', () => {
    expect(splitHighlight('сон и сон', 'сон')).toEqual([
      { text: 'сон', hit: true },
      { text: ' и ', hit: false },
      { text: 'сон', hit: true },
      { text: '', hit: false },
    ])
  })

  it('handles adjacent hits without infinite loop', () => {
    expect(splitHighlight('сонсон', 'сон')).toEqual([
      { text: 'сон', hit: true },
      { text: 'сон', hit: true },
      { text: '', hit: false },
    ])
  })

  it('trims the needle before matching', () => {
    expect(splitHighlight('приснился сон', '  сон ')).toEqual([
      { text: 'приснился ', hit: false },
      { text: 'сон', hit: true },
      { text: '', hit: false },
    ])
  })

  it('an empty text with a query degrades to one plain empty segment', () => {
    expect(splitHighlight('', 'сон')).toEqual([{ text: '', hit: false }])
  })

  it('concatenating all segments always reproduces the source text', () => {
    for (const [text, q] of [
      ['Сегодня был длинный сон', 'сон'],
      ['SSON и sson', 'sson'],
      ['без совпадений', 'xyz'],
    ] as const) {
      const joined = splitHighlight(text, q)
        .map((s) => s.text)
        .join('')
      expect(joined).toBe(text)
    }
  })
})
