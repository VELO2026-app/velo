<!--
  VELO Frontend -- VeloLogo Component (DS-6)

  Uses the actual VELΘ mandala logo from Design_prototype.
  Variants: default (colored/blue) and white.

  - default (colored): layered light composition -- mandala-blue.png ring +
    velo-word-blue.svg wordmark (#4C6589) on top, the word scaled 1.8x
    (operator-calibrated) so it matches the old lockup. Replaces the heavy
    logo.svg vector (191KB -> ~67KB) per operator 2026-06-12. logo.svg is kept
    as a file for non-component brand uses but is no longer referenced here.
    Future auth/onboarding screens that use VeloLogo inherit this automatically.
  - white: logo-white.svg, or a spinning ring (mandala-white.png + wordmark)
    when `spin` is set.

  Props:
    size    — width/height in px (default 64)
    variant — 'default' | 'white' (default 'default')
    spin    — white only: rotate the mandala ring slowly while the VELΘ wordmark
              stays static. Layers two sliced assets (mandala-white.png +
              velo-word-filled.svg) so the ring spins and the word does not.
              Motion (operator-tuned): still 0.5s -> ease-in ramp ~4s -> steady
              120s/rev. Respects prefers-reduced-motion.
-->

<template>
  <!-- Spinning white logo: rotating mandala ring under a static filled wordmark.
       The word sits at the ring centre, so rotating around the box centre keeps
       it perfectly still. -->
  <div
    v-if="spin && variant === 'white'"
    class="velo-logo velo-logo--spin"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <div class="velo-logo__intro">
      <div class="velo-logo__steady">
        <img
          class="velo-logo__layer velo-logo__mandala"
          src="/icons/mandala-white.png"
          alt=""
          aria-hidden="true"
        />
      </div>
    </div>
    <img class="velo-logo__layer velo-logo__word" src="/icons/velo-word-filled.svg" alt="VELΘ" />
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
      src="/icons/mandala-blue.png"
      alt=""
      aria-hidden="true"
    />
    <img
      class="velo-logo__layer velo-logo__word velo-logo__word--blue"
      src="/icons/velo-word-blue.svg"
      alt="VELΘ"
    />
  </div>
  <!-- White static logo. -->
  <img
    v-else
    src="/icons/logo-white.svg"
    :width="size"
    :height="size"
    alt="VELΘ"
    class="velo-logo"
  />
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number
    variant?: 'default' | 'white'
    /** White only: slowly rotate the mandala ring with the wordmark static. */
    spin?: boolean
  }>(),
  { size: 64, variant: 'default', spin: false },
)
</script>

<style scoped>
.velo-logo {
  display: block;
  object-fit: contain;
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
