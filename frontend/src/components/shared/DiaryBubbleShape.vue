<!--
  VELO Frontend -- DiaryBubbleShape (Diary thread, screen 40 "map")

  The EXACT organic card silhouette from the Figma reference (Union.svg,
  267 x 47): one continuous vector shape -- a circular lobe (~46.6px) joined
  to a capsule through TWO true concave neck transitions. It is NOT a pill
  with a circle pasted on: such a CSS union loses the concavities and cannot
  show the patterned page background through the neck.

  This component owns ONLY the white background silhouette:
    side="left"  -- lobe on the left  (Check-in);
    side="right" -- the exact horizontal mirror, lobe on the right (Feedback;
                    ONLY the SVG flips, never the host card's content).
  Icon, text and tap behaviour belong to the host (DiaryThreadCard).

  Rendering contract: native 267x47 (never preserveAspectRatio="none" -- the
  lobe must not become an ellipse), absolutely positioned under the content,
  fill=currentColor (the host paints it white), no stroke/shadow,
  pointer-events:none + aria-hidden (the host button carries the label).
-->

<template>
  <svg
    class="bubble"
    :class="{ 'bubble--mirrored': side === 'right' }"
    width="267"
    height="47"
    viewBox="0 0 267 47"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M243.103 0C255.939 0 266.347 10.4063 266.347 23.2432C266.347 36.0801 255.939 46.4863 243.103 46.4863H81.7666C74.2717 46.4863 67.6061 42.9388 63.3562 37.4314C60.683 33.9673 56.9488 31.0547 52.5732 31.0547C48.1866 31.0547 44.4456 33.9808 41.7745 37.4604C37.5175 43.0059 30.8215 46.5811 23.29 46.5811C10.4273 46.5808 0 36.1529 0 23.29C0.000245341 10.4274 10.4274 0.000245326 23.29 0C31.4225 0 38.5811 4.16834 42.7466 10.485C44.9985 13.8997 48.4505 16.7217 52.5409 16.7217C56.6365 16.7217 60.0913 13.8925 62.3445 10.4723C66.5005 4.16373 73.647 6.21446e-05 81.7666 0H243.103Z"
      fill="currentColor"
    />
  </svg>
</template>

<script setup lang="ts">
defineProps<{
  /** Which side carries the circular lobe: Check-in left, Feedback right. */
  side: 'left' | 'right'
}>()
</script>

<style scoped>
.bubble {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  pointer-events: none;
}

/* Exact horizontal reflection inside the same 267px box: scaleX(-1) around
   the left edge maps x -> -x, translateX(267px) folds it back into place. */
.bubble--mirrored {
  transform: translateX(267px) scaleX(-1);
  transform-origin: left top;
}
</style>
