/**
 * Crash report (FE-161): one line per failed test, for a human and an agent
 * alike --
 *
 *   [role] /path -- kind: message (trace: test-results/.../trace.zip)
 *
 * The detector's signals come from the test's `crashes.json` attachment
 * (e2e/support/test.ts); any other failure (a timeout, a failed assertion)
 * is reported as `failure` with its first line. The list goes to the console,
 * to `test-results/crashes.json` and, in GitHub Actions, to the step summary.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import type { CrashSignal } from './crashes'

/** One failed test in crashes.json. */
interface CrashEntry {
  project: string
  test: string
  /** The detector's signals, or one `failure` for any other cause. */
  signals: Array<Omit<CrashSignal, 'kind'> & { kind: CrashSignal['kind'] | 'failure' }>
  trace?: string
}

export default class CrashReporter implements Reporter {
  private entries: CrashEntry[] = []
  private outputDir = 'test-results'

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir ?? this.outputDir
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // test.fail() self-checks end "failed" as expected: not a finding.
    if (result.status === test.expectedStatus) return
    if (result.status === 'skipped') return
    const attached = result.attachments.find((a) => a.name === 'crashes.json')
    const signals: CrashEntry['signals'] = attached?.body
      ? (JSON.parse(attached.body.toString()) as CrashSignal[])
      : []
    if (signals.length === 0) {
      const first = (result.error?.message ?? result.status).split('\n')[0] ?? result.status
      signals.push({ kind: 'failure', message: stripAnsi(first) })
    }
    const trace = result.attachments.find((a) => a.name === 'trace')?.path
    this.entries.push({
      project: test.parent.project()?.name ?? '',
      test: test.title,
      signals,
      trace: trace ? relative(process.cwd(), trace) : undefined,
    })
  }

  onEnd(): void {
    mkdirSync(this.outputDir, { recursive: true })
    const file = join(this.outputDir, 'crashes.json')
    writeFileSync(file, JSON.stringify(this.entries, null, 2))
    if (this.entries.length === 0) return

    const lines = this.entries.flatMap((e) =>
      e.signals.map(
        (s) =>
          `${e.test} -- ${s.kind}: ${s.message}${s.count ? ` (x${s.count})` : ''}` +
          (e.trace ? ` (trace: ${e.trace})` : ''),
      ),
    )
    console.log(
      `\nCrash report: ${this.entries.length} failed test(s), ${relative(process.cwd(), file)}`,
    )
    for (const line of lines) console.log(`  ${line}`)

    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) {
      appendFileSync(
        summary,
        `### e2e crash report\n\n${this.entries.length} failed test(s)\n\n` +
          lines.map((l) => `- \`${l.replace(/`/g, "'")}\``).join('\n') +
          '\n',
      )
    }
  }

  printsToStdio(): boolean {
    return false
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}
