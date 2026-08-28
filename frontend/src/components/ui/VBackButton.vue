<!--
  VELO Frontend -- VBackButton (unified design-system back button)

  ONE back button for every screen: a white pill, 63x40, fully rounded, with a
  single mirrored arrow glyph (icon-only, no text). Navigation stays in the
  caller -- this component only emits `click`; wire it to router.back() or a
  custom handler at the call site.

  Usage:
    <VBackButton @click="router.back()" />
    <VBackButton aria-label="Выйти из дневника" @click="exitDiary" />
-->

<template>
  <button type="button" class="v-back" :aria-label="ariaLabel" @click="$emit('click')">
    <IconArrowRight :size="18" class="v-back__arrow" />
  </button>
</template>

<script setup lang="ts">
import { IconArrowRight } from '@/components/icons'

withDefaults(
  defineProps<{
    /** Accessible label; navigation is the caller's, this is just the control. */
    ariaLabel?: string
  }>(),
  { ariaLabel: 'Назад' },
)

defineEmits<{ click: [] }>()
</script>

<style scoped>
.v-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 63px;
  height: var(--velo-size-40);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
  position: relative;
}

/* [FE-26] 44px touch-target bar: the pill STAYS 63x40 visually (it floats in
   the MobileLayout island -- growing it would shift the island's measured
   geometry, which three FE-3 rounds tuned); only the tappable zone grows,
   +2px above/below via an invisible overlay. Width is already >= 44. Same
   hit-area-overlay pattern as VModal close / VSwitch / VCheckbox. */
.v-back::after {
  content: '';
  position: absolute;
  inset: -2px 0;
}

.v-back:hover,
.v-back:active {
  opacity: 0.85;
}

/* The only arrow glyph is a right arrow -- mirror it to point back. */
.v-back__arrow {
  transform: scaleX(-1);
}
</style>
