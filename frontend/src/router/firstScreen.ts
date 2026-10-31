// =============================================================================
// VELO Frontend -- first-screen gate: the first screen paints ONCE, finished
// =============================================================================
// On a cold start the splash is already up for the auth round-trip. Handing
// over the moment auth resolves used to show the first screen being BUILT:
//   1. the router was still resolving (redirect '/' -> zone dashboard, lazy
//      shell + screen chunks): an empty frame between the splash and the
//      shell;
//   2. the screen mounted empty: an invisible skeleton held space, the
//      answer then glided the block's height and faded the content in, the
//      stats flipped from placeholders to numbers, the check-in banner and
//      the bell dot popped in;
//   3. the dock gained the «Школы» tab when the membership probe answered
//      (every icon shifted);
//   4. the Telegram safe-area insets could still be arriving.
// This keeps the splash a moment longer instead -- until the route is
// resolved and, at most FIRST_SCREEN_DATA_CAP_MS more, until that screen's
// data (TAB_DATA_WARMERS), its shell's tab set and the viewport insets are
// in. The screen then mounts with everything in place: no skeleton, no
// fade, no glide (VLoadingSwap shows cached content without motion). On a
// slow link the cap hands over anyway and the screen loads as before.
// =============================================================================

import type { Router } from 'vue-router'
import { TAB_DATA_WARMERS } from '@/router/dataPrefetch'
import { viewportSettled } from '@/platform/telegram-sdk'

/** The longest the splash waits for the first screen's data after auth. */
export const FIRST_SCREEN_DATA_CAP_MS = 1000

/** Shell-level facts the dock depends on, per zone. */
async function warmShell(path: string): Promise<void> {
  const zone = path.split('/')[1]
  if (zone !== 'user' && zone !== 'master') return
  const { useSchoolsHubStore } = await import('@/stores/schoolsHub')
  await useSchoolsHubStore().ensureCurator()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves when the first screen can paint in its final layout (capped). */
export async function firstScreenReady(
  router: Router,
  cap = FIRST_SCREEN_DATA_CAP_MS,
): Promise<void> {
  try {
    await router.isReady()
  } catch {
    return // a failed first navigation: nothing to wait for
  }
  const path = router.currentRoute.value.path
  const warm = TAB_DATA_WARMERS[path]
  const tasks: Promise<unknown>[] = [viewportSettled(), warmShell(path).catch(() => undefined)]
  if (warm) tasks.push(warm().catch(() => undefined))
  await Promise.race([Promise.all(tasks), delay(cap)])
}
