/**
 * VELO Frontend -- useLoadingHold door (FE-143 pattern; P8 batch 5)
 *
 * The delayed-flag loading rule (nothing shows before the 300 ms delay, a
 * seen placeholder stays at least 450 ms) moved into `@velo/ui` with its
 * consumer VLoadingSwap. This module stays as the door for the screen-side
 * consumers (the kit has no opinions about screens): every `useLoadingHold`
 * / `useDelayedFlag` call resolves through the kit via this exact-barrel
 * door -- the same shape as composables/useKeyboardFieldScroll.ts, the app
 * half of the keyboard seam.
 *
 * Usage:
 *   `import { useLoadingHold } from '@/composables/useLoadingHold'`
 */
export { useDelayedFlag, useLoadingHold, LOADING_DELAY_MS, LOADING_MIN_DURATION_MS } from '@velo/ui'
export type { DelayedFlagOptions, LoadingHold } from '@velo/ui'
