// =============================================================================
// VELO Frontend -- Mood Scale (FE-85, tz-mood-scale.md)
// =============================================================================
//
// The numeric contract of the unified 1..10 state scale shared by Check-in
// (mood) and Feedback (rating): five emotions, two scores each. The label set
// lives here too, so a saved score is never named a different emotion later
// (tz §1: "Числовой контракт и подписи живут в одном общем модуле шкалы").
//
// PURE module: no .vue imports (tz §4.3). The key -> icon binding lives in
// utils/ratingIcons.ts (UI layer), the interaction lives in MoodSlider.vue.
//
// Canonical index formula (tz §1):
//   const index = Math.floor((clamp(score, 1, 10) - 1) / 2)
// Drag on the range keeps the exact number the user stopped on (1/3/5/7/9
// included); a card tap / finished swipe picks the TOP score of the pair
// (2/4/6/8/10). The boundary between emotions is 2|3, 4|5, 6|7, 8|9.
// =============================================================================

export type MoodScaleKey = 'bad' | 'low' | 'neutral' | 'good' | 'fire'

export const MOOD_SCALE_MIN = 1
export const MOOD_SCALE_MAX = 10

/**
 * Both forms open here: the EXACT score 5 / «Нормально» (tz §2.4). Not a zone
 * centre -- submitting an untouched form sends 5, not the pair's click value 6.
 */
export const MOOD_SCALE_DEFAULT_SCORE = 5

/** Scale order, left to right on the slider. */
export const MOOD_SCALE_KEYS = ['bad', 'low', 'neutral', 'good', 'fire'] as const satisfies readonly MoodScaleKey[]

export const MOOD_SCALE_LABELS: Record<MoodScaleKey, string> = {
  bad: 'Плохо',
  low: 'Не очень',
  neutral: 'Нормально',
  good: 'Хорошо',
  fire: 'Огонь',
}

/** Display-side clamp of a (possibly damaged) stored score. */
export function clampMoodScore(score: number): number {
  // NaN has no ordering, so it cannot clamp -- it degrades to the default.
  // +/-Infinity clamp naturally onto the scale ends below.
  if (Number.isNaN(score)) return MOOD_SCALE_DEFAULT_SCORE
  return Math.min(MOOD_SCALE_MAX, Math.max(MOOD_SCALE_MIN, Math.round(score)))
}

/** score -> emotion index 0..4 (the canonical tz formula). */
/** The five emotion positions on the strip, 0..4 left-to-right. */
export type MoodScaleIndex = 0 | 1 | 2 | 3 | 4

/** score -> emotion index 0..4 (the canonical tz formula), narrowed to the
 *  tuple-index union so `MOOD_SCALE_KEYS[index]` stays a total lookup. */
export function moodIndexFromScore(score: number): MoodScaleIndex {
  // clampMoodScore ∈ 1..10  =>  (score - 1) / 2 ∈ 0..4.5  =>  floor ∈ 0..4.
  return Math.floor((clampMoodScore(score) - 1) / 2) as MoodScaleIndex
}

/** index -> the emotion's tap/swipe score: the TOP value of its pair (tz §1). */
export function moodScoreFromIndex(index: number): number {
  return Math.min(MOOD_SCALE_KEYS.length - 1, Math.max(0, Math.round(index))) * 2 + 2
}

/** score -> semantic key ('bad' | 'low' | 'neutral' | 'good' | 'fire'). */
export function moodKeyFromScore(score: number): MoodScaleKey {
  return MOOD_SCALE_KEYS[moodIndexFromScore(score)]
}

/** score -> Russian label («Плохо» .. «Огонь»). One label set for both forms. */
export function moodLabelFromScore(score: number): string {
  return MOOD_SCALE_LABELS[moodKeyFromScore(score)]
}

/** Range input's aria-valuetext: «5 из 10 — Нормально» (tz §8). */
export function moodValueText(score: number): string {
  return `${clampMoodScore(score)} из ${MOOD_SCALE_MAX} — ${moodLabelFromScore(score)}`
}
