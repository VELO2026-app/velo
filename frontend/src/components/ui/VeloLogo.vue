<!--
  VELO Frontend -- VeloLogo Component (DS-6)

  The logo images come from the skin package on fixed /icons/ paths
  (utils/skinAssets.ts); the core ships neutral ones there (a ring and a dot,
  FE-230). The layer offsets below were calibrated on the golden VELO
  lockup (velo-brand): a ring PNG with a wordmark SVG on top.
  Variants: default (dark) and white.

  - default: layered composition -- mandala-blue.png ring + velo-word-blue.svg
    wordmark on top, the word scaled 1.8x (operator-calibrated).
  - white: logo-white.svg, or a spinning ring (mandala-white.png + wordmark)
    when `spin` is set.
  - icon: the brand's app icon (favicon.svg) in place of the logo set -- when
    the skin package has no logo set, or when the caller is the support
    conversation's mark (`supportMark`) and the skin's `supportMark` setting is
    'icon' (FE-261).

  Props:
    size     — width/height in px (default 64)
    variant  — 'default' | 'white' (default 'default')
    spin     — white only: rotate the mandala ring slowly while the VELΘ wordmark
               stays static. Layers two sliced assets (mandala-white.png +
               velo-word-filled.svg) so the ring spins and the word does not.
               Motion (operator-tuned): still 0.5s -> ease-in ramp ~4s -> steady
               120s/rev. Respects prefers-reduced-motion.
    supportMark — this logo is the support conversation's mark. The skin's
               `supportMark` setting (brand record, contract 2.2) decides what
               it shows: 'logo' (the default; the golden VELO skin) keeps the
               logo set like every other place, 'icon' (Goodo) draws the brand
               icon. Splash, Welcome and auth never pass it, so they keep the
               logo. The icon takes the icon branch, so `spin` is ignored (the
               icon is static) and `variant` only sets the icon's side: the
               whole box for 'default', a third of it for 'white'. Pass the
               default variant for a mark that fills its box.
-->

<template>
  <!-- No logo set in the skin package (contract 2.1, FE-230), or the support
       mark of a skin that asks for the icon (`supportMark`, FE-261): the
       brand's app icon stands in, static. The white variant is the splash's
       oversized bleed box, so the icon takes a third of it and the layout
       keeps its Y. -->
  <div
    v-if="showIcon"
    class="velo-logo velo-logo--icon"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <img
      class="velo-logo__icon"
      :src="SKIN_IMAGE.favicon"
      :width="iconSize"
      :height="iconSize"
      :alt="t('common.brandName')"
    />
  </div>
  <!-- Spinning white logo: rotating mandala ring under a static filled wordmark.
       The word sits at the ring centre, so rotating around the box centre keeps
       it perfectly still. -->
  <div
    v-else-if="spin && variant === 'white'"
    class="velo-logo velo-logo--spin"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <div class="velo-logo__intro">
      <div class="velo-logo__steady">
        <img
          class="velo-logo__layer velo-logo__mandala"
          :src="SKIN_IMAGE.mandalaWhite"
          alt=""
          aria-hidden="true"
        />
      </div>
    </div>
    <img
      class="velo-logo__layer velo-logo__word"
      :src="SKIN_IMAGE.wordFilled"
      :alt="t('common.brandName')"
    />
  </div>
  <!-- Colored/blue logo: layered light composition (PNG ring + dark wordmark on
       top). Mirrors the spin layering, static, with the word scaled to match the
       old logo.svg lockup. -->
  <div
    v-else-if="variant === 'default'"
    class="velo-logo velo-logo--blue"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <img
      class="velo-logo__layer velo-logo__mandala"
      :src="SKIN_IMAGE.mandalaBlue"
      alt=""
      aria-hidden="true"
    />
    <img
      class="velo-logo__layer velo-logo__word velo-logo__word--blue"
      :src="SKIN_IMAGE.wordBlue"
      :alt="t('common.brandName')"
    />
  </div>
  <!-- White static logo. -->
  <img
    v-else
    :src="SKIN_IMAGE.logoWhite"
    :width="size"
    :height="size"
    :alt="t('common.brandName')"
    class="velo-logo"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { SKIN_HAS_LOGO, SKIN_SUPPORT_MARK } from 'virtual:skin-brand'
import { t } from '@/locales'
import { SKIN_IMAGE } from '@/utils/skinAssets'

const props = withDefaults(
  defineProps<{
    size?: number
    variant?: 'default' | 'white'
    /** White only: slowly rotate the mandala ring with the wordmark static. */
    spin?: boolean
    /**
     * This logo is the support conversation's mark: it follows the skin's
     * `supportMark` setting ('icon' draws the brand's app icon, 'logo' keeps
     * the logo set). The icon takes the icon branch: `spin` is ignored, and
     * `variant` only sets the icon's side (the whole box, or a third of it
     * for `white`).
     */
    supportMark?: boolean
  }>(),
  { size: 64, variant: 'default', spin: false, supportMark: false },
)

/** The brand's app icon stands in for the logo set: the package ships none,
 *  or this is the support mark and the skin wants the icon there. */
const showIcon = computed(
  () => !SKIN_HAS_LOGO || (props.supportMark && SKIN_SUPPORT_MARK === 'icon'),
)

/** The stand-in icon's side: the whole box, a third of the splash's bleed box. */
const iconSize = computed(() =>
  props.variant === 'white' ? Math.round(props.size / 3) : props.size,
)
</script>

<style scoped>
.velo-logo {
  display: block;
  object-fit: contain;
}

.velo-logo--icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.velo-logo--spin,
.velo-logo--blue {
  position: relative;
}

.velo-logo__layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

/* Operator-calibrated layer offsets (see .handoff preview, calibrated at size 440).
   Expressed as % of the layer (= % of `size`) so they scale with any size.
   The mandala offset sits on the IMG inside the spinning wrappers, so it rotates
   rigidly with the ring -- this places the mandala's visual centre on the rotation
   axis, keeping it spinning in place (px@440: x +8, y -3). */
.velo-logo__mandala {
  transform: translate(1.818%, -0.682%);
}

.velo-logo__word {
  z-index: 2;
  /* px@440: x +1, y -7 */
  transform: translate(0.227%, -1.591%);
}

/* Blue (default) wordmark: same centring as the white word, scaled 1.8x so the
   "VELΘ" lockup matches the old logo.svg proportions (operator 2026-06-12). */
.velo-logo__word--blue {
  transform-origin: 50% 50%;
  transform: translate(0.227%, -1.591%) scale(1.8);
}

.velo-logo__intro,
.velo-logo__steady {
  position: absolute;
  inset: 0;
  transform-origin: 50% 50%;
}

/* Stand still 0.5s -> ease-in ramp 4s (one-shot, holds 6deg) -> steady spin
   120s/rev (starts right after the ramp). The ramp ends near the steady angular
   velocity, so the hand-off has no visible jolt. */
.velo-logo__intro {
  animation: velo-logo-intro 4s cubic-bezier(0.45, 0, 0.9, 0.85) 0.5s 1 forwards;
}

.velo-logo__steady {
  animation: velo-logo-steady 120s linear 4.5s infinite;
}

@keyframes velo-logo-intro {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(6deg);
  }
}

@keyframes velo-logo-steady {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Accessibility: no spin for users who prefer reduced motion. */
@media (prefers-reduced-motion: reduce) {
  .velo-logo__intro,
  .velo-logo__steady {
    animation: none;
  }
}
</style>
