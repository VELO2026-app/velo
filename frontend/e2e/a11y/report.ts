/**
 * The accessibility run's report (FE-241): what axe found, what the allowlist
 * and the package's contrast exception covered, and which allowlist entries
 * covered nothing. Printed to the console, written to
 * `test-results/a11y-report.json`, appended to the step summary in GitHub
 * Actions.
 *
 * With A11Y_STRICT=1 (CI) an allowlist entry of this run's skin that covered
 * no finding in the whole run fails the run: the violation is gone, the entry
 * must go with it. A partial run (`-g`) must not set it: it would call every
 * entry unused.
 *
 * Reads the `a11y.json` attachment of each test (./a11y.spec.ts).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import { A11Y_ALLOWLIST } from './allowlist'
import {
  REPORT_ATTACHMENT,
  unusedAllowances,
  type Finding,
  type RouteReport,
  type SkinName,
} from './findings'

const MAX_LISTED = 60

export default class A11yReporter implements Reporter {
  private reports: RouteReport[] = []
  private outputDir = 'test-results'

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir ?? this.outputDir
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    const attached = result.attachments.find((a) => a.name === REPORT_ATTACHMENT)
    if (attached?.body) this.reports.push(JSON.parse(attached.body.toString()) as RouteReport)
  }

  async onEnd(): Promise<{ status: FullResult['status'] } | undefined> {
    const skin: SkinName | undefined = this.reports[0]?.skin
    if (!skin) return undefined

    const open = this.reports.flatMap((r) =>
      r.open.map((f) => ({ ...f, at: `[${r.role}] ${r.route}` })),
    )
    const waived = this.reports.reduce((n, r) => n + r.waived, 0)
    const coveredByEntry = new Map<number, number>()
    for (const r of this.reports)
      for (const [i, n] of r.covered) coveredByEntry.set(i, (coveredByEntry.get(i) ?? 0) + n)
    const byTask = new Map<string, number>()
    for (const [i, n] of coveredByEntry) {
      const task = A11Y_ALLOWLIST[i]?.task ?? '?'
      byTask.set(task, (byTask.get(task) ?? 0) + n)
    }
    const unused = unusedAllowances(A11Y_ALLOWLIST, this.reports, skin)
    const strict = process.env.A11Y_STRICT === '1'

    const covered = [...coveredByEntry.values()].reduce((a, b) => a + b, 0)
    const lines: string[] = [
      `### axe accessibility (${skin})`,
      '',
      `- screens judged: ${this.reports.length}`,
      `- open violations: ${open.length}`,
      `- covered by the allowlist: ${covered} (${[...byTask].map(([t, n]) => `${t}: ${n}`).join(', ') || 'none'})`,
      `- waived by the package's contrastExceptions: ${waived}`,
      `- allowlist entries that covered nothing: ${unused.length}${strict ? '' : ' (not enforced in this run)'}`,
    ]
    if (open.length > 0) {
      lines.push('', '**Open violations**', '')
      for (const f of open.slice(0, MAX_LISTED)) lines.push(`- ${format(f)}`)
      if (open.length > MAX_LISTED) lines.push(`- ... and ${open.length - MAX_LISTED} more`)
    }
    if (unused.length > 0) {
      lines.push('', '**Unused allowlist entries** (remove them)', '')
      for (const i of unused) {
        const a = A11Y_ALLOWLIST[i]!
        lines.push(
          `- \`${a.rule}\` ${a.detail ?? a.target ?? ''} on ${a.routes.join(', ')} (${a.task})`,
        )
      }
    }

    mkdirSync(this.outputDir, { recursive: true })
    writeFileSync(
      join(this.outputDir, 'a11y-report.json'),
      JSON.stringify({ skin, reports: this.reports, unused }, null, 2),
    )
    console.log(`\n${lines.join('\n').replace(/^### /, '')}`)
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) appendFileSync(summary, `${lines.join('\n')}\n`)

    return strict && unused.length > 0 ? { status: 'failed' } : undefined
  }

  printsToStdio(): boolean {
    return false
  }
}

function format(f: Finding & { at: string }): string {
  return `${f.at}: \`${f.rule}\` ${f.target.replace(/`/g, "'")} -- ${f.message}`
}
