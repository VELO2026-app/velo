import { keyboardOpen } from './useViewportGeometry'

/**
 * Reactive "is the on-screen keyboard open" flag.
 *
 * PROMPT №657 (rebuild): this used to own its own visualViewport listener and
 * its own copy of the native/browser delta decision. Both moved to
 * useViewportGeometry.ts, the one place that now reads live viewport signals
 * -- this is a thin re-export of its shared `keyboardOpen` ref so existing
 * call sites (UserShell.vue, MasterShell.vue: `const { keyboardOpen } =
 * useKeyboardOpen()`) need no changes. useViewportGeometry() is mounted once
 * from App.vue; this function does not mount anything itself.
 *
 * Used to hide the floating bottom tab bar while typing, so it does not ride
 * up and overlap a focused input (e.g. BookingConfirmedView's "запрос
 * мастеру").
 */
export function useKeyboardOpen() {
  return { keyboardOpen }
}
