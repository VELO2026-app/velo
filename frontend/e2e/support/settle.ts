/**
 * settle(page) (FE-161): wait until a freshly opened screen has finished
 * loading -- the splash is gone and no `/api/` request has been in flight
 * for QUIET_MS in a row. Capped at CEILING_MS: a screen that never goes quiet
 * (polling, a stuck request) is judged as it stands.
 *
 * No waitForTimeout and no `networkidle`: the counter tracks only the app's
 * own API traffic, so a long-lived asset or a third-party request cannot hold
 * it up, and a request that starts late resets the quiet window.
 */
import type { Page, Request } from '@playwright/test'

const QUIET_MS = 500
const CEILING_MS = 10_000

function isApi(request: Request): boolean {
  try {
    return new URL(request.url()).pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/** Track the page's in-flight API requests. Call before the first goto. */
export function trackApi(page: Page): {
  inFlight(): number
  lastChange(): number
  restart(): void
} {
  const pending = new Set<Request>()
  let changed = Date.now()
  const start = (r: Request): void => {
    if (!isApi(r)) return
    pending.add(r)
    changed = Date.now()
  }
  const end = (r: Request): void => {
    if (pending.delete(r)) changed = Date.now()
  }
  page.on('request', start)
  page.on('requestfinished', end)
  page.on('requestfailed', end)
  return {
    inFlight: () => pending.size,
    lastChange: () => changed,
    restart: () => {
      changed = Math.max(changed, Date.now())
    },
  }
}

/**
 * Wait for the app to mount, the splash to go and the API to stay quiet.
 *
 * @remarks
 * The order matters. `goto` resolves on `load`, but the app mounts later
 * (main.ts awaits the host, /config.json and the app chunk -- none of them
 * `/api/` traffic). Waiting for "no splash" before anything is mounted would
 * pass at once and judge an empty page; so first `#app` must have content,
 * then the splash must be gone, then the API quiet.
 *
 * @param tracker - from trackApi(), attached before the navigation
 */
export async function settle(page: Page, tracker: ReturnType<typeof trackApi>): Promise<void> {
  const deadline = Date.now() + CEILING_MS
  await page
    .waitForFunction(
      () => (document.querySelector('#app')?.childElementCount ?? 0) > 0,
      undefined,
      {
        timeout: CEILING_MS,
      },
    )
    .catch(() => {})
  await page
    .getByTestId('splash')
    .waitFor({ state: 'detached', timeout: Math.max(deadline - Date.now(), 1) })
    .catch(() => {})
  // The quiet window starts no earlier than now: the requests the mount fired
  // are already counted, and a screen that has not asked for anything yet
  // gets its full QUIET_MS to do so.
  tracker.restart()
  while (Date.now() < deadline) {
    const quietFor = Date.now() - tracker.lastChange()
    if (tracker.inFlight() === 0 && quietFor >= QUIET_MS) return
    if (page.isClosed()) return
    // A 50 ms poll of the counter on the runner side, not a fixed page wait.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
