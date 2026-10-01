// =============================================================================
// VELO Frontend -- methodChips unit tests (FE-61/62/63/64)
// =============================================================================
// Boundary cases of the stored-string -> chip mapping: the FE-64 dedup pairs
// the product named («Медитация/Молчания», «Йога/Кундалини»), a style without
// the direction word, a bare direction, the degenerate style==direction, and
// the honest fallbacks (custom text, legacy bare style string). Icon identity
// is asserted by component reference — the same barrel imports the view uses.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { methodChipFor, shortStyleLabel } from '@/utils/methodChips'
import { IconBreathwork, IconCircles, IconDots, IconMeditation, IconYoga } from '@/components/icons'

describe('methodChipFor -- stored string -> icon + short label', () => {
  it('«Медитация — Медитация молчания»: direction word stripped from the style', () => {
    const chip = methodChipFor('Медитация — Медитация молчания')
    expect(chip.icon).toBe(IconMeditation)
    expect(chip.label).toBe('Молчания')
  })

  it('«Йога — Кундалини-йога»: dash-embedded word stripped too', () => {
    const chip = methodChipFor('Йога — Кундалини-йога')
    expect(chip.icon).toBe(IconYoga)
    expect(chip.label).toBe('Кундалини')
  })

  it('«Йога — Виньяса»: a style without the direction word passes through', () => {
    const chip = methodChipFor('Йога — Виньяса')
    expect(chip.icon).toBe(IconYoga)
    expect(chip.label).toBe('Виньяса')
  })

  it('bare direction: direction label, no stripping', () => {
    const chip = methodChipFor('Дыхательные практики')
    expect(chip.icon).toBe(IconBreathwork)
    expect(chip.label).toBe('Дыхательные практики')
  })

  it('«Медитация — Медитация» is not a producible pair: the parser surfaces it verbatim under the fallback glyph', () => {
    // parseMethods maps a «Направление — Вид» string only when BOTH halves
    // resolve — «Медитация» is not a known style under meditation, so the
    // whole string is custom text. The wizard cannot emit such a pair; the
    // style==direction collapse lives in shortStyleLabel (tested above) for
    // catalog-provided styles whose label repeats the direction.
    const chip = methodChipFor('Медитация — Медитация')
    expect(chip.icon).toBe(IconDots)
    expect(chip.label).toBe('Медитация — Медитация')
  })

  it('«Круги — Женский круг»: word stem is NOT stripped (full label only)', () => {
    const chip = methodChipFor('Круги — Женский круг')
    expect(chip.icon).toBe(IconCircles)
    expect(chip.label).toBe('Женский круг')
  })

  it('custom / unknown string: neutral fallback icon, verbatim label', () => {
    const chip = methodChipFor('Мой уникальный метод')
    expect(chip.icon).toBe(IconDots)
    expect(chip.label).toBe('Мой уникальный метод')
  })

  it('legacy bare style string: unknown to the direction parser, verbatim', () => {
    const chip = methodChipFor('Йога-нидра')
    expect(chip.icon).toBe(IconDots)
    expect(chip.label).toBe('Йога-нидра')
  })
})

describe('shortStyleLabel -- the FE-64 dedup rule', () => {
  it('is case-insensitive on the direction word', () => {
    expect(shortStyleLabel('медитация', 'медитация молчания')).toBe('Молчания')
  })

  it('trims separator residue after the strip', () => {
    expect(shortStyleLabel('Йога', 'Хатха-йога')).toBe('Хатха')
    expect(shortStyleLabel('Йога', 'Йога-нидра')).toBe('Нидра')
  })

  it('collapses a style that is exactly the direction back to the direction', () => {
    expect(shortStyleLabel('Медитация', 'Медитация')).toBe('Медитация')
  })

  it('leaves unrelated labels untouched', () => {
    expect(shortStyleLabel('Медитация', 'Звуковая медитация')).toBe('Звуковая')
    expect(shortStyleLabel('Круги', 'Круг шеринга')).toBe('Круг шеринга')
  })
})
