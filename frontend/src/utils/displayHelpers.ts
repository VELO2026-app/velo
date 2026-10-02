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
  ExternalActivityType,
} from '@/api/types'
import type { MoodScaleKey } from '@/utils/moodScale'
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
  IconCalendarStar,
} from '@/components/icons'

// ---------------------------------------------------------------------------
// Practice type — emoji map removed (F-9 2026-06): practice cards use the
// vector direction icon via practiceIconFor() instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mood / rating (check-in & feedback)
// ---------------------------------------------------------------------------
//
// mood and rating are stored as a RAW 1..10 score. Since FE-85 the shared
// five-emotion scale (keys + labels + index math) lives in utils/moodScale.ts,
// and raw-score read surfaces import it from there -- one module so a saved
// score is never named a different emotion on some other screen (tz §1, §4).
// The color maps below stay here: they key on the backend's PRE-BUCKETED
// analytics triad ('confused'/'good'/'fire'), not on scores (tz §5).

/**
 * Rating progress-bar FILL colours (analytics / per-practice reviews).
 * Canon from the operator SVGs (2026-06-11): fire = peach, good = rose,
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

/**
 * Five-scale mood strip FILL colours (tz-mood-scale palette), keyed by the
 * moodScale.ts keys. OWNER CANON 2026-10-02 -- the hexes are the standard,
 * not approximations, and are mirrored by the --velo-analytics-* tokens in
 * styles/variables.css (the token wins at runtime; the fallback only covers
 * a context where the stylesheet did not load). Every five-segment
 * analytics strip (practice «До/После практики», the school feedback
 * block) reads its segment colors from here, so the surfaces cannot drift
 * apart.
 */
export const MOOD_SCALE_FILLS: Record<MoodScaleKey, string> = {
  bad: 'var(--velo-analytics-bad, #fe9093)',
  low: 'var(--velo-analytics-low, #faaa63)',
  neutral: 'var(--velo-analytics-neutral, #f7cf17)',
  good: 'var(--velo-analytics-good, #b5eb88)',
  fire: 'var(--velo-analytics-fire, #5abafd)',
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
    return DIRECTION_ICON[dir]
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
  // FE-70: the caption is NOT kind-level -- it comes from the snapshot's
  // activity_type (custom -> the user's own custom_activity_name). Derived in
  // useDiaryCardModel.baseTitle, like practice_outcome reads practice_title.
  external_activity: '',
}

// -- External activity (FE-70 / BE-27) ----------------------------------------
//
// The backend snapshot deliberately carries NO localized names: the caption is
// drawn by the frontend from this key table. `custom` has no dictionary label
// -- its caption is the user's own custom_activity_name, verbatim.

export const EXTERNAL_ACTIVITY_LABEL: Record<ExternalActivityType, string> = {
  vocal: 'Вокал',
  nail_standing: 'Гвоздестояние',
  meditation: 'Медитация',
  massage: 'Массаж',
  yoga: 'Йога',
  dance: 'Танцы',
  custom: '',
}

// Icon for external activity events (FE-70): the owner's own artwork -- a
// calendar with a star in the circle badge (IconCalendarStar). One glyph for
// every activity_type: the event is "something that happened outside velo",
// and the LABEL carries the type (dictionary label or the custom name), so
// per-type artwork would repeat what the caption already says.
export const EXTERNAL_ACTIVITY_ICON: Component = IconCalendarStar

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
