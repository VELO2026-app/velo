<!--
  VELO Frontend -- VBackButton (unified design-system back button)

  ONE back button for every screen: a white 44x44 CIRCLE with a single
  mirrored arrow glyph (icon-only, no text), dead-centred. Navigation stays
  in the caller -- this component only emits `click`; wire it to
  router.back() or a custom handler at the call site.

  [FE-42] Owner amendment: round EVERYWHERE, not just the diary -- the former
  63x40 pill is retired DS-wide. One step taller than the pill's 40 (the
  --velo-size-48 token); the tappable zone is the button itself (48 >= the
  44px touch floor). VMoreLink keeps its own 63x40 pill on purpose -- that is
  a forward-link with a text label, a different canon, not the back button.

  [FE-42, round 2] Owner: the corner radius is slightly LESS than a circle --
  the same radius the RIGHT button (the composer's 44px send disc) has: 22px,
  i.e. half of --velo-size-44. On the 48 box that reads as a soft squircle,
  2px shy of the full circle.

  [FE-42, round 3] Owner's final geometry, supersedes the 48px (round 1) and
  the 22px-squircle (round 2): a 44px CIRCLE -- the exact geometry of the
  composer's send disc (--velo-size-44 + --radius-full). Same size, same
  rounding as the right button; taller than the retired pill's 40.

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
  /* [FE-42, round 3] A 44px CIRCLE -- the exact geometry of the composer's
     send disc: --velo-size-44 box + --radius-full. Arrow centring is the
     flex pair above; the tappable zone is the button itself (44 = the touch
     floor). */
  width: var(--velo-size-44);
  height: var(--velo-size-44);
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
