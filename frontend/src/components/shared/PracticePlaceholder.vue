<!--
  VELO Frontend -- PracticePlaceholder (shared)

  Themed banner shown in place of a real video stream on the practice screens
  (PracticeLiveView). One finished card per practice direction (the designer's
  SVGs: a centred white ring + direction glyph, the SAME glyph as a faint
  half-tone motif on the right, white glow). The card is selected by the
  practice's top-level `direction` tag.

  The 10 SVGs in @/assets/practice-cards keep the designer's geometry; the half-
  tone motif is baked into the artwork. The card color is NOT in the files
  (FE-230): they are transparent, and the card paints --velo-primary under
  them, so the skin sets the tone. Unknown / missing direction falls back to
  the meditation card.

  Props:
    direction -- PracticeDirection key (meditation … movement).
    title     -- optional practice title, used as the image alt text.

  Usage:
    <PracticePlaceholder :direction="practice?.direction" :title="practice?.title" />
-->

<template>
  <img class="ph" :src="art" :alt="title ?? t('practice.placeholderAlt')" />
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import meditation from '@/assets/practice-cards/meditation.svg'
import yoga from '@/assets/practice-cards/yoga.svg'
import breathwork from '@/assets/practice-cards/breathwork.svg'
import somatic from '@/assets/practice-cards/somatic.svg'
import tantra from '@/assets/practice-cards/tantra.svg'
import circles from '@/assets/practice-cards/circles.svg'
import soundHealing from '@/assets/practice-cards/sound_healing.svg'
import artwork from '@/assets/practice-cards/art.svg'
import narrative from '@/assets/practice-cards/narrative.svg'
import movement from '@/assets/practice-cards/movement.svg'

const props = withDefaults(
  defineProps<{
    direction?: string | null
    title?: string | null
  }>(),
  { direction: null, title: null },
)

// One finished card per top-level direction tag (keys match PracticeDirection).
const ART: Record<string, string> = {
  meditation,
  yoga,
  breathwork,
  somatic,
  tantra,
  circles,
  sound_healing: soundHealing,
  art: artwork,
  narrative,
  movement,
}

const art = computed(() => ART[props.direction ?? ''] ?? ART.meditation)
</script>

<style scoped>
/* The SVG art is the 336x199 card (centred ring + direction glyph + faint
   half-tone motif) on a transparent ground; the card color is the token
   below, under the same rounded corners the art clips to. The white glow is NO LONGER baked into the SVG — it comes
   from the --velo-shadow-glow DS token here, so the glow is controlled centrally
   (one token -> all cards). Rounded to --radius-md so the glow hugs the corners. */
.ph {
  display: block;
  width: 100%;
  max-width: var(--velo-content-width);
  height: auto;
  margin-inline: auto;
  border-radius: var(--radius-md);
  background-color: var(--velo-primary);
  box-shadow: var(--velo-shadow-glow);
}
</style>
