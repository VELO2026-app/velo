// =============================================================================
// VELO Frontend -- Display Helpers (Phase F9 review, extended Calendar)
// =============================================================================
//
// Single source of truth for all emoji / label / color mappings used in
// practice cards, diary, check-in, feedback, and analytics views.
//
// Previously duplicated across 8+ files (W-2, S-3 fixes).
// =============================================================================

import type {
  FeedbackRating,
  PracticeDirection,
  PracticeDifficulty,
  DurationBucket,
  TimeOfDay,
} from '@/api/types'
import type { Component } from 'vue'
import {
  IconMeditation,
  IconYoga,
  IconBreathwork,
  IconSomatic,
  IconTantra,
  IconCircles,
  IconSoundHealing,
  IconArt,
  IconNarrative,
  IconMovement,
  IconDots,
} from '@/components/icons'

// ---------------------------------------------------------------------------
// Practice type — emoji map removed (F-9 2026-06): practice cards use the
// vector direction icon via practiceIconFor() instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mood (check-in)
// ---------------------------------------------------------------------------

/** Mood label by zone. Mood buttons render via vector IconMood* (CheckinView). */
export const MOOD_LABEL: Record<string, string> = {
  low: 'Не очень',
  mid: 'Нормально',
  high: 'Хорошо',
}

// ---------------------------------------------------------------------------
// Feedback rating
// ---------------------------------------------------------------------------

/** Rating label by zone. Rating buttons render via vector IconRating* (FeedbackView). */
export const RATING_LABEL: Record<string, string> = {
  fire: 'Огонь!',
  good: 'Хорошо',
  confused: 'Есть вопросы',
}

// ---------------------------------------------------------------------------
// Score (1..10) -> zone / label
// ---------------------------------------------------------------------------
//
// mood and rating are stored as a 1..10 score now. The UI derives the icon
// and label from the range: 1-3 / 4-7 / 8-10. The diary feed cards (and any
// other read surface) use these helpers so the bucketing lives in one place.

/** mood score (1..10) -> mood key. 1-3 low / 4-7 mid / 8-10 high. */
export function moodZoneFromScore(score: number): 'low' | 'mid' | 'high' {
  if (score <= 3) return 'low'
  if (score <= 7) return 'mid'
  return 'high'
}

/** rating score (1..10) -> rating key. 1-3 confused / 4-7 good / 8-10 fire. */
export function ratingZoneFromScore(score: number): 'confused' | 'good' | 'fire' {
  if (score <= 3) return 'confused'
  if (score <= 7) return 'good'
  return 'fire'
}

/** mood score -> Russian label ("Не очень" / "Нормально" / "Хорошо"). */
export function moodLabelFromScore(score: number): string {
  return MOOD_LABEL[moodZoneFromScore(score)] ?? ''
}

/** rating score -> Russian label ("Есть вопросы" / "Хорошо" / "Огонь!"). */
export function ratingLabelFromScore(score: number): string {
  return RATING_LABEL[ratingZoneFromScore(score)] ?? ''
}

/**
 * Rating progress-bar FILL colours (analytics / per-practice reviews).
 * Canon from the operator SVGs (2026-06-11): fire = peach, good = pink/rose,
 * confused = blue. A DIFFERENT palette from RATING_ICON_COLOR (the icon accents)
 * on purpose -- bars are the lighter fills, icons are the saturated accents.
 */
export const RATING_COLOR: Record<FeedbackRating, string> = {
  fire: 'var(--velo-peach-300)', // #fbc088
  good: 'var(--velo-pink-300)', // #f795a2
  confused: 'var(--velo-blue-400)', // #619cd2
}

/**
 * Accent color per rating ICON on the feedback form (Figma feedback design):
 * confused = brand blue, good = rose, fire = peach/orange. Separate from
 * RATING_COLOR (analytics bar fills) on purpose -- different surfaces,
 * different palettes. Values reference --velo-rating-* tokens (variables.css).
 */
export const RATING_ICON_COLOR: Record<FeedbackRating, string> = {
  confused: 'var(--velo-rating-confused)',
  good: 'var(--velo-rating-good)',
  fire: 'var(--velo-rating-fire)',
}

// ---------------------------------------------------------------------------
// Calendar taxonomy (direction / difficulty) + feed buckets
// ---------------------------------------------------------------------------
//
// Labels for the Calendar filter UI and practice detail. Values MUST match
// the backend allowed lists / filter literals. Single source of truth --
// do not duplicate these strings in components.

export const DIRECTION_LABEL: Record<PracticeDirection, string> = {
  meditation: 'Медитация',
  yoga: 'Йога',
  breathwork: 'Дыхательные практики',
  somatic: 'Соматика',
  tantra: 'Тантра',
  circles: 'Круги',
  sound_healing: 'Саундхиллинг',
  art: 'Арт-практики',
  narrative: 'Нарративные практики',
  movement: 'Движение',
}

// Direction -> icon component for the practice hero card.
// Partial (not Record) ON PURPOSE: PracticeDirection is hand-maintained in
// api/types.ts and matches the future backend list — but until backend B-2
// lands (handoff §9), some directions still can't be created by masters.
// A new direction added here without its own icon would fall through to
// DIRECTION_ICON_FALLBACK instead of failing vue-tsc.
export const DIRECTION_ICON: Partial<Record<PracticeDirection, Component>> = {
  meditation: IconMeditation,
  yoga: IconYoga,
  breathwork: IconBreathwork,
  somatic: IconSomatic,
  tantra: IconTantra,
  circles: IconCircles,
  sound_healing: IconSoundHealing,
  art: IconArt,
  narrative: IconNarrative,
  movement: IconMovement,
}

