/**
 * Dead allowlist entries (FE-240): after a layout sweep, an entry of
 * LAYOUT_ALLOWLIST that could have applied to a judged screen (its route,
 * width and skin) and accepted no finding there anywhere fails the run. The
 * finding it was written for is gone; the entry would now hide the next
 * one. Each judged screen attaches what it used (checkLayout in ./layout.ts).
 *
 * Only a whole run can tell an entry is dead -- a `-g` subset has not seen
 * its screens -- so the check runs in CI (CI set) or when asked
 * (LAYOUT_ALLOWLIST_CHECK=1).
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { deadAllowances, type AllowlistUse } from './layout-allowance'
import { LAYOUT_ALLOWLIST } from './layout-allowlist'

/** Name of the attachment checkLayout writes (ALLOWLIST_ATTACHMENT of ./layout.ts). */
const ATTACHMENT = 'layout-allowlist.json'

export default class LayoutReporter implements Reporter {
  private uses: AllowlistUse[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    // The layout sweep only: a self-check judges one screen, not the table.
    if (!test.parent.project()?.name.startsWith('sweep-layout-')) return
    for (const a of result.attachments) {
      if (a.name === ATTACHMENT && a.body)
        this.uses.push(JSON.parse(a.body.toString()) as AllowlistUse)
    }
  }

  onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    return Promise.resolve(this.verdict(result))
  }

  /** The run's status when a dead entry turns it red; undefined -- no change. */
  private verdict(result: FullResult): { status?: FullResult['status'] } | undefined {
    if (!process.env.CI && !process.env.LAYOUT_ALLOWLIST_CHECK) return undefined
    if (this.uses.length === 0) return undefined
    const dead = deadAllowances(LAYOUT_ALLOWLIST, this.uses)
    if (dead.length === 0) return undefined
    console.log(
      `\nLayout allowlist: ${dead.length} entr${dead.length === 1 ? 'y' : 'ies'} accepted nothing in this run -- remove (e2e/support/layout-allowlist.ts):`,
    )
    for (const i of dead) {
      const a = LAYOUT_ALLOWLIST[i]!
      console.log(
        `  [${i}] ${a.task} ${a.rules.join(',')}${a.element ? ` ${String(a.element)}` : ''}`,
      )
    }
    return { status: result.status === 'passed' ? 'failed' : result.status }
  }

  printsToStdio(): boolean {
    return false
  }
}
