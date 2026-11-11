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
export function trackApi(page: Page): { inFlight(): number; lastChange(): number } {
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
  return { inFlight: () => pending.size, lastChange: () => changed }
}

/**
 * Wait for the splash to go and the API to stay quiet.
 *
 * @param tracker - from trackApi(), attached before the navigation
 */
export async function settle(page: Page, tracker: ReturnType<typeof trackApi>): Promise<void> {
  const deadline = Date.now() + CEILING_MS
  await page
    .getByTestId('splash')
    .waitFor({ state: 'detached', timeout: CEILING_MS })
    .catch(() => {})
  while (Date.now() < deadline) {
    const quietFor = Date.now() - tracker.lastChange()
    if (tracker.inFlight() === 0 && quietFor >= QUIET_MS) return
    if (page.isClosed()) return
    // A 50 ms poll of the counter on the runner side, not a fixed page wait.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
