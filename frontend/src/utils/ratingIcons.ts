// =============================================================================
// VELO Frontend -- Mood / Rating Icon Maps
// =============================================================================
//
// Single source of truth for the emotion -> icon COMPONENT map, so the
// surfaces cannot drift apart:
//
//   MOOD_SCALE_ICON -- the five approved FE-85 faces (or the skin's icons,
//     see below), keyed by the shared
//     moodScale.ts keys. Used by MoodSlider, MoodAvatar, the diary card model
//     and DetailView -- every surface that reads a RAW 1..10 score.
//     Since BE-77 the server's zone keys (ScoreZone) are the same five keys,
//     so its feeds and distributions render these faces too -- one map for
//     raw scores and server zones alike.
//
// A skin package may carry its own five icons (contract 2.3, FE-273: the
// mood icon set, virtual:skin-mood). Then every key maps to the skin's icon
// instead of the core face -- the same map for all the surfaces above, so a
// place cannot keep the core face by accident. Without the set (the core build,
// a package of contract 2.0-2.2) the core faces draw, as before.
//
// Kept separate from displayHelpers.ts (labels/colors, kind->string maps) on
// purpose -- this map carries actual Vue Component values, a different kind of
// import than the rest of that file's string/number maps.
// =============================================================================

import type { Component } from 'vue'
import { SKIN_MOOD_ICONS } from 'virtual:skin-mood'
import type { MoodIconSet } from '../../scripts/lib/skin-package.mjs'
import type { MoodScaleKey } from '@/utils/moodScale'
import { createSkinMoodIcon } from '@/utils/skinMoodIcon'
import {
  IconMoodScaleBad,
  IconMoodScaleLow,
  IconMoodScaleNeutral,
  IconMoodScaleGood,
  IconMoodScaleFire,
} from '@/components/icons'

/** The core faces: the approved FE-85 art. */
const CORE_MOOD_SCALE_ICON: Record<MoodScaleKey, Component> = {
  bad: IconMoodScaleBad,
  low: IconMoodScaleLow,
  neutral: IconMoodScaleNeutral,
  good: IconMoodScaleGood,
  fire: IconMoodScaleFire,
}

/**
 * The icon map of a build: the skin's set when its package carries one, the
 * core faces otherwise.
 *
 * @param skinSet - The package's parsed mood icon set, or null for none.
 */
export function moodScaleIcons(skinSet: MoodIconSet | null): Record<MoodScaleKey, Component> {
  if (skinSet === null) return CORE_MOOD_SCALE_ICON
  return {
    bad: createSkinMoodIcon(skinSet.bad),
    low: createSkinMoodIcon(skinSet.low),
    neutral: createSkinMoodIcon(skinSet.neutral),
    good: createSkinMoodIcon(skinSet.good),
    fire: createSkinMoodIcon(skinSet.fire),
  }
}

/** `Mood-scale key -> its icon` ('bad'..'fire', see utils/moodScale.ts): the
 *  approved face, or the skin's icon (contract 2.3). */
export const MOOD_SCALE_ICON: Record<MoodScaleKey, Component> = moodScaleIcons(SKIN_MOOD_ICONS)
