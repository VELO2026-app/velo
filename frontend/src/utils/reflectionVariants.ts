// =============================================================================
// VELO Frontend -- No-show reflection copy variants (PROMPT №269, U4)
// =============================================================================
//
// A no-show booking («Не состоялась») prompts a gentle reflection instead of a
// practice rating. To avoid boring returning users with identical wording, the
// dashboard banner + the reflection screen draw their copy from a small pool,
// picked by a STABLE hash of the practiceId: the same booking always shows the
// same variant (no flicker on the dashboard's 60s clock re-eval), while
// different practices rotate through the set.
//
// Copy source = operator SVGs (3 ReflectionView screens + 2 banner plates,
// PROMPT №269). V2 bannerTitle defaults to «Поделитесь состоянием» (F5=А).
// Text-only: no backend, no new component.
// Fields resolve at ACCESS time (getters): the active locale's copy, and the
// stable-hash pick stays as-is (tz-i18n 1.1).
// =============================================================================

import i18n from '@/locales'

const { t } = i18n.global

export interface ReflectionVariant {
  /** Dashboard plate title (operator banner SVGs). */
  bannerTitle: string
  /** Reflection-screen question title (operator screen SVGs). */
  screenTitle: string
  /** Reflection-screen question subtitle (operator screen SVGs). */
  screenSubtitle: string
}

// Named so pickReflectionVariant has a definite (non-undefined) fallback under
// noUncheckedIndexedAccess without a cast / non-null assertion.
const VARIANT_WELLBEING: ReflectionVariant = {
  get bannerTitle(): string {
    return t('reflection.v1.bannerTitle')
  },
  get screenTitle(): string {
    return t('reflection.v1.screenTitle')
  },
  get screenSubtitle(): string {
    return t('reflection.v1.screenSubtitle')
  },
}

export const REFLECTION_VARIANTS: readonly ReflectionVariant[] = [
  VARIANT_WELLBEING,
  {
    get bannerTitle(): string {
      return t('reflection.v2.bannerTitle')
    },
    get screenTitle(): string {
      return t('reflection.v2.screenTitle')
    },
    get screenSubtitle(): string {
      return t('reflection.v2.screenSubtitle')
    },
  },
  {
    get bannerTitle(): string {
      return t('reflection.v3.bannerTitle')
    },
    get screenTitle(): string {
      return t('reflection.v3.screenTitle')
    },
    get screenSubtitle(): string {
      return t('reflection.v3.screenSubtitle')
    },
  },
]

/**
 * Deterministic non-negative char-sum hash of a string. No Math.random — the
 * pick must stay stable across the dashboard's 60s re-eval and across reloads.
 */
function stableHash(key: string): number {
  let sum = 0
  for (let i = 0; i < key.length; i++) {
    sum = (sum + key.charCodeAt(i)) % 100000
  }
  return sum
}

/**
 * Pick a reflection variant for a booking by a stable hash of its practiceId.
 * Same practiceId -> same variant every time.
 */
export function pickReflectionVariant(practiceId: string): ReflectionVariant {
  const idx = stableHash(practiceId) % REFLECTION_VARIANTS.length
  // idx is always in range (modulo a non-empty pool); the ?? only satisfies the
  // index-access type — VARIANT_WELLBEING is never actually reached.
  return REFLECTION_VARIANTS[idx] ?? VARIANT_WELLBEING
}
