// =============================================================================
// VELO Frontend -- useChatScroll (FE-157 s4/scroll-time)
// =============================================================================
//
// Manual scroll anchoring for chat-like feeds (the diary thread and the chat
// thread): the newest entry sits at the BOTTOM, history loads by scrolling UP.
//
// The feeds set `overflow-anchor: none` and anchor by hand because native
// scroll anchoring and `content-visibility` height placeholders both shifted
// the feed while the reader scrolled up. This composable is that manual
// anchoring, extracted verbatim from DiaryFeedView / ChatThreadScreen:
//   - keep-bottom: a reader pinned to the bottom stays pinned when the feed
//     is resized (keyboard open/close, composer growth);
//   - preserved position: loading an older page above shifts scrollTop by the
//     scrollHeight delta so the visible entries do not jump;
//   - sentinel: an IntersectionObserver on a rail element that triggers loads.
// =============================================================================

import { nextTick, onScopeDispose, watch, type Ref } from 'vue'

/** Options for `useChatScroll`. */
export interface ChatScrollOptions {
  /** The scroll container (the element whose scrollTop moves). */
  scrollEl: Ref<HTMLElement | null>
  /** Pixels the reader may drift from the bottom and still count as "at" it. */
  nearBottomPx?: number
  /** Runs on every observed resize, before a pinned reader is re-pinned. */
  onResize?: () => void
}

/** Options for a sentinel observer created by `useChatScroll`. */
export interface SentinelOptions {
  /** IntersectionObserver rootMargin; the lead before the sentinel is reached. */
  rootMargin: string
  /** Called each time the sentinel is reported intersecting. */
  onIntersect: () => void
}

/** Handle returned for a sentinel observer; lets the caller start it late. */
export interface SentinelHandle {
  /** Starts observing the current sentinel element (idempotent). */
  attach: () => void
}

const DEFAULT_NEAR_BOTTOM_PX = 120

/**
 * Pure bottom-distance test over the three scroll metrics.
 *
 * @returns True when the remaining distance to the bottom is within `threshold`.
 */
export function isNearBottomMetrics(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = DEFAULT_NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/**
 * Manual scroll anchoring for a bottom-anchored feed.
 *
 * @remarks
 * Wire `rememberBottomState` to the container's `scroll` event: the keep-bottom
 * decision must use the PRE-resize state (a keyboard shrinks the feed by more
 * than any threshold, so post-resize geometry cannot tell "pinned" from
 * "reading history"). Observers are released with the calling scope.
 */
export function useChatScroll(options: ChatScrollOptions) {
  const { scrollEl, onResize } = options
  const nearBottomPx = options.nearBottomPx ?? DEFAULT_NEAR_BOTTOM_PX

  let pinned = true
  let resizeObserver: ResizeObserver | null = null
  const sentinelObservers: IntersectionObserver[] = []

  /** True when the reader is within the threshold of the bottom (live geometry). */
  function isNearBottom(): boolean {
    const el = scrollEl.value
    if (!el) return true
    return isNearBottomMetrics(el.scrollTop, el.scrollHeight, el.clientHeight, nearBottomPx)
  }

  /** Scroll handler: remembers whether the reader is pinned to the bottom. */
  function rememberBottomState(): void {
    if (!scrollEl.value) return
    pinned = isNearBottom()
  }

  /** The last remembered pinned state (not live geometry). */
  function isPinned(): boolean {
    return pinned
  }

  /** Instant jump to the newest entry (never smooth: it would double-jump). */
  function scrollToBottom(): void {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  }

  /** Instant jump to the oldest rendered entry. */
  function scrollToTop(): void {
    const el = scrollEl.value
    if (el) el.scrollTop = 0
  }

  /**
   * Observes `target` (default: the scroll container) and re-pins a pinned
   * reader on every resize. Idempotent; no-op until the element exists.
   */
  function attachKeepBottom(target?: HTMLElement | null): void {
    const el = target ?? scrollEl.value
    if (resizeObserver || !el) return
    resizeObserver = new ResizeObserver(() => {
      onResize?.()
      if (pinned) scrollToBottom()
    })
    resizeObserver.observe(el)
  }

  /**
   * Runs `task` (which prepends older content) and then shifts scrollTop by
   * the scrollHeight delta, so the entries on screen stay where they were.
   */
  async function preservePosition(task: () => Promise<void>): Promise<void> {
    const el = scrollEl.value
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    await task()
    await nextTick()
    if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  }

  /**
   * Observes a sentinel element inside the scroll container. The observer is
   * rebuilt whenever the element is swapped (a list that unmounts and remounts
   * its rail must not leave the observer bound to a dead node).
   */
  function observeSentinel(target: Ref<HTMLElement | null>, opts: SentinelOptions): SentinelHandle {
    let observer: IntersectionObserver | null = null

    function detach(): void {
      observer?.disconnect()
      if (observer) {
        const i = sentinelObservers.indexOf(observer)
        if (i >= 0) sentinelObservers.splice(i, 1)
      }
      observer = null
    }

    function attach(): void {
      if (observer || !target.value || !scrollEl.value) return
      observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) opts.onIntersect()
        },
        { root: scrollEl.value, rootMargin: opts.rootMargin },
      )
      sentinelObservers.push(observer)
      observer.observe(target.value)
    }

    watch(target, (el) => {
      detach()
      if (el) attach()
    })

    return { attach }
  }

  onScopeDispose(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    for (const o of sentinelObservers) o.disconnect()
    sentinelObservers.length = 0
  })

  return {
    isNearBottom,
    isPinned,
    rememberBottomState,
    scrollToBottom,
    scrollToTop,
    attachKeepBottom,
    preservePosition,
    observeSentinel,
  }
}
