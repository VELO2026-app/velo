// =============================================================================
// VELO Frontend -- useNow (FE-157 s4/scroll-time)
// =============================================================================
//
// A reactive "current time" clock shared by every screen that only needs the
// wall clock to re-evaluate window computeds (practice started, check-in open,
// countdown). It replaces a per-view setInterval + manual cleanup.
// =============================================================================

import {
  getCurrentInstance,
  getCurrentScope,
  onActivated,
  onDeactivated,
  onScopeDispose,
  readonly,
  ref,
  type DeepReadonly,
  type EffectScope,
  type Ref,
} from 'vue'
import { isDocumentHidden, offDocumentEvent, onDocumentEvent } from '@/platform/dom'

interface Ticker {
  /**
   * The refs of consumers that are alive AND not deactivated. Each consumer
   * owns its ref, so a paused (kept-alive, off-stage) consumer keeps its
   * last value and is not woken by ticks meant for the others.
   */
  subscribers: Set<Ref<number>>
  timer: ReturnType<typeof setInterval> | null
}

/** One ticker per interval length: every consumer of the same cadence shares its timer. */
const tickers = new Map<number, Ticker>()
let visibilityBound = false

function tick(ticker: Ticker): void {
  const at = Date.now()
  for (const now of ticker.subscribers) now.value = at
}

function sync(intervalMs: number, ticker: Ticker): void {
  const shouldRun = ticker.subscribers.size > 0 && !isDocumentHidden()
  if (shouldRun && ticker.timer === null) {
    // Resuming after a pause: the stored values may be stale by minutes.
    tick(ticker)
    ticker.timer = setInterval(() => tick(ticker), intervalMs)
  } else if (!shouldRun && ticker.timer !== null) {
    clearInterval(ticker.timer)
    ticker.timer = null
  }
}

function onVisibility(): void {
  for (const [intervalMs, ticker] of tickers) sync(intervalMs, ticker)
}

/** The document listener lives only while some consumer is active. */
function syncVisibilityBinding(): void {
  let anyActive = false
  for (const ticker of tickers.values()) if (ticker.subscribers.size > 0) anyActive = true
  if (anyActive && !visibilityBound) {
    onDocumentEvent('visibilitychange', onVisibility)
    visibilityBound = true
  } else if (!anyActive && visibilityBound) {
    offDocumentEvent('visibilitychange', onVisibility)
    visibilityBound = false
  }
}

/**
 * Reactive epoch-milliseconds clock that ticks every `intervalMs`.
 *
 * @remarks
 * Every call returns its OWN ref; callers with the same interval share one
 * timer. The timer runs only while at least one consumer is active and the
 * document is visible; a consumer that resumes is refreshed at once.
 *
 * Lifecycle binding:
 * - Called directly in a component's `setup()` (the current effect scope IS
 *   the component's scope): pauses on `deactivated`, resumes on `activated`
 *   (keep-alive), stops on unmount.
 * - Called in any other effect scope (a Pinia setup store, a manual
 *   `effectScope()`): stops only when that scope is disposed. The keep-alive
 *   hooks are deliberately NOT attached, even when a component happens to be
 *   rendering -- a store created lazily from some component's `setup()` must
 *   not borrow that component's lifecycle.
 * - Called with no effect scope: never stops; avoid.
 *
 * Prefer calling it from the component that renders the time-dependent
 * state, not from a store, so a kept-alive, off-stage screen does not tick.
 *
 * @param intervalMs - Tick period in milliseconds (default one minute).
 * @returns A read-only ref holding `Date.now()` as of the last tick.
 */
export function useNow(intervalMs = 60_000): DeepReadonly<Ref<number>> {
  let ticker = tickers.get(intervalMs)
  if (!ticker) {
    ticker = { subscribers: new Set(), timer: null }
    tickers.set(intervalMs, ticker)
  }
  const shared = ticker
  const now = ref(Date.now())

  function start(): void {
    if (shared.subscribers.has(now)) return
    // A resuming subscriber must not read a value that is up to a pause old.
    now.value = Date.now()
    shared.subscribers.add(now)
    syncVisibilityBinding()
    sync(intervalMs, shared)
  }

  function stop(): void {
    if (!shared.subscribers.delete(now)) return
    sync(intervalMs, shared)
    syncVisibilityBinding()
  }

  start()

  const scope = getCurrentScope()
  // getCurrentInstance() stays set while a component's setup() lazily creates
  // a Pinia store (or runs any nested effectScope), so "is there an instance"
  // is not enough: bind the keep-alive hooks only when the active scope IS the
  // component's own. `scope` is marked internal in Vue's typings but has been
  // a stable field of the component instance since 3.2.
  const instance = getCurrentInstance() as { scope?: EffectScope } | null
  if (instance && instance.scope === scope) {
    onDeactivated(stop)
    onActivated(start)
  }
  if (scope) onScopeDispose(stop)

  return readonly(now)
}
