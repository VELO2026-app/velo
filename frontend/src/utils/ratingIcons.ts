// =============================================================================
// VELO Frontend -- Mood / Rating Icon Maps
// =============================================================================
//
// B6 (Батч 3, ПРОМТ №580): single source of truth for the mood/rating zone ->
// icon COMPONENT maps, previously duplicated byte-for-byte across 9 files:
//   RATING_ICON -- useDiaryCardModel.ts, DetailView.vue, AnalyticsView.vue,
//     MasterPracticeDetailView.vue, MasterSummaryView.vue, PracticeReviewsView.vue,
//     and MasterStudentProfileView.vue under the alias ICON_BY_ZONE.
//   MOOD_ICON -- useDiaryCardModel.ts, DetailView.vue.
// Verified byte-identical (same key->icon pairs) before consolidating here; a
// diverging copy would have been left in place and reported, not silently
// picked.
//
// Kept separate from displayHelpers.ts (labels/colors, kind->string maps) on
// purpose -- these two carry actual Vue Component values, a different kind of
// import than the rest of that file's string/number maps.
// =============================================================================

import type { Component } from 'vue'
import type { FeedbackRating } from '@/api/types'
import {
  IconMoodLow,
  IconMoodMid,
  IconMoodHigh,
  IconRatingFire,
  IconRatingGood,
  IconRatingConfused,
} from '@/components/icons'

/** Mood zone ('low'/'mid'/'high', see displayHelpers.moodZoneFromScore) -> icon. */
export const MOOD_ICON: Record<'low' | 'mid' | 'high', Component> = {
  low: IconMoodLow,
  mid: IconMoodMid,
  high: IconMoodHigh,
}

/** Rating zone (FeedbackRating, see displayHelpers.ratingZoneFromScore) -> icon. */
export const RATING_ICON: Record<FeedbackRating, Component> = {
  fire: IconRatingFire,
  good: IconRatingGood,
  confused: IconRatingConfused,
}
