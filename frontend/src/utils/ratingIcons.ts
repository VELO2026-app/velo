// =============================================================================
// VELO Frontend -- Mood / Rating Icon Maps
// =============================================================================
//
// Single source of truth for the emotion -> icon COMPONENT map, so the
// surfaces cannot drift apart:
//
//   MOOD_SCALE_ICON -- the five approved FE-85 faces, keyed by the shared
//     moodScale.ts keys. Used by MoodSlider, MoodAvatar, the diary card model
//     and DetailView -- every surface that reads a RAW 1..10 score.
//     Since BE-77 the server's zone keys (ScoreZone) are the same five keys,
//     so its feeds and distributions render these faces too -- one map for
//     raw scores and server zones alike.
//
// Kept separate from displayHelpers.ts (labels/colors, kind->string maps) on
// purpose -- this map carries actual Vue Component values, a different kind of
// import than the rest of that file's string/number maps.
// =============================================================================

import type { Component } from 'vue'
import type { MoodScaleKey } from '@/utils/moodScale'
import {
  IconMoodScaleBad,
  IconMoodScaleLow,
  IconMoodScaleNeutral,
  IconMoodScaleGood,
  IconMoodScaleFire,
} from '@/components/icons'

/** Mood-scale key ('bad'..'fire', see utils/moodScale.ts) -> its approved face. */
export const MOOD_SCALE_ICON: Record<MoodScaleKey, Component> = {
  bad: IconMoodScaleBad,
  low: IconMoodScaleLow,
  neutral: IconMoodScaleNeutral,
  good: IconMoodScaleGood,
  fire: IconMoodScaleFire,
}
