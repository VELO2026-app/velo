<!--
  VELO Frontend -- ResultScreen (shared, DS)

  Full-bleed white "takeover" state shown instead of a screen's content:
  success confirmations (Check-in отправлен / Спасибо за feedback) and the
  sold-out state (Места закончились). One canon for every full-white user
  result screen — extracted from the former .form-shell-success / .sold-out
  duplicates.

  Layout: centred icon + title + optional text + actions, on a solid white
  surface that covers the WHOLE app frame.

  Full-bleed fix: position:fixed covering the full viewport HEIGHT (so the
  white reaches the very top, under the Telegram chrome / safe-area — the old
  absolute-over-mobile-layout left a fog strip at the top), but WIDTH is bound
  to --velo-screen-width and centred, so on wide viewports the white never
  spills into the photo gutters outside the centred app frame.

  Slots:
    #icon    -- the illustration / glyph (SVG or emoji).
    #actions -- the buttons / links row.
  Props:
    title    -- heading.
    text     -- optional body line under the title.
-->

<template>
  <div class="result-screen">
    <div class="result-screen__icon">
      <slot name="icon" />
    </div>
    <h1 class="result-screen__title">{{ title }}</h1>
    <p v-if="text" class="result-screen__text">{{ text }}</p>
    <div class="result-screen__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  text?: string
}>()
</script>

<style scoped>
.result-screen {
  /* Full viewport HEIGHT (reaches the top under the chrome), but width bound to
     the centred app frame so the white never spills into the side gutters. */
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--velo-screen-width);
  z-index: var(--z-modal);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Horizontal padding = --velo-screen-padding (33) so the 32px title fits one line. */
  padding: var(--space-5) var(--velo-screen-padding);
  text-align: center;
  background: var(--velo-bg-card-solid);
  overflow-y: auto;
}

.result-screen__icon {
  /* font-size sizes an emoji fallback; an SVG slot sizes itself. */
  font-size: var(--size-success-icon);
  margin-bottom: var(--space-5);
}

.result-screen__title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-32);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-bottom: var(--space-3);
}

.result-screen__text {
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-8);
  max-width: 280px;
}

.result-screen__actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  max-width: var(--velo-content-width);
}
</style>
