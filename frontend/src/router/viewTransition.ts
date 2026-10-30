// =============================================================================
// VELO Frontend -- screen transitions (View Transitions / CSS fades) + nav direction
// =============================================================================
//
// Why the router and not <Transition>: a screen here is not one element. Its
// header teleports into MobileLayout's island, the dock lives in the shell,
// the scroller is shared and several views have fragment roots. Keeping the
// old screen mounted next to the new one (Transition, KeepAlive) would put
// two teleported headers into the island at once. So the router owns the
// timing and animates MobileLayout's two containers, never two screens.
//
// Tab switches (tab root -> tab root), on every host: a FADE-THROUGH on the
// containers -- the old screen and its header fade out (--velo-dur-tab-out,
// html.vt-leave), the navigation commits, Vue swaps the screen while it is
// invisible (the old view, its teleported header included, is unmounted in
// that same patch), and the new one fades in (--velo-dur-tab-in,
// html.vt-fallback.vt-tab). Opacity only, ~260 ms in all, nothing waits for
// the network, and there is never more than one screen in the DOM.
//
// Depth (push/pop) on Blink: a View Transition -- snapshot of the old state,
// Vue mounts the new screen behind it, the compositor slides/crossfades the
// named layers (velo-header, velo-page, velo-tabbar; motion.css).
// Depth on WebKit (iOS/Telegram iOS, Safari) and hosts without the API: the
// new screen fades in (html.vt-fallback). WebKit's View Transitions (Safari
// 18+) are not used at all: the named page layer is a scroll container with
// a fog mask, and WebKit does not clip a live ::view-transition-new to its
// box (overflow is not supported on the layer it attaches), drops
// backdrop-filter while a transition runs, and positions groups against the
// viewport instead of the snapshot containing block -- on device that read
// as pieces of the previous screen left on stage and no animation.
//
// Hooked in beforeResolve: async route chunks are loaded and every other
// guard has passed. A depth View Transition gives `meta.preload` a short
// budget so the new snapshot is drawn with data when the API is fast; tabs
// and the CSS paths never wait for it (cache-first screens + skeleton). The
// update callback never waits for an animation frame (rendering is
// suppressed inside it) and is capped at UPDATE_TIMEOUT_MS.
//
// Rapid taps: a newer navigation supersedes an older one. A fade-out already
// running is reused (no second wait), a transition still animating is
// finished at once, and a superseded navigation touches no classes.
// Every class this file adds has a guaranteed removal (afterEach success or
// failure, plus a safety timer for the fade-out).
// =============================================================================

import { nextTick } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'
import { ADMIN_TABS, MASTER_TABS, USER_TABS } from '@/router/tabs'
import {
  addRootClass,
  flushRootStyle,
  isWebKitEngine,
  removeRootClass,
  rootDurationMs,
  startViewTransition,
  supportsViewTransitions,
  type ViewTransitionHandle,
} from '@/platform/dom'

declare module 'vue-router' {
  interface RouteMeta {
    /** false = this route always switches instantly (no View Transition). */
    viewTransition?: false
    /** Warm the screen's data before the transition snapshot (bounded by
     * PRELOAD_BUDGET_MS; the screen's own query takes over afterwards). */
    preload?: (to: RouteLocationNormalized) => Promise<unknown>
  }
}

export type TransitionKind = 'forward' | 'back' | 'tab'

/** How long a navigation may wait for `meta.preload` before the snapshot.
 * Past ~0.2 s a tap starts to feel ignored; the skeleton covers the rest. */
export const PRELOAD_BUDGET_MS = 180
/** Hard cap on the update callback (the screen is FROZEN behind the old
 * snapshot meanwhile): past it the transition is skipped and the new screen
 * shows directly. Normal mounts take a few ms (chunks load before this). */
export const UPDATE_TIMEOUT_MS = 300
/** How long html.vt-fallback stays on (longer than any fallback fade). */
const FALLBACK_MS = 480
/** Tab fade-out when the token cannot be read (matches variables.css). */
const TAB_OUT_FALLBACK_MS = 100
/** html.vt-leave never outlives this, whatever happens to the navigation. */
const LEAVE_SAFETY_MS = 1200

const TAB_PATHS = new Set([...USER_TABS, ...MASTER_TABS, ...ADMIN_TABS].map((tab) => tab.to))

export function transitionKind(
  to: Pick<RouteLocationNormalized, 'path'>,
  from: Pick<RouteLocationNormalized, 'path'>,
  isPop: boolean,
): TransitionKind {
  if (TAB_PATHS.has(to.path) && TAB_PATHS.has(from.path)) return 'tab'
  return isPop ? 'back' : 'forward'
}

let pendingPop = false
let lastWasPop = false

/** True when the navigation that produced the current route came from the
 * history stack (system/Telegram back, router.back()). MobileLayout reads it
 * to restore the scroll position instead of resetting it. */
export function lastNavigationWasPop(): boolean {
  return lastWasPop
}

