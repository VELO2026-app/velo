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
  PracticeDirection,
  PracticeDifficulty,
  DurationBucket,
  TimeOfDay,
  ExternalActivityType,
} from '@/api/types'
import type { MoodScaleKey } from '@/utils/moodScale'
import type { Component } from 'vue'
import i18n from '@/locales'
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

// Label dictionaries resolve at ACCESS time (getters), not at module import:
// the active locale's words, and the many `LABEL[x]` call sites across views
// stay untouched until their phase-3 batch (tz-i18n 1.1).
const { t } = i18n.global

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
// The fill map below stays here (a color map, like the rest of this file);
// it keys on the same moodScale.ts keys the server's zones use (BE-77).

/**
 * Five-scale mood strip FILL colours (tz-mood-scale palette), keyed by the
 * moodScale.ts keys. OWNER CANON 2026-10-02 -- the hexes are the standard,
 * not approximations, and are mirrored by the --velo-analytics-* tokens in
 * styles/variables.css (the token wins at runtime; the fallback only covers
 * a context where the stylesheet did not load). Every five-segment
 * analytics strip (practice «До/После практики», the school feedback
 * block, the rating bars and the feeds' distributions since BE-77) reads
 * its segment colors from here, so the surfaces cannot drift apart.
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
  get meditation(): string {
    return t('display.direction.meditation')
  },
  get yoga(): string {
    return t('display.direction.yoga')
  },
  get breathwork(): string {
    return t('display.direction.breathwork')
  },
  get somatic(): string {
    return t('display.direction.somatic')
  },
  get tantra(): string {
    return t('display.direction.tantra')
  },
  get circles(): string {
    return t('display.direction.circles')
  },
  get sound_healing(): string {
    return t('display.direction.sound_healing')
  },
  get art(): string {
    return t('display.direction.art')
  },
  get narrative(): string {
    return t('display.direction.narrative')
  },
  get movement(): string {
    return t('display.direction.movement')
  },
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
  get beginner(): string {
    return t('display.difficulty.beginner')
  },
  get medium(): string {
    return t('display.difficulty.medium')
  },
  get high(): string {
    return t('display.difficulty.high')
  },
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
  get short(): string {
    return t('display.durationBucket.short')
  },
  get long(): string {
    return t('display.durationBucket.long')
  },
}

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  get night(): string {
    return t('display.timeOfDay.night')
  },
  get morning(): string {
    return t('display.timeOfDay.morning')
  },
  get day(): string {
    return t('display.timeOfDay.day')
  },
  get evening(): string {
    return t('display.timeOfDay.evening')
  },
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
  get booking_confirmed(): string {
    return t('display.feedKind.booking_confirmed')
  },
  get booking_cancelled_by_user(): string {
    return t('display.feedKind.booking_cancelled_by_user')
  },
  get practice_rescheduled(): string {
    return t('display.feedKind.practice_rescheduled')
  },
  get practice_cancelled_by_master(): string {
    return t('display.feedKind.practice_cancelled_by_master')
  },
  practice_outcome: '', // uses practice_title from snapshot
  checkin: 'Check-in', // + ": " + mood label
  feedback: 'Feedback', // + ": " + rating label
  get note(): string {
    return t('display.feedKind.note')
  },
  get dream(): string {
    return t('display.feedKind.dream')
  },
  // Written when the chat proxy opens (or re-finds) the DM with a master. The
  // thread can be created without a message being sent yet, so the copy is
  // about the conversation starting, not about writing. The master's name is
  // the card's preview line (useDiaryCardModel.preview).
  get thread_started(): string {
    return t('display.feedKind.thread_started')
  },
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
  get vocal(): string {
    return t('display.externalActivity.vocal')
  },
  get nail_standing(): string {
    return t('display.externalActivity.nail_standing')
  },
  get meditation(): string {
    return t('display.externalActivity.meditation')
  },
  get massage(): string {
    return t('display.externalActivity.massage')
  },
  get yoga(): string {
    return t('display.externalActivity.yoga')
  },
  get dance(): string {
    return t('display.externalActivity.dance')
  },
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
  get attended(): string {
    return t('display.outcome.attended')
  },
  get no_show(): string {
    return t('display.outcome.no_show')
  },
}

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

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
  if (valid.length === 7) return t('display.recurrenceDaily')
  return valid.map((d) => t(`display.weekdayAbbr.${d}`)).join(', ')
}

/**
 * Upper-cased short weekday label for an ISO weekday (1=Mon..7=Sun): the
 * design grids (week strip, date/diary pickers) render ПН..ВС / MON..SUN.
 * The ONE place that knows the labels are upper-cased -- callers keep only
 * their own day ordering.
 */
export function weekdayAbbrUpper(iso: number): string {
  return t(`display.weekdayAbbr.${iso}`).toUpperCase()
}
