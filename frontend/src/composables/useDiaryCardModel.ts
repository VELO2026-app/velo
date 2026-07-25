// VELO Frontend -- useDiaryCardModel
//
// Single source of truth for deriving the presentational model of one
// DiaryFeedItem (form, titles, preview, icons, practice/banner fields, mood/
// rating zones). Consumed by BOTH card renderers so the kind->title/icon/label
// logic lives in ONE place:
//   - DiaryFeedCard  (flat list / full scale)
//   - DiaryThreadCard (compact map / thread scale)
//
// Icon COMPONENT resolution lives here (not in utils/displayHelpers) following
// the project pattern: kind|mood|rating -> .vue glyph maps sit next to the
// components, mirroring DIRECTION_ICON in displayHelpers.
//
// Inputs are getters so callers pass `() => props.item` and stay reactive.

import { computed, type ComputedRef, type Component } from 'vue'
import {
  IconPen,
  IconDreamBook,
  IconDiaryBook,
  IconMoodMid,
  IconRatingGood,
} from '@/components/icons'
import {
  FEED_KIND_TITLE,
  OUTCOME_LABEL,
  moodZoneFromScore,
  ratingZoneFromScore,
  moodLabelFromScore,
  ratingLabelFromScore,
  practiceIconFor,
} from '@/utils/displayHelpers'
import { MOOD_ICON, RATING_ICON } from '@/utils/ratingIcons'
import { formatTime, formatDate, formatDuration } from '@/utils/format'
import type { DiaryFeedItem, DiaryEventKind } from '@/api/types'

const BANNER_KINDS: DiaryEventKind[] = [
  'booking_confirmed',
  'booking_cancelled_by_user',
  'practice_rescheduled',
  'practice_cancelled_by_master',
]

export interface DiaryCardModel {
  kind: ComputedRef<DiaryEventKind>
  form: ComputedRef<'banner' | 'practice' | 'standard'>
  /** Bare kind label ("Check-in" / "Feedback" / "Заметка"...). */
  baseTitle: ComputedRef<string>
  /** Display title with mood/rating suffix for check-in/feedback. */
  title: ComputedRef<string>
  /** Standard-card content preview (note/dream content or comment). */
  preview: ComputedRef<string | null>
  dateLine: ComputedRef<string>
  /** Mood face / rating glyph / pen / dream-book for standard cards. */
  standardIcon: ComputedRef<Component>
  standardIconSize: ComputedRef<number>
  /** Practice direction glyph. */
  directionIcon: ComputedRef<Component>
  bannerTone: ComputedRef<'teal' | 'neutral'>
  bannerSubtitle: ComputedRef<string | null>
  practiceTitle: ComputedRef<string>
  masterName: ComputedRef<string>
  masterAvatarUrl: ComputedRef<string | null>
  masterVerified: ComputedRef<boolean>
  practiceTime: ComputedRef<string>
  practiceDuration: ComputedRef<string>
  outcomeStatus: ComputedRef<string>
  outcomeLabel: ComputedRef<string>
  /** Rating label alone (for the thread side-card tag). */
  ratingLabel: ComputedRef<string>
  /** note / dream are editable (open the entry screen). */
  editable: ComputedRef<boolean>
}

