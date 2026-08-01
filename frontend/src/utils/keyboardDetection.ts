// =============================================================================
// VELO Frontend -- keyboard-open detection (PROMPT №650, T24-1 fix)
// =============================================================================
//
// Pure arithmetic, no DOM/SDK dependency -- trivially unit-testable with
// synthetic values (same "router-free" convention as keyboardViewportState.ts).
//
// THE BUG THIS EXISTS TO FIX: the browser-only delta (layoutHeight -
// visualHeight, i.e. window.innerHeight - visualViewport.height) only
// detects the keyboard under the "overlay resize" model, where the visual
// viewport shrinks but the layout viewport (innerHeight) does not. On an
// Android WebView that does NOT honour index.html's
// interactive-widget=resizes-visual hint (older "Android System WebView"
// builds, or a host Activity using adjustResize), the keyboard shrinks the
// WebView's own rendering surface BEFORE the CSS engine ever sees it --
// window.innerHeight and visualViewport.height then move together, and
// their delta collapses toward 0. The browser-only check reports "no
// keyboard" even while one is genuinely open (useBackgroundStabilizer.ts's
// own header already documented this exact failure mode for a DIFFERENT
// piece of state -- this is the same platform quirk hitting keyboard
// detection instead).
//
// THE FIX: prefer a native delta when one is available (Telegram's own
// viewport.stableHeight - viewport.height, via @tma.js/sdk-vue -- see
// useBackgroundStabilizer.ts). Those values come from the Telegram HOST
// app, not the WebView's CSS engine, so they do not depend on whether the
// WebView correctly propagates a resize to visualViewport/innerHeight at
// all -- they survive exactly the failure mode above. Falls back to the
// browser delta only when no native signal exists (standalone/browser, or
// the Telegram viewport SDK never mounted) -- unchanged behaviour there.
// =============================================================================

/**
 * True if the on-screen keyboard should be treated as open.
 *
 * @param nativeDelta - Telegram's own (stableHeight - height), or null when
 *   no native signal is available (standalone, or the SDK viewport isn't
 *   mounted yet). Takes priority over the browser delta when present.
 * @param layoutHeight - window.innerHeight (the layout viewport).
 * @param visualHeight - visualViewport.height (the visual viewport).
 * @param threshold - KEYBOARD_VIEWPORT_THRESHOLD; a shrink past this many
 *   px is treated as "keyboard open".
 */
export function isKeyboardOpen(
  nativeDelta: number | null,
  layoutHeight: number,
  visualHeight: number,
  threshold: number,
): boolean {
  const delta = nativeDelta ?? layoutHeight - visualHeight
  return delta > threshold
}
