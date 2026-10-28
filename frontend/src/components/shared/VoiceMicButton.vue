<!--
  VELO Frontend -- VoiceMicButton (voice input, step 2: FE-94)

  The mic disc that opens a voice take on a FIELD (VTextarea, the diary
  entry editor) -- the same Telegram-style disc the composer's own mic is:
  44px, --velo-nav-active-bg, white glyph. Step 2's one deliberate difference
  from the composer's mic: the caller renders it while text is present too,
  because a field transcript APPENDS (§11 appendTranscript) instead of
  replacing an empty field -- visibility is the CALLER's rule, this component
  is only the disc.

  No declared emits on purpose: the single root button receives the parent's
  @click natively (attribute fallthrough), exactly like a plain <button>.
  The parent v-ifs the disc away for the whole span of a take, so no disabled
  state is needed here.
-->

<template>
  <button
    type="button"
    class="voice-mic"
    :aria-label="t('composer.voiceAria')"
    data-testid="voice-mic"
  >
    <IconMic :size="20" />
  </button>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { IconMic } from '@/components/icons'
</script>

<style scoped>
.voice-mic {
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
  background: var(--velo-nav-active-bg);
  color: var(--velo-white);
  transition: opacity var(--transition-fast);
}

.voice-mic:hover {
  opacity: 0.85;
}
</style>