export function useDiaryCardModel(
  getItem: () => DiaryFeedItem,
  getTimezone: () => string | undefined,
): DiaryCardModel {
  const item = computed(getItem)
  const tz = computed(() => getTimezone() ?? 'UTC')
  const kind = computed(() => item.value.kind as DiaryEventKind)

  const form = computed<'banner' | 'practice' | 'standard'>(() => {
    if (BANNER_KINDS.includes(kind.value)) return 'banner'
    if (kind.value === 'practice_outcome') return 'practice'
    return 'standard'
  })

  // -- snapshot accessors (open dict -- read defensively) --
  const snap = computed<Record<string, unknown>>(() => item.value.snapshot ?? {})
  function snapStr(key: string): string | null {
    const v = snap.value[key]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  function snapNum(key: string): number | null {
    const v = snap.value[key]
    return typeof v === 'number' ? v : null
  }

  const baseTitle = computed(() => FEED_KIND_TITLE[kind.value] ?? '')

  const title = computed(() => {
    const base = baseTitle.value
    if (kind.value === 'checkin') {
      const mood = snapNum('mood')
      return mood !== null ? `${base}: ${moodLabelFromScore(mood)}`.trim() : base
    }
    if (kind.value === 'feedback') {
      const rating = snapNum('rating')
      return rating !== null ? `${base}: ${ratingLabelFromScore(rating)}`.trim() : base
    }
    return base
  })

  const preview = computed(
    () => snapStr('content_preview') ?? snapStr('comment_preview') ?? snapStr('comment'),
  )

  const bannerTone = computed<'teal' | 'neutral'>(() =>
    kind.value === 'booking_confirmed' ? 'teal' : 'neutral',
  )
  const bannerSubtitle = computed(() => {
    if (kind.value === 'booking_confirmed' || kind.value === 'practice_cancelled_by_master') {
      return snapStr('practice_title')
    }
    if (kind.value === 'practice_rescheduled') {
      const oldAt = snapStr('old_scheduled_at')
      const newAt = snapStr('new_scheduled_at') ?? snapStr('scheduled_at')
      if (oldAt && newAt) {
        return `${formatDate(oldAt, tz.value)} – ${formatDate(newAt, tz.value)}`
      }
      return snapStr('practice_title')
    }
    return snapStr('practice_title')
  })

  const practiceTitle = computed(() => snapStr('practice_title') ?? 'Практика')
  const masterName = computed(() => snapStr('master_name') ?? '')
  const masterAvatarUrl = computed(() => snapStr('master_avatar_url'))
  const masterVerified = computed(() => snap.value['master_verified'] === true)
  // Practice card shows time + duration (not the full date — the day is in the
  // timeline's day separator). Duration comes from the snapshot (backend).
  const practiceTime = computed(() => {
    const at = snapStr('scheduled_at')
    return at ? formatTime(at, tz.value) : ''
  })
  const practiceDuration = computed(() => {
    const d = snapNum('duration_minutes')
    return d ? formatDuration(d) : ''
  })
  const outcomeStatus = computed(() => snapStr('outcome_status') ?? 'attended')
  const outcomeLabel = computed(() => OUTCOME_LABEL[outcomeStatus.value] ?? '')

  const directionIcon = computed<Component>(() =>
    practiceIconFor({
      direction: snapStr('direction'),
      title: snapStr('practice_title'),
    }),
  )

  const standardIcon = computed<Component>(() => {
    switch (kind.value) {
      case 'checkin':
        return MOOD_ICON[moodZoneFromScore(snapNum('mood') ?? 6)] ?? IconMoodMid
      case 'feedback':
        return RATING_ICON[ratingZoneFromScore(snapNum('rating') ?? 6)] ?? IconRatingGood
      case 'note':
        return IconDiaryBook
      case 'dream':
        return IconDreamBook
      default:
        return IconPen
    }
  })
  // All standard glyphs render at 32 inside a 40px container (DiaryFeedCard),
  // leaving breathing room so the mood face no longer looks cramped.
  const standardIconSize = computed(() => 32)

  const ratingLabel = computed(() => {
    const rating = snapNum('rating')
    return rating !== null ? ratingLabelFromScore(rating) : ''
  })

  // Time only ("23:07"): the day + weekday live in the timeline's day
  // separator, so the per-card line stays minimal (operator feedback, item 3).
  const dateLine = computed(() => formatTime(item.value.occurred_at, tz.value))

  const editable = computed(() => kind.value === 'note' || kind.value === 'dream')

  return {
    kind,
    form,
    baseTitle,
    title,
    preview,
    dateLine,
    standardIcon,
    standardIconSize,
    directionIcon,
    bannerTone,
    bannerSubtitle,
    practiceTitle,
    masterName,
    masterAvatarUrl,
    masterVerified,
    practiceTime,
    practiceDuration,
    outcomeStatus,
    outcomeLabel,
    ratingLabel,
    editable,
  }
}
