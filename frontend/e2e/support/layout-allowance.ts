/**
 * The layout detector's contract types (FE-240), in a module of their own:
 * layout-allowlist.ts needs LayoutAllowance and layout.ts imports the
 * allowlist, so the types cannot live in layout.ts without an import cycle
 * (the same split as allowance.ts for the crash detector).
 */

/** One kind of layout breakage (the rules are described in layout-scan.ts). */
export type LayoutRule =
  'overflow' | 'overlap' | 'small-target' | 'covered-target' | 'tabbar' | 'safe-area'

/**
 * An accepted finding: as narrow as the case, with the task that fixes it.
 * checkAllowances() refuses an entry without both.
 */
export interface LayoutAllowance {
  /** The task that fixes it or decides it, `FE-123`. */
  task: string
  /** Why the finding is accepted until then. */
  reason: string
  rules: LayoutRule[]
  /** Sweep route names (e2e/sweep/routes.ts); absent -- every route. */
  routes?: string[]
  /** Matched against the finding's element description; absent -- any element. */
  element?: RegExp
  /** Widths it applies at; absent -- every width. */
  widths?: number[]
  /**
   * `small-target` only: the smallest side it accepts, CSS px. A control
   * smaller than that is still a finding: the entry covers the sizes the
   * task is about, not any size at all.
   */
  minSide?: number
}

/** A task key of the teams that own a fix. */
const TASK = /^(FE|BE|DSGN|PM)-\d+$/

/** Throw on an entry without a task key or a reason (run at import of the allowlist). */
export function checkAllowances(allowances: readonly LayoutAllowance[]): void {
  for (const a of allowances) {
    if (!TASK.test(a.task)) throw new Error(`layout allowlist: "${a.task}" is not a task key`)
    if (!a.reason.trim()) throw new Error(`layout allowlist: ${a.task} has no reason`)
  }
}
