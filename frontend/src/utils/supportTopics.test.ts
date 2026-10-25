// =============================================================================
// VELO Frontend -- utils/supportTopics Unit Tests (FE-100)
// =============================================================================
//
// The one table "category -> icon" and the five filter chips over the six
// categories. Asserted as a whole: five glyphs, both complaints one glyph
// (owner ruling 25.10), colours from the owner's mockup as existing tokens,
// every category in exactly one chip. The temporary glyphs (practices,
// complaints -- see the module header) are pinned too, so their replacement
// is a visible change of this file.
// =============================================================================

import { describe, it, expect } from 'vitest'
import type { SupportCategory } from '@/api/support'
import {
  SUPPORT_CATEGORY_GROUPS,
  supportCategoryGroupLabel,
  supportCategoryIcon,
} from '@/utils/supportTopics'
import {
  IconFinance,
  IconMeditation,
  IconProfile,
  IconQuestion,
  IconWarning,
} from '@/components/icons'

const CATEGORIES: SupportCategory[] = [
  'tech',
  'practices',
  'payments',
  'complaint_master',
  'complaint_user',
  'other',
]

describe('category -> icon', () => {
  it.each([
    ['tech', IconWarning, 'var(--velo-pink-300)'],
    ['payments', IconFinance, 'var(--velo-analytics-neutral)'],
    ['practices', IconMeditation, 'var(--velo-analytics-good)'],
    ['complaint_master', IconProfile, 'var(--velo-peach-300)'],
    ['complaint_user', IconProfile, 'var(--velo-peach-300)'],
    ['other', IconQuestion, 'var(--velo-blue-200)'],
  ] as const)('%s -> its glyph and colour', (category, icon, color) => {
    expect(supportCategoryIcon(category)).toEqual({ icon, color })
  })

  it('six categories, five glyphs -- the two complaints share one', () => {
    const glyphs = new Set(CATEGORIES.map((c) => supportCategoryIcon(c).icon))
    expect(glyphs.size).toBe(5)
    expect(supportCategoryIcon('complaint_master').icon).toBe(
      supportCategoryIcon('complaint_user').icon,
    )
  })

  it('every colour is a token, none is a raw value', () => {
    for (const c of CATEGORIES) {
      expect(supportCategoryIcon(c).color).toMatch(/^var\(--velo-[a-z0-9-]+\)$/)
    }
  })
})

describe('the five filter chips', () => {
  it('cover every category exactly once', () => {
    const covered = SUPPORT_CATEGORY_GROUPS.flatMap((g) => [...g.categories])
    expect([...covered].sort()).toEqual([...CATEGORIES].sort())
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('«Жалобы» is both complaint categories', () => {
    expect(SUPPORT_CATEGORY_GROUPS.find((g) => g.key === 'complaints')?.categories).toEqual([
      'complaint_master',
      'complaint_user',
    ])
  })

  it('are labelled in the reader\u2019s language, in the mockup order', () => {
    expect(SUPPORT_CATEGORY_GROUPS.map((g) => supportCategoryGroupLabel(g.key))).toEqual([
      'Оплаты',
      'Практики',
      'Тех. проблемы',
      'Жалобы',
      'Другое',
    ])
  })
})
