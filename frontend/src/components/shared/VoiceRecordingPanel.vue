<!--
  VELO Frontend -- VoiceRecordingPanel (voice input MVP, step 1)

  The composer field's stand-in while a voice take is live. Lives INSIDE the
  composer's glass field, in the textarea's geometry -- the row never changes
  shape (§5 of the task): [✕] [green pulsing dot + M:SS] ......... [⏹ disc].

  recording:  dot beats softly (opacity pulse, no layout animation), the
              stopwatch counts up tabular-nums; ✕ emits `cancel`, ⏹ `stop`.
  processing: the indicator group swaps to «Транскрибация…» + VLoader and BOTH
              buttons go disabled -- the row is honestly frozen until the
              caller produces a transcript or an error toast.

  `compact` mirrors the composer's capsule mode (single-line field): 36px
  discs instead of 44px, same 44px tappable skirt (FE-26 contract).

  Clicks STOP at this panel's root on purpose: the panel replaces the
  textarea inside the composer's clickable field, and a bubbling ✕/⏹ tap
  would reach the field's focus handler and raise the keyboard mid-take (the
  guard there can lose the race once the take's state has cleared).
-->

<template>
  <div
    class="voice-panel"
    :class="{ 'voice-panel--compact': compact }"
    data-testid="voice-panel"
    @click.stop
  >
    <button
      type="button"
      class="voice-panel__ghost"
      aria-label="Отменить запись"
      :disabled="!recording"
      data-testid="voice-cancel"
      @click="emit('cancel')"
    >
      <IconClose :size="compact ? 18 : 20" />
    </button>

    <div v-if="recording" class="voice-panel__indicators">
      <span class="voice-panel__dot" aria-hidden="true" />
      <span class="voice-panel__time" data-testid="voice-elapsed">
        {{ formattedTime }}
      </span>
    </div>
    <div v-else class="voice-panel__indicators" data-testid="voice-busy">
      <span class="voice-panel__busy">Транскрибация…</span>
      <VLoader size="sm" />
    </div>

    <button
      type="button"
      class="voice-panel__disc"
      aria-label="Завершить запись"
      :disabled="!recording"
      data-testid="voice-stop"
      @click="emit('stop')"
    >
      <IconStop :size="compact ? 16 : 18" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IconClose, IconStop } from '@/components/icons'
import { VLoader } from '@/components/ui'
import { formatStopwatch } from '@/utils/audio'

const props = withDefaults(
  defineProps<{
    /** Live phase: recording shows the dot/stopwatch, processing the busy row. */
    state: 'recording' | 'processing'
    elapsedSec: number
    /** Composer's capsule mode -- 36px discs on the slim single-line band. */
    compact?: boolean
  }>(),
  { compact: false },
)

const emit = defineEmits<{
  cancel: []
  stop: []
}>()

const recording = computed(() => props.state === 'recording')
const formattedTime = computed(() => formatStopwatch(props.elapsedSec))
</script>

<style scoped>
.voice-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* Fills the textarea's band: the field's own min-height keeps the row, the
     panel only centres inside it -- zero geometry change on mount/unmount. */
  align-self: stretch;
}

.voice-panel__ghost,
.voice-panel__disc {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

/* Capsule mode: the 36px discs the single-line composer uses, with the same
   -4px invisible skirt growing the tap target back to 44px (FE-26). */
.voice-panel--compact .voice-panel__ghost,
.voice-panel--compact .voice-panel__disc {
  width: 36px;
  height: 36px;
}

.voice-panel--compact .voice-panel__ghost::after,
.voice-panel--compact .voice-panel__disc::after {
  content: '';
  position: absolute;
  inset: -4px;
}

/* [FE-26 kept] the skirt is pure hit area on an already-positioned element. */
.voice-panel--compact .voice-panel__ghost,
.voice-panel--compact .voice-panel__disc {
  position: relative;
}

/* ✕: a bare glyph, no filled disc -- the stop control is THE disc of this
   row, matching the composer's send/mic disc language. */
.voice-panel__ghost {
  background: transparent;
  color: var(--velo-text-secondary);
}

.voice-panel__disc {
  margin-left: auto;
  background: var(--velo-nav-active-bg);
  color: var(--velo-white);
  position: relative;
  z-index: 1;
}

.voice-panel__ghost:disabled,
.voice-panel__disc:disabled {
  opacity: 0.5;
  cursor: default;
}

.voice-panel__indicators {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* Green "recording" dot: soft opacity pulse only -- nothing moves, nothing
   re-lays-out. Teal-600 is the readable green of the success family. */
.voice-panel__dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--velo-teal-600);
  animation: voice-panel-dot-pulse 1.6s ease-in-out infinite;
}

@keyframes voice-panel-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.voice-panel__time {
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-primary);
  /* The stopwatch must not breathe with digit changes. */
  font-variant-numeric: tabular-nums;
}

.voice-panel__busy {
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
