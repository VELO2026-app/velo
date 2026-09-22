// =============================================================================
// VELO Frontend -- moodScale.ts Unit Tests
// =============================================================================
//
// The shared 1..10 scale (tz-mood-scale.md) is the boundary contract between
// Check-in and Feedback: every saved score later has to read as the emotion it
// was picked as, on every surface. So the whole 1..10 range is walked here
// (acceptance: "boundary-тесты покрывают каждое число 1..10") instead of
// sampling it -- an off-by-one at any pair border (2|3, 4|5, 6|7, 8|9) shifts
// real user data between emotions.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  MOOD_SCALE_MAX,
  MOOD_SCALE_MIN,
  MOOD_SCALE_DEFAULT_SCORE,
  MOOD_SCALE_KEYS,
  MOOD_SCALE_LABELS,
  clampMoodScore,
  moodIndexFromScore,
  moodScoreFromIndex,
  moodKeyFromScore,
  moodLabelFromScore,
  moodValueText,
} from './moodScale'

describe('the scale itself', () => {
  it('is the five-emotion 1..10 contract', () => {
    expect(MOOD_SCALE_MIN).toBe(1)
    expect(MOOD_SCALE_MAX).toBe(10)
    expect(MOOD_SCALE_DEFAULT_SCORE).toBe(5)
    expect([...MOOD_SCALE_KEYS]).toEqual(['bad', 'low', 'neutral', 'good', 'fire'])
  })

  it('carries exactly the approved label set (no «Огонь!», no «Есть вопросы»)', () => {
    expect(MOOD_SCALE_LABELS).toEqual({
      bad: 'Плохо',
      low: 'Не очень',
      neutral: 'Нормально',
      good: 'Хорошо',
      fire: 'Огонь',
    })
  })
})

describe('moodIndexFromScore -- every score 1..10 lands in its strict pair', () => {
  // (score, expected index). Pairs are 1-2 / 3-4 / 5-6 / 7-8 / 9-10: dragging
  // across 2|3, 4|5, 6|7 or 8|9 MUST flip the active card (tz §2.1).
  it.each([
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 2],
    [6, 2],
    [7, 3],
    [8, 3],
    [9, 4],
    [10, 4],
  ])('score %i -> index %i', (score, index) => {
    expect(moodIndexFromScore(score)).toBe(index)
  })
})

describe('moodScoreFromIndex -- a tap/swipe picks the TOP score of the pair', () => {
  it('maps the five cards to 2/4/6/8/10 (tz §1, §2.3)', () => {
    expect(MOOD_SCALE_KEYS.map((_, i) => moodScoreFromIndex(i))).toEqual([2, 4, 6, 8, 10])
  })

  it('clamps a stray index instead of producing an off-scale score', () => {
    expect(moodScoreFromIndex(-1)).toBe(2)
    expect(moodScoreFromIndex(5)).toBe(10)
  })
})

describe('moodKeyFromScore / moodLabelFromScore -- key + label per score', () => {
  it.each([
    [1, 'bad', 'Плохо'],
    [2, 'bad', 'Плохо'],
    [3, 'low', 'Не очень'],
    [4, 'low', 'Не очень'],
    [5, 'neutral', 'Нормально'],
    [6, 'neutral', 'Нормально'],
    [7, 'good', 'Хорошо'],
    [8, 'good', 'Хорошо'],
    [9, 'fire', 'Огонь'],
    [10, 'fire', 'Огонь'],
  ])('score %i -> %s / «%s»', (score, key, label) => {
    expect(moodKeyFromScore(score)).toBe(key)
    expect(moodLabelFromScore(score)).toBe(label)
  })
})

describe('clampMoodScore -- a damaged stored score is contained for DISPLAY', () => {
  // The server validates 1..10; this clamp only guards the rendering of a
  // broken row (tz §5) -- it never widens what a form may send.
  it('pins out-of-range values to the nearest end', () => {
    expect(clampMoodScore(0)).toBe(1)
    expect(clampMoodScore(-3)).toBe(1)
    expect(clampMoodScore(11)).toBe(10)
    expect(clampMoodScore(99)).toBe(10)
  })

  it('rounds a fractional score to a whole one', () => {
    expect(clampMoodScore(5.4)).toBe(5)
    expect(clampMoodScore(5.5)).toBe(6)
  })

  it('treats a non-finite score as the neutral default, not NaN', () => {
    expect(clampMoodScore(Number.NaN)).toBe(MOOD_SCALE_DEFAULT_SCORE)
    expect(clampMoodScore(Number.POSITIVE_INFINITY)).toBe(10)
  })
})

describe('moodValueText -- the range input reads «5 из 10 — Нормально»', () => {
  // Exact string from tz §8's a11y contract: value, «из 10», dash, label.
  it('names the emotion for the current score', () => {
    expect(moodValueText(5)).toBe('5 из 10 — Нормально')
    expect(moodValueText(1)).toBe('1 из 10 — Плохо')
    expect(moodValueText(10)).toBe('10 из 10 — Огонь')
  })

  it('clamps first, so a broken score still reads as a real emotion', () => {
    expect(moodValueText(0)).toBe('1 из 10 — Плохо')
    expect(moodValueText(11)).toBe('10 из 10 — Огонь')
  })
})
