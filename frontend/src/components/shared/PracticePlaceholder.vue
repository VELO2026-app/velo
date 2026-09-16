<!--
  VELO Frontend -- PracticePlaceholder (shared)

  Themed banner shown in place of a real video stream on the practice screens
  (PracticeLiveView). One finished card per practice direction (the designer's
  SVGs: solid #627A9C card, a centred white ring + direction glyph, the SAME
  glyph as a faint half-tone motif on the right, white glow). The card is
  selected by the practice's top-level `direction` tag.

  The 10 SVGs in @/assets/practice-cards are used verbatim (not re-derived), so
  the banner is 1:1 with the design — the half-tone background is baked into the
  artwork. Unknown / missing direction falls back to the meditation card.

  Props:
    direction -- PracticeDirection key (meditation … movement).
    title     -- optional practice title, used as the image alt text.

  Usage:
    <PracticePlaceholder :direction="practice?.direction" :title="practice?.title" />
-->

<template>
  <img class="ph" :src="art" :alt="title ?? 'Практика'" />
</template>

<script setup lang="ts">
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
   half-tone motif). The white glow is NO LONGER baked into the SVG — it comes
   from the --velo-shadow-glow DS token here, so the glow is controlled centrally
   (one token -> all cards). Rounded to --radius-md so the glow hugs the corners. */
.ph {
  display: block;
  width: 100%;
  max-width: var(--velo-content-width);
  height: auto;
  margin-inline: auto;
  border-radius: var(--radius-md);
  box-shadow: var(--velo-shadow-glow);
}
</style>