/** Neutral fallback glyph. After F-1 closed (2026-05-28) all 10 directions
 * in DIRECTION_ICON have real artwork, so this is only hit when:
 *   - the backend returns an unknown direction string (e.g. transient state
 *     during the B-2 migration when old kundalini/womens_circle/mens_circle
 *     records have not been remapped yet);
 *   - the caller passes direction=null/undefined and the title-heuristic in
 *     practiceIconFor() also fails to match.
 * Deliberately NOT IconMeditation — a neutral "..." reads as "icon pending"
 * instead of misleading the user about the direction. */
export const DIRECTION_ICON_FALLBACK: Component = IconDots

/**
 * Pick the icon component for a practice card by direction.
 *
 * Works for both PracticeResponse and PracticeSummary — backend B-1 added
 * `direction` to PracticeSummary on 2026-05-28, so the title-heuristic
 * fallback that used to live here is no longer needed (removed 2026-05-29).
 * Unknown direction -> neutral IconDots fallback.
 *
 * `title` prop kept in the signature for call-site compatibility (some
 * legacy callers pass it); ignored internally.
 */
export function practiceIconFor(p: {
  /** direction идёт из generated.ts как string (бэкенд widen-нул enum);
   *  принимаем string и сами проверяем через DIRECTION_ICON. */
  direction?: string | null
  /** Kept for backwards compatibility — ignored after B-1 (2026-05-28). */
  title?: string | null
}): Component {
  const dir = p.direction as PracticeDirection | undefined
  if (dir && DIRECTION_ICON[dir]) {
    return DIRECTION_ICON[dir]!
  }
  return DIRECTION_ICON_FALLBACK
}

export const DIFFICULTY_LABEL: Record<PracticeDifficulty, string> = {
  beginner: 'Начальная',
  medium: 'Средняя',
  high: 'Высокая',
}

/**
 * Filled-dot count for the difficulty indicator (PracticeDetailView):
 * beginner *oo / medium **o / high ***.
 */
export const DIFFICULTY_DOTS: Record<PracticeDifficulty, number> = {
  beginner: 1,
  medium: 2,
  high: 3,
}

export const DURATION_BUCKET_LABEL: Record<DurationBucket, string> = {
  short: 'До 1 часа',
  long: '1 час и больше',
}

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  night: 'Ночь',
  morning: 'Утро',
  day: 'День',
  evening: 'Вечер',
}

// ---------------------------------------------------------------------------
// Diary feed (unified timeline)
// ---------------------------------------------------------------------------
//
// Card title per event kind. The feed renders these as the card heading;
// checkin/feedback append the mood/rating label (e.g. "Check-in: Не очень").
// Values match the design (screens 40/41). kind->icon COMPONENT mapping lives
// in DiaryFeedCard.vue, not here -- the utils layer must not import .vue files
// (same rule as MOOD_ICON in CheckinView).

import type { DiaryEventKind } from '@/api/types'

export const FEED_KIND_TITLE: Record<DiaryEventKind, string> = {
  booking_confirmed: 'Вы записались',
  booking_cancelled_by_user: 'Вы отменили запись',
  practice_rescheduled: 'Мастер перенёс практику',
  practice_cancelled_by_master: 'Практика отменена',
  practice_outcome: '', // uses practice_title from snapshot
  checkin: 'Check-in', // + ": " + mood label
  feedback: 'Feedback', // + ": " + rating label
  note: 'Дневник',
  dream: 'Сонник',
  // Written when the chat proxy opens (or re-finds) the DM with a master. The
  // thread can be created without a message being sent yet, so the copy is
  // about the conversation starting, not about writing. The master's name is
  // the card's preview line (useDiaryCardModel.preview).
  thread_started: 'Вы начали диалог',
}

/**
 * Outcome badge label for a practice_outcome card.
 * attended -> "Done" (teal), no_show -> "Вы не пришли".
 *
 * B30 (PROMPT №747): was 'Не состоялась' -- false, the practice DID happen,
 * the person missed it. Feeds DiaryFeedCard.vue and DiaryThreadCard.vue via
 * useDiaryCardModel's outcomeLabel, both user-facing (DetailView.vue).
 */
export const OUTCOME_LABEL: Record<string, string> = {
  attended: 'Done',
  no_show: 'Вы не пришли',
}

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

/** Short Russian weekday names indexed by ISO weekday − 1 (1=Mon … 7=Sun). */
const WEEKDAY_ABBR = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

/**
 * Recurrence label for a series from its ISO weekday list: «Ежедневно» when all
 * seven days are present, otherwise the short list «Пн, Ср, Пт» (de-duplicated,
 * ordered Mon→Sun). Returns null when there are no valid days so the caller can
 * fall back to a generic label.
 */
export function recurrenceDaysLabel(days: number[] | null | undefined): string | null {
  if (!days || days.length === 0) return null
  const valid = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b)
  if (valid.length === 0) return null
  if (valid.length === 7) return 'Ежедневно'
  return valid.map((d) => WEEKDAY_ABBR[d - 1]).join(', ')
}
