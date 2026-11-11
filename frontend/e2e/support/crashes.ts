/**
 * Crash detector (FE-161): listens to a page for everything that means "the
 * screen broke" and reports it as a list of signals. Wired into every test by
 * the auto fixture in ./test.ts; this module holds the listeners and the
 * matching rules, the fixture only decides when to fail.
 *
 * Signals:
 * - `exception`   an uncaught exception in the page (`pageerror`);
 * - `reported`    an error that reached the app's reportError() -- Vue render
 *                 and setup errors, router errors, unhandled rejections
 *                 (the `velo:error` window event, src/platform/error-reporter.ts);
 * - `console`     a console.error the app printed itself;
 * - `api`         an `/api/` answer of 5xx, or a 4xx nobody allowed;
 * - `asset`       a same-origin script, style or chunk that failed to load;
 * - `screen`      a visible error state (`data-testid` screen-error / not-found);
 * - `blank`       nothing rendered in `#app`.
 */
import type { Page } from '@playwright/test'
import { GLOBAL_ALLOWLIST } from './allowlist'

/** What kind of breakage a signal reports. */
export type SignalKind = 'exception' | 'reported' | 'console' | 'api' | 'asset' | 'screen' | 'blank'

/** One observed breakage. */
export interface CrashSignal {
  kind: SignalKind
  message: string
  /** The page URL path when it happened. */
  path?: string
  /** How many times the same signal was seen (a retried request, a re-render). */
  count?: number
}

/** An API answer a test expects (method, path pattern, status). */
export interface AllowedApi {
  method: string
  path: RegExp
  status: number
}

/**
 * Exceptions to the detector. `reason` is mandatory: it names the known
 * defect or why the answer is a normal outcome for this test.
 */
export interface CrashAllowance {
  reason: string
  /** console.error texts to ignore. */
  console?: RegExp[]
  /** 4xx/5xx API answers to ignore. */
  api?: AllowedApi[]
  /** Visible error markers to ignore -- for tests of an error screen itself. */
  screen?: Array<'screen-error' | 'not-found'>
  /** Uncaught or reported error messages to ignore. */
  errors?: RegExp[]
}

/** The `crashes` fixture a test sees. */
export interface Crashes {
  /** Accept these signals in this test; `reason` is required. */
  allow(allowance: CrashAllowance): void
  /** The signals observed so far, allowlists applied. */
  signals(): CrashSignal[]
  /** Skip the end-of-test `screen` / `blank` checks (the page is gone by design). */
  skipScreenCheck(reason: string): void
}

/** Name of the binding the page reports `velo:error` events through. */
const BINDING = '__veloE2eReport'

/** The selector of every visible error marker. */
export const ERROR_MARKERS = '[data-testid="screen-error"], [data-testid="not-found"]'

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

/** The console line reportError's console transport prints (already a `reported` signal). */
const REPORTER_LINE = /^\[velo:/
/** Chromium's console echo of a failed HTTP answer (already an `api`/`asset` signal). */
const RESOURCE_ECHO = /^Failed to load resource: /

/** A watched page: the test-facing API and the end-of-test verdict. */
export interface CrashWatch {
  crashes: Crashes
  /** Inspect the screen one last time; the signals that remain after the allowlists. */
  finish(): Promise<CrashSignal[]>
}

/** Attach the listeners to `page`. Call before the first navigation. */
export async function watchCrashes(page: Page): Promise<CrashWatch> {
  const raw: CrashSignal[] = []
  const allowances: CrashAllowance[] = [...GLOBAL_ALLOWLIST]
  let screenCheck = true
  const origin = (): string | null => {
    try {
      return new URL(page.url()).origin
    } catch {
      return null
    }
  }
  const here = (): string => pathOf(page.url())

  page.on('pageerror', (err) => {
    raw.push({ kind: 'exception', message: `${err.name}: ${err.message}`, path: here() })
  })

  // reportError() announces each error as a `velo:error` window event; the
  // binding survives full navigations, a window array would not.
  await page.exposeBinding(
    BINDING,
    (
      _source,
      detail: { name?: string; message?: string; source?: string; info?: string; path?: string },
    ) => {
      // A `window` error event is an uncaught exception: `pageerror` already
      // reports it as `exception` -- one bug, one signal.
      if (detail.source === 'window') return
      const where = detail.info ? `${detail.source}/${detail.info}` : detail.source
      raw.push({
        kind: 'reported',
        message: `[${where}] ${detail.name}: ${detail.message}`,
        path: detail.path,
      })
    },
  )
  await page.addInitScript((binding) => {
    window.addEventListener('velo:error', (e) => {
      const detail = (e as CustomEvent<Record<string, unknown>>).detail
      const report = (window as unknown as Record<string, (d: unknown) => void>)[binding]
      void report?.({
        name: detail.name,
        message: detail.message,
        source: detail.source,
        info: detail.info,
        path: detail.path,
      })
    })
  }, BINDING)

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (REPORTER_LINE.test(text) || RESOURCE_ECHO.test(text)) return
    raw.push({ kind: 'console', message: text, path: here() })
  })

  page.on('response', (response) => {
    const status = response.status()
    if (status < 400) return
    const url = new URL(response.url())
    if (url.origin !== origin()) return
    const method = response.request().method()
    if (url.pathname.startsWith('/api/')) {
      raw.push({ kind: 'api', message: `${method} ${url.pathname} -> ${status}`, path: here() })
    } else if (isAsset(url.pathname, response.request().resourceType())) {
      raw.push({ kind: 'asset', message: `${url.pathname} -> ${status}`, path: here() })
    }
  })

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed'
    // A navigation (or a closing page) cancels what is in flight: not a bug.
    if (failure.includes('ERR_ABORTED') || failure.includes('cancelled')) return
    const url = new URL(request.url())
    if (url.origin !== origin()) return
    if (url.pathname.startsWith('/api/')) {
      raw.push({
        kind: 'api',
        message: `${request.method()} ${url.pathname} -> ${failure}`,
        path: here(),
      })
    } else if (isAsset(url.pathname, request.resourceType())) {
      raw.push({ kind: 'asset', message: `${url.pathname} -> ${failure}`, path: here() })
    }
  })

  const crashes: Crashes = {
    allow(allowance) {
      if (!allowance.reason?.trim()) throw new Error('crashes.allow: a reason is required')
      allowances.push(allowance)
    },
    signals: () => collapse(raw.filter((s) => !isAllowed(s, allowances))),
    skipScreenCheck(reason) {
      if (!reason.trim()) throw new Error('crashes.skipScreenCheck: a reason is required')
      screenCheck = false
    },
  }
  return {
    crashes,
    async finish() {
      if (screenCheck && !page.isClosed()) raw.push(...(await inspectScreen(page)))
      return crashes.signals()
    },
  }
}