function withBudget(task: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void task
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// -- Tab fade-out (html.vt-leave) ---------------------------------------------
let leaving = false
let leaveUntil = 0
let leaveTimer: ReturnType<typeof setTimeout> | null = null

function endLeave(): void {
  if (leaveTimer !== null) clearTimeout(leaveTimer)
  leaveTimer = null
  if (!leaving) return
  leaving = false
  removeRootClass('vt-leave')
}

/** Fade the current screen + header out; resolves when they are invisible.
 * A second tap while it runs joins the same fade instead of restarting it. */
async function fadeOutStage(): Promise<void> {
  if (!leaving) {
    clearFallback()
    leaving = true
    leaveUntil = Date.now() + rootDurationMs('--velo-dur-tab-out', TAB_OUT_FALLBACK_MS)
    addRootClass('vt-leave')
  }
  if (leaveTimer !== null) clearTimeout(leaveTimer)
  leaveTimer = setTimeout(endLeave, LEAVE_SAFETY_MS)
  const wait = leaveUntil - Date.now()
  if (wait > 0) await sleep(wait)
}

let fallbackClasses: string[] = []
let fallbackTimer: ReturnType<typeof setTimeout> | null = null

function clearFallback(): void {
  if (fallbackTimer !== null) clearTimeout(fallbackTimer)
  fallbackTimer = null
  for (const cls of fallbackClasses) removeRootClass(cls)
  fallbackClasses = []
}

/** No View Transitions: fade the freshly rendered screen in (motion.css).
 * Restartable -- a second tap mid-fade starts the fade over cleanly. */
function playFallback(kind: TransitionKind): void {
  clearFallback()
  // Same task as the fade-in below: no frame ever shows the stage at full
  // opacity in between (the fade-in starts from 0 with fill: both).
  endLeave()
  flushRootStyle()
  fallbackClasses = ['vt-fallback', `vt-${kind}`]
  for (const cls of fallbackClasses) addRootClass(cls)
  fallbackTimer = setTimeout(clearFallback, FALLBACK_MS)
}

/** The navigation that owns the screen change right now. */
let navSeq = 0
let activeTransition: ViewTransitionHandle | null = null
let activeClass: string | null = null

export function installViewTransitions(router: Router): void {
  // history.listen fires synchronously for back/forward (popstate), before
  // the router's own async navigation reaches the guards below.
  router.options.history.listen(() => {
    pendingPop = true
  })
  router.beforeEach(() => {
    lastWasPop = pendingPop
    pendingPop = false
  })

  router.beforeResolve(async (to, from) => {
    const first = from.matched.length === 0
    if (first || to.path === from.path || to.meta.viewTransition === false) return true
    const seq = ++navSeq
    const kind = transitionKind(to, from, lastWasPop)
    const useViewTransition = kind !== 'tab' && supportsViewTransitions() && !isWebKitEngine()

    if (to.meta.preload) {
      const warm = to.meta.preload(to)
      // Only a View Transition has a snapshot to hide a short wait behind;
      // everywhere else waiting would only delay the tap (skeleton instead).
      if (useViewTransition) await withBudget(warm, PRELOAD_BUDGET_MS)
      else void warm.catch(() => undefined)
      // Overtaken by a newer tap while waiting: let the router drop this one
      // without a transition of its own.
      if (seq !== navSeq) return true
    }

    // Resolves once this navigation has settled (or failed) and Vue has
    // rendered the new screen.
    const rendered = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const off = router.afterEach((_to, _from, failure) => {
          off()
          resolve(!failure)
        })
      })

    // A transition still animating is finished at once: the next "old"
    // snapshot is then the settled screen, not a half-faded mix.
    activeTransition?.skipTransition()
    activeTransition = null

    if (!useViewTransition) {
      // Tabs: the old screen leaves first (opacity only, no network).
      if (kind === 'tab') await fadeOutStage()
      if (seq !== navSeq) return true // superseded: the newer tap owns the stage
      void rendered().then(async (ok) => {
        if (seq !== navSeq) return
        if (!ok) {
          endLeave() // aborted/redirected-away: bring the screen back
          return
        }
        await nextTick()
        if (seq !== navSeq) return
        playFallback(kind)
      })
      return true
    }

    return new Promise<boolean>((confirm) => {
      let handle: ViewTransitionHandle | null = null
      const vt = startViewTransition(() => {
        // Old state is captured: let the navigation finish and wait until
        // the new screen (and its deferred header teleport) has rendered.
        // NO requestAnimationFrame in here: the browser suppresses rendering
        // while this callback runs, so a frame never comes and the screen
        // stayed frozen until the browser's own ~4 s update timeout (the
        // "3-5 s tab switch" regression). Two ticks = the route's render
        // flush + the post-flush (deferred teleport, island re-measure).
        const done = rendered()
        confirm(true)
        endLeave() // a tab fade-out overtaken by this push/back
        return new Promise<void>((resolve) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            // Too slow to animate: drop the animation, show the screen now.
            handle?.skipTransition()
            resolve()
          }, UPDATE_TIMEOUT_MS)
          void done
            .then(async () => {
              await nextTick()
              await nextTick()
            })
            .finally(() => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve()
            })
        })
      })
      handle = vt
      if (!vt) {
        confirm(true)
        return
      }
      const cls = `vt-${kind}`
      activeTransition = vt
      activeClass = cls
      addRootClass(cls)
      const cleanup = (): void => {
        // A skipped transition settles AFTER its successor started: never
        // strip the successor's kind class on the way out.
        if (activeTransition !== vt) {
          if (activeClass !== cls) removeRootClass(cls)
          return
        }
        removeRootClass(cls)
        activeTransition = null
        activeClass = null
      }
      vt.finished.then(cleanup, cleanup)
    })
  })
}
