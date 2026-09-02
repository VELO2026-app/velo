<!--
  VELO Frontend -- VHeader Component (Phase F2.1, updated back-button design)

  Sticky top header. Matches mockup .header styles.

  Two back-button modes (per Figma DS, 2026-05-28):
    1. With separate title -> arrow-only compact pill (63×35), title sits next to it.
       Example: PracticeDetailView ("Моя практика" / "Практика").
    2. Without title -> arrow + backLabel inside the pill (e.g. "<- Check-in").
       Example: CheckinView / FeedbackView.

  Usage:
    <VHeader title="Дашборд" />                            -- title only
    <VHeader title="Моя практика" show-back @back="..." /> -- mode 1: arrow-only
    <VHeader show-back back-label="Check-in" @back="..." />-- mode 2: arrow + text
-->

<template>
  <!-- On screens hosted by a layout with a floating-header island (MobileLayout),
       teleport the header into that island so it floats ABOVE the masked feed
       instead of being eaten by the fog (G-1). Elsewhere (shell-less screens,
       admin) `floating` is false and it renders inline exactly as before. -->
  <Teleport defer to=".mobile-layout__island" :disabled="!floating">
    <header class="v-header" :class="{ 'v-header--floating': floating }">
      <div class="v-header__left">
        <VBackButton
          v-if="showBack"
          :aria-label="title ? 'Назад' : backLabel"
          @click="$emit('back')"
        />
        <h1 v-if="title" class="v-header__title">{{ title }}</h1>
        <span v-if="badge" class="v-header__badge">{{ badge }}</span>
      </div>
      <div v-if="$slots.action" class="v-header__right">
        <slot name="action" />
      </div>
    </header>
  </Teleport>
</template>

<script setup lang="ts">
import { VBackButton } from '@/components/ui'
import { useFloatingHeader } from '@/components/layout/useFloatingHeader'

// True when a floating-header island host (MobileLayout) is an ancestor: the
// header then teleports into the island and registers its presence (so the feed
// gets top clearance). False -> inline render, unchanged legacy behaviour.
const floating = useFloatingHeader()

withDefaults(
  defineProps<{
    title?: string
    showBack?: boolean
    backLabel?: string
    badge?: string | number
  }>(),
  {
    title: '',
    showBack: false,
    backLabel: 'Назад',
    badge: undefined,
  },
)

defineEmits<{
  back: []
}>()
</script>

<style scoped>
.v-header {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  background: transparent;
  min-height: 56px;
}

/* Floating island variant (G-1): teleported into MobileLayout's island layer, so
   it no longer scrolls inside the masked feed. Rail-aligned to --velo-rail-pad-x
   (= the content rail) with the diary's +20px top offset clearing the Telegram
   chrome. Click-through so the feed scrolls under the title; only the back button
   and the action slot catch taps (mirrors the diary header). */
.v-header--floating {
  position: static;
  z-index: auto;
  /* Top offset from the SHARED token (was a hand-rolled calc(space-3 + 20px)
     = the same 34px by value, but a separate source -- headered screens
     wouldn't move with --velo-fog-headerless-top changes; FE-48 sweep). The
     island's measured height adapts automatically (MobileLayout ResizeObserver);
     HEADER_FALLBACK (88, MobileLayout) still safely over-reserves the
     pre-measurement frame by the token's delta. */
  padding: var(--velo-fog-headerless-top) var(--velo-rail-pad-x) var(--space-3);
  pointer-events: none;
}

.v-header--floating :where(button, a, [role='button']),
.v-header--floating .v-header__right {
  pointer-events: auto;
}

.v-header__left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.v-header__title {
  font-family: var(--font-body);
  font-size: 18px;
  /* Slightly heavier to match the section-heading reset (operator 2026-06-17);
     Marmelad is single-weight, so 600 = the browser's synthesized heavier face. */
  font-weight: 600;
  color: var(--velo-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.v-header__badge {
  background: var(--velo-primary);
  color: var(--velo-white);
  font-size: var(--text-xs);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.v-header__right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
</style>
