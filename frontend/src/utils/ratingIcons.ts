// =============================================================================
// VELO Frontend -- Mood / Rating Icon Maps
// =============================================================================
//
// Single source of truth for the emotion -> icon COMPONENT maps, so raw-score
// surfaces cannot drift apart:
//
//   MOOD_SCALE_ICON -- the five approved FE-85 faces, keyed by the shared
//     moodScale.ts keys. Used by MoodSlider, MoodAvatar, the diary card model
//     and DetailView -- every surface that reads a RAW 1..10 score.
//
//   RATING_ICON -- the analytics bucket glyphs keyed 'fire'|'good'|'confused'.
//     Those buckets arrive PRE-BUCKETED from the backend (FeedbackRating), so
//     they are NOT raw scores -- widening them to five is the separate
//     analytics backend task and must not leak into this map (tz-mood-scale §5).
//
// Kept separate from displayHelpers.ts (labels/colors, kind->string maps) on
// purpose -- these two carry actual Vue Component values, a different kind of
// import than the rest of that file's string/number maps.
// =============================================================================

import type { Component } from 'vue'
import type { FeedbackRating } from '@/api/types'
import type { MoodScaleKey } from '@/utils/moodScale'
import {
  IconMoodScaleBad,
  IconMoodScaleLow,
  IconMoodScaleNeutral,
  IconMoodScaleGood,
  IconMoodScaleFire,
  IconRatingFire,
  IconRatingGood,
  IconRatingConfused,
} from '@/components/icons'

/** Mood-scale key ('bad'..'fire', see utils/moodScale.ts) -> its approved face. */
export const MOOD_SCALE_ICON: Record<MoodScaleKey, Component> = {
  bad: IconMoodScaleBad,
  low: IconMoodScaleLow,
  neutral: IconMoodScaleNeutral,
  good: IconMoodScaleGood,
  fire: IconMoodScaleFire,
}

/** Analytics bucket (pre-bucketed FeedbackRating, NOT a raw score) -> icon. */
export const RATING_ICON: Record<FeedbackRating, Component> = {
  fire: IconRatingFire,
  good: IconRatingGood,
  confused: IconRatingConfused,
}
