/**
 * VELO Frontend -- Floating header island (G-1)
 *
 * Lets a screen's header (VHeader, or a tab screen's heading like the dashboard
 * greeting / calendar title+weekstrip) float as an island ABOVE the scrollable,
 * fog-masked content instead of scrolling inside it. The header lives in the DOM
 * inside the view (rendered into MobileLayout's masked __main), so a CSS mask
 * alone cannot exempt it. The fix: the header teleports itself into an island
 * layer that MobileLayout renders OUTSIDE __main.
 *
 * MobileLayout MEASURES the island's height (ResizeObserver) and clears exactly
 * that much at the top of the feed, so any island content (short greeting or a
 * tall title+weekstrip) gets the right fog clearance automatically.
 *
 * `Provider  -> MobileLayout` (renders the island host + measures it)
 * `Consumer  -> VHeader`, and tab views that want their heading to float
 *
 * When no provider is up the tree (shell-less screens, the admin layout), the
 * consumer reports `false` and renders its header inline, exactly as before.
 */
import { inject, provide, type InjectionKey } from 'vue'

const KEY: InjectionKey<boolean> = Symbol('velo-floating-header')

/** Called by the layout that hosts the island (MobileLayout). */
export function provideFloatingHeader(): void {
  provide(KEY, true)
}

/**
 * Called by a header/heading. Returns true when a floating island host exists
 * (teleport into it); `false -> render inline`.
 */
export function useFloatingHeader(): boolean {
  return inject(KEY, false)
}
