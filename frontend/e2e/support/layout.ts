/**
 * Layout detector (FE-240): geometric invariants of a rendered screen, the
 * class of bug happy-dom cannot see and the crash detector does not look for
 * (FE-173: a date drawn over a time; a header under Telegram's controls; a
 * button under the tab bar). No reference images: every rule is a property
 * any screen must have, read from the live layout after the screen settled.
 * The rules and the scan itself: ./layout-scan.ts.
 *
 * A screen is judged at the size it was loaded at (one Playwright project
 * per size of LAYOUT_SIZES). Findings that an entry of LAYOUT_ALLOWLIST
 * (./layout-allowlist.ts) accepts are dropped; the rest become crash
 * detector signals of kind `layout`.
 */
import type { Page } from '@playwright/test'
import type { CrashSignal, Crashes } from './crashes'
import { IPHONE_FULLSCREEN } from './fixtures'
import type { LayoutAllowance, LayoutRule } from './layout-allowance'
import { LAYOUT_ALLOWLIST } from './layout-allowlist'
import { scanLayout, type SafeBands, type ScanFinding } from './layout-scan'
import { sizeLabel } from './layout-sizes'

export type { LayoutAllowance, LayoutRule, SafeBands }
export { LAYOUT_SIZES, type LayoutSize } from './layout-sizes'

/** The smallest side of a tap target, CSS px (Apple HIG, WCAG 2.5.5). */
export const TARGET_PX = 44

/**
 * How far Telegram's controls strip and the status bar overlap, CSS px: the
 * device-tuned OVERLAP_PX of src/composables/useSafeArea.ts (that module
 * pulls the app's platform layer in, so the number is repeated here).
 */
const TELEGRAM_OVERLAP_PX = 20

/**
 * The bands of Telegram on an iPhone in fullscreen (IPHONE_FULLSCREEN). Top:
 * Telegram's controls -- the clearance useSafeArea.ts measured on a device
 * (status bar + controls, less their overlap). Bottom: the home indicator.
 */
export const TELEGRAM_BANDS: SafeBands = {
  top: IPHONE_FULLSCREEN.safe.top + IPHONE_FULLSCREEN.content.top - TELEGRAM_OVERLAP_PX,
  bottom: IPHONE_FULLSCREEN.safe.bottom,
}

/** One breakage at the size the screen was judged at, before the allowlist. */
export interface LayoutFinding extends ScanFinding {
  /** `390x844`. */
  size: string
}

/** Whether one of `allowances` accepts `finding` on route `route`. */
export function isLayoutAllowed(
  finding: LayoutFinding,
  route: string,
  allowances: readonly LayoutAllowance[],
): boolean {
  const width = Number(finding.size.split('x')[0])
  const side = finding.measured ? Math.min(finding.measured.width, finding.measured.height) : null
  return allowances.some(
    (a) =>
      a.rules.includes(finding.rule) &&
      (!a.routes || a.routes.includes(route)) &&
      (!a.element || a.element.test(finding.element)) &&
      (!a.widths || a.widths.includes(width)) &&
      (a.minSide === undefined || (side !== null && side >= a.minSide)),
  )
}

/**
 * Findings per rule shown before "and N more" (LAYOUT_MAX raises it: every
 * finding of a screen at once, to fill the allowlist or a task).
 */
const MAX_PER_RULE = Number(process.env.LAYOUT_MAX ?? 8)

/** The findings as crash-detector signals, at most `max` per rule plus "and N more". */
export function layoutSignals(
  findings: readonly LayoutFinding[],
  path: string,
  max: number = MAX_PER_RULE,
): CrashSignal[] {
  const perRule = new Map<LayoutRule, number>()
  const signals: CrashSignal[] = []
  for (const f of findings) {
    const n = (perRule.get(f.rule) ?? 0) + 1
    perRule.set(f.rule, n)
    if (n > max) continue
    signals.push({
      kind: 'layout',
      message: `${f.rule} @${f.size}: ${f.element} -- ${f.detail}`,
      path,
    })
  }
  for (const [rule, n] of perRule) {
    if (n > max) signals.push({ kind: 'layout', message: `${rule}: and ${n - max} more`, path })
  }
  return signals
}

/**
 * Judge the screen of `route` (a sweep route name) as loaded and hand what
 * LAYOUT_ALLOWLIST leaves to the crash detector, which fails the test.
 */
export async function checkLayout(page: Page, crashes: Crashes, route: string): Promise<void> {
  const path = new URL(page.url()).pathname
  const findings = (await inspectLayout(page, TELEGRAM_BANDS)).filter(
    (f) => !isLayoutAllowed(f, route, LAYOUT_ALLOWLIST),
  )
  for (const signal of layoutSignals(findings, path)) crashes.record(signal)
}

/** Scan the page at its current size, once its fonts and geometry settled. */
export async function inspectLayout(page: Page, bands: SafeBands): Promise<LayoutFinding[]> {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('inspectLayout: the page has no viewport size')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await layoutSettled(page)
  const size = sizeLabel(viewport)
  return (await page.evaluate(scanLayout, { bands, targetPx: TARGET_PX })).map((f) => ({
    ...f,
    size,
  }))
}

/** How long a screen may keep moving before it is judged as it stands. */
const SETTLE_CEILING_MS = 1_500

/**
 * Wait until the geometry stops changing: the boxes of all elements are the
 * same on two animation frames in a row (an entering list, a transition, a
 * resize observer that lands after the API went quiet). A screen that never
 * settles (an endless animation) is judged as it stands after
 * SETTLE_CEILING_MS.
 */
async function layoutSettled(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        let hash = 0
        for (const el of document.body.querySelectorAll('*')) {
          const r = el.getBoundingClientRect()
          hash = (hash * 31 + Math.round(r.left * 7 + r.top * 13 + r.width * 17 + r.height)) | 0
        }
        const w = window as unknown as { __veloLayoutHash?: number }
        const same = w.__veloLayoutHash === hash
        w.__veloLayoutHash = hash
        return same
      },
      undefined,
      { polling: 'raf', timeout: SETTLE_CEILING_MS },
    )
    .catch(() => {})
}
