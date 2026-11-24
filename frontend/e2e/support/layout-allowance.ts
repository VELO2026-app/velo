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
   * Brand skins it applies on (`goodo-brand`), as the CI job names its skin
   * in E2E_SKIN; absent -- every skin. A run with no skin named gets none of
   * these entries.
   */
  skins?: string[]
  /**
   * The smallest side it accepts, CSS px -- required with `small-target`: a
   * control smaller than that is still a finding, the entry covers the sizes
   * the task is about, not any size at all.
   */
  minSide?: number
}

/** A task key of the teams that own a fix. */
const TASK = /^(FE|BE|DSGN|PM)-\d+$/

/**
 * Throw on an entry without a task key or a reason, or a small-target entry
 * without its smallest side (run at import of the allowlist).
 */
export function checkAllowances(allowances: readonly LayoutAllowance[]): void {
  for (const a of allowances) {
    if (!TASK.test(a.task)) throw new Error(`layout allowlist: "${a.task}" is not a task key`)
    if (!a.reason.trim()) throw new Error(`layout allowlist: ${a.task} has no reason`)
    if (a.rules.includes('small-target') && a.minSide === undefined) {
      throw new Error(`layout allowlist: ${a.task} accepts small-target without minSide`)
    }
  }
}

/** What one judged screen reported about the allowlist (a test attachment). */
export interface AllowlistUse {
  route: string
  width: number
  skin: string | undefined
  /** Indexes of the entries that accepted a finding there. */
  used: number[]
}

/** Whether entry `a` could have applied to the screen of `use`. */
function applies(a: LayoutAllowance, use: AllowlistUse): boolean {
  return (
    (!a.routes || a.routes.includes(use.route)) &&
    (!a.widths || a.widths.includes(use.width)) &&
    (!a.skins || (use.skin !== undefined && a.skins.includes(use.skin)))
  )
}

/**
 * The entries a run could have used and did not: a fixed finding whose
 * entry stayed behind. Indexes into `allowances`.
 */
export function deadAllowances(
  allowances: readonly LayoutAllowance[],
  uses: readonly AllowlistUse[],
): number[] {
  return allowances.flatMap((a, i) => {
    const scope = uses.filter((u) => applies(a, u))
    return scope.length > 0 && !scope.some((u) => u.used.includes(i)) ? [i] : []
  })
}
