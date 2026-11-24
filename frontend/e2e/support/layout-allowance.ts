/**
 * The layout detector's contract types (FE-240), in a module of their own:
 * layout-allowlist.ts needs LayoutAllowance and layout.ts imports the
 * allowlist, so the types cannot live in layout.ts without an import cycle
 * (the same split as allowance.ts for the crash detector).
 */

/** One kind of layout breakage (the rules are described in layout.ts). */
export type LayoutRule =
  'overflow' | 'overlap' | 'small-target' | 'covered-target' | 'tabbar' | 'safe-area'

/**
 * An accepted finding. `reason` is mandatory and names the task that fixes
 * it or why the geometry is right for this screen.
 */
export interface LayoutAllowance {
  reason: string
  rules: LayoutRule[]
  /** Sweep route names (e2e/sweep/routes.ts); absent -- every route. */
  routes?: string[]
  /** Matched against `LayoutFinding.element`; absent -- any element. */
  element?: RegExp
  /** Widths it applies at; absent -- every width. */
  widths?: number[]
}