function isAsset(pathname: string, resourceType: string): boolean {
  return (
    ['script', 'stylesheet', 'font'].includes(resourceType) ||
    pathname.startsWith('/assets/') ||
    /\.(m?js|css)$/.test(pathname)
  )
}

/** How long a page may stay blank at the end of a test (still booting). */
const BLANK_GRACE_MS = 5_000

/** The visible error markers and a blank `#app`, as signals. */
export async function inspectScreen(page: Page): Promise<CrashSignal[]> {
  const found: CrashSignal[] = []
  // Never navigated: there is no screen to judge.
  if (page.url() === 'about:blank') return found
  const path = pathOf(page.url())
  try {
    // Web-first: a page still booting gets BLANK_GRACE_MS to render anything.
    const blank = await page
      .waitForFunction(
        () => {
          const root = document.querySelector('#app')
          return [...(root?.querySelectorAll('*') ?? [])].some((el) => {
            const box = el.getBoundingClientRect()
            return box.width > 0 && box.height > 0
          })
        },
        undefined,
        { timeout: BLANK_GRACE_MS },
      )
      .then(() => false)
      .catch(() => !page.isClosed())
    if (blank) found.push({ kind: 'blank', message: 'nothing rendered in #app', path })
    const markers = page.locator(ERROR_MARKERS)
    for (const marker of await markers.all()) {
      if (!(await marker.isVisible())) continue
      const id = (await marker.getAttribute('data-testid')) ?? 'screen-error'
      const text = ((await marker.innerText()) || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      found.push({ kind: 'screen', message: `${id}: ${text}`, path })
    }
  } catch {
    // The page navigated away or closed mid-inspection: nothing to judge.
  }
  return found
}

function isAllowed(signal: CrashSignal, allowances: CrashAllowance[]): boolean {
  return allowances.some((a) => {
    switch (signal.kind) {
      case 'console':
        return a.console?.some((re) => re.test(signal.message)) ?? false
      case 'exception':
      case 'reported':
        return a.errors?.some((re) => re.test(signal.message)) ?? false
      case 'api': {
        const m = /^(\S+) (\S+) -> (\d+)$/.exec(signal.message)
        if (!m) return false
        const [, method, path, status] = m
        return (
          a.api?.some(
            (rule) =>
              rule.method.toUpperCase() === method &&
              rule.path.test(path!) &&
              rule.status === Number(status),
          ) ?? false
        )
      }
      case 'screen':
        return a.screen?.some((id) => signal.message.startsWith(`${id}:`)) ?? false
      default:
        return false
    }
  })
}

/** Merge repeats of one signal into a single entry with a count. */
function collapse(signals: CrashSignal[]): CrashSignal[] {
  const merged = new Map<string, CrashSignal>()
  for (const s of signals) {
    const key = `${s.kind}|${s.message}|${s.path ?? ''}`
    const seen = merged.get(key)
    if (seen) seen.count = (seen.count ?? 1) + 1
    else merged.set(key, { ...s })
  }
  return [...merged.values()]
}

/** One line per signal, for the failure message and the report. */
export function formatSignals(signals: CrashSignal[]): string {
  return signals
    .map(
      (s) =>
        `  ${s.kind}: ${s.message}${s.count ? ` (x${s.count})` : ''}${s.path ? `  (at ${s.path})` : ''}`,
    )
    .join('\n')
}
