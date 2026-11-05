<!--
  VELO Frontend -- VFieldError Component (owner TZ 2026-11-01:
  required-field errors with no reserved space and no layout jumps)

  The ONE app-wide error line for form fields. Closed it occupies exactly
  0px (no constant-height reserve); open it expands smoothly and the fields
  below it settle softly, instead of the old v-if jump.

  Technique: the row is a 0fr→1fr grid track transition (NOT v-if/display:none
  — that jumps; NOT max-height — that lags), so height and fade ride the same
  clock. While it collapses the LAST shown message stays in the DOM (`shown`)
  so the text does not vanish before the animation ends; a closed row is
  aria-hidden, so the stale text never reaches assistive tech. The caller's
  aria-describedby binding is dropped together with the error, per contract.

  Tokens only: the collapse speed is --velo-dur-base + --velo-ease-out. In
  reduced motion the transition is cut entirely (instant open/close), the same
  component-level override shape MoodSlider/VSkeleton use -- the root reduced
  motion block only shortens durations to 120ms, which still moves layout.

  Usage:
    <VFieldError :message="errors.title" :id="`err-title`" />
    <VFieldError :message="errors.privacy" size="lg" />
-->

<template>
  <div
    class="v-field-error"
    :class="{ 'v-field-error--open': !!message, 'v-field-error--lg': size === 'lg' }"
    :aria-hidden="message ? undefined : 'true'"
  >
    <div class="v-field-error__inner">
      <p :id="id" class="v-field-error__text" role="alert" aria-live="polite">{{ shown }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  /** Current error text; falsy collapses the row to exactly 0px. */
  message?: string | null
  /** Put on the text node so a control can aria-describedby it. */
  id?: string
  /** `lg` — the fs-16 error line (MasterApplyView's two slots keep their size). */
  size?: 'md' | 'lg'
}>()

// Hold the last non-empty message: while the row collapses the text must still
// be in the DOM to animate its height, otherwise it would blink away instantly.
const shown = ref(props.message ?? '')
watch(
  () => props.message,
  (m) => {
    if (m) shown.value = m
  },
)
</script>

<style scoped>
.v-field-error {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  /* --velo-dur-base (260ms) over --velo-dur-fast: the row is a content
     fade-in (the DS's own token semantic), and the owner asked for a visibly
     softer settle than the 180ms first cut. */
  transition:
    grid-template-rows var(--velo-dur-base) var(--velo-ease-out),
    opacity var(--velo-dur-base) var(--velo-ease-out);
}

.v-field-error--open {
  grid-template-rows: 1fr;
  opacity: 1;
}

/* The collapse target: min-height:0 lets the 0fr track actually reach 0px.
   Everything visual (the gap above the text included) lives INSIDE, so the
   closed state is exactly 0px — no leftover sliver of spacing. */
.v-field-error__inner {
  min-height: 0;
  overflow: hidden;
}

.v-field-error__text {
  margin: 0;
  padding-top: var(--space-1);
  font-size: var(--velo-fs-14);
  line-height: 1.2;
  color: var(--velo-error);
}

.v-field-error--lg .v-field-error__text {
  font-size: var(--velo-fs-16);
}

/* WCAG 2.3.3: no movement at all — open/close is instant, not the shortened
   crossfade the root reduced-motion block leaves on --velo-dur-fast. */
@media (prefers-reduced-motion: reduce) {
  .v-field-error {
    transition: none;
  }
}
</style>
