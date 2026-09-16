// =============================================================================
// VELO Frontend -- keyboard/viewport at-rest reset (dancing-bg #4, item 6)
// =============================================================================
//
// Resets the keyboard-driven viewport state written by useBackgroundStabilizer
// back to its at-rest values. Called on stabilizer unmount AND synchronously on
// every route change, so a freshly-navigated screen never inherits the previous
// screen's shift / fog geometry (the between-screens "fog lag", item 6). If the
// keyboard is genuinely still open, the next visualViewport event re-syncs truth.
//
// Router-free (no Vue / router import) so it is trivially unit-testable and
// carries no dependency weight.
// =============================================================================

/**
 * Restore the at-rest keyboard-layout state the stabilizer publishes: no
 * `is-keyboard-open` class, cleared `--velo-vvh`. These are exactly the values a
 * screen has when no keyboard is open, so calling this on an at-rest navigation is
 * a no-op (absent class, ''→''). No-op under SSR (no document).
 *
 * (Batch K: the bg is now decoupled structurally — no `--velo-bg-shift` /
 * `is-field-focused` to reset anymore.) Host access goes through @/platform/dom.
 */
import { removeRootClass, setRootStyleProperty } from '@/platform/dom'
export function resetKeyboardViewportState(): void {
  removeRootClass('is-keyboard-open')
  setRootStyleProperty('--velo-vvh', '')
}
