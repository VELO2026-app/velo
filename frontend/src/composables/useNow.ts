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
  type Ref,
} from 'vue'
import { isDocumentHidden, offDocumentEvent, onDocumentEvent } from '@/platform/dom'

interface Ticker {
  now: Ref<number>
  /** Consumers that are alive AND not deactivated. */
  active: number
  timer: ReturnType<typeof setInterval> | null
}

/** One ticker per interval length: every consumer of the same cadence shares it. */
const tickers = new Map<number, Ticker>()
let visibilityBound = false

function sync(intervalMs: number, ticker: Ticker): void {
  const shouldRun = ticker.active > 0 && !isDocumentHidden()
  if (shouldRun && ticker.timer === null) {
    // Resuming after a pause: the stored value may be stale by minutes.
    ticker.now.value = Date.now()
    ticker.timer = setInterval(() => {
      ticker.now.value = Date.now()
    }, intervalMs)
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
  for (const ticker of tickers.values()) if (ticker.active > 0) anyActive = true
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
 * All callers with the same interval share ONE timer. The timer runs only
 * while at least one consumer is mounted and not deactivated (keep-alive) and
 * the document is visible; on resume the value is refreshed at once. Cleanup
 * is automatic with the calling scope (component or store).
 *
 * @param intervalMs - Tick period in milliseconds (default one minute).
 * @returns A read-only ref holding `Date.now()` as of the last tick.
 */
export function useNow(intervalMs = 60_000): DeepReadonly<Ref<number>> {
  let ticker = tickers.get(intervalMs)
  if (!ticker) {
    ticker = { now: ref(Date.now()), active: 0, timer: null }
    tickers.set(intervalMs, ticker)
  }
  const shared = ticker
  let running = false

  function start(): void {
    if (running) return
    running = true
    shared.active += 1
    syncVisibilityBinding()
    sync(intervalMs, shared)
  }

  function stop(): void {
    if (!running) return
    running = false
    shared.active -= 1
    sync(intervalMs, shared)
    syncVisibilityBinding()
  }

  // A fresh subscriber must not read a value that is up to a tick old.
  shared.now.value = Date.now()
  start()

  if (getCurrentInstance()) {
    onDeactivated(stop)
    onActivated(start)
  }
  if (getCurrentScope()) onScopeDispose(stop)

  return readonly(shared.now)
}
