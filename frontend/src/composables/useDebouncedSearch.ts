import { getCurrentScope, onScopeDispose, watch, type WatchSource } from 'vue'

/** Per-run context handed to the search handler. */
export interface DebouncedSearchRun {
  /** True once a newer run, `cancel()` or scope disposal superseded this run. */
  isStale: () => boolean
}

/** Options for `useDebouncedSearch`. */
export interface DebouncedSearchOptions {
  /** Debounce window in milliseconds. @defaultValue 300 */
  delay?: number
  /**
   * Called synchronously on every source change before a timer is armed.
   * Return `false` to skip the fetch (the pending timer and any in-flight run
   * are cancelled) -- e.g. an empty query that only clears results.
   */
  beforeSchedule?: (query: string) => boolean
}

/**
 * Debounces a search input and guards its fetches against stale answers.
 *
 * @remarks
 * Every fire takes a fresh request id; the handler receives `isStale()` and
 * must drop its answer when it returns true, so a slow response for an older
 * query never repaints a newer one. The pending timer is cleared and in-flight
 * runs are invalidated when the owning scope (component) is disposed, so no
 * request starts or writes after unmount.
 *
 * @param source - Reactive search text.
 * @param handler - Runs the fetch for the debounced query.
 * @returns `cancel` drops the pending timer and invalidates in-flight runs;
 *   `flush` fires the handler immediately for the given query.
 */
export function useDebouncedSearch(
  source: WatchSource<string>,
  handler: (query: string, run: DebouncedSearchRun) => void | Promise<void>,
  options: DebouncedSearchOptions = {},
): { cancel: () => void; flush: (query: string) => void } {
  const delay = options.delay ?? 300
  let timer: ReturnType<typeof setTimeout> | undefined
  let requestId = 0

  function cancel(): void {
    clearTimeout(timer)
    timer = undefined
    requestId += 1
  }

  function fire(query: string): void {
    clearTimeout(timer)
    timer = undefined
    const id = ++requestId
    void handler(query, { isStale: () => id !== requestId })
  }

  watch(source, (value) => {
    if (options.beforeSchedule && options.beforeSchedule(value) === false) {
      cancel()
      return
    }
    clearTimeout(timer)
    timer = setTimeout(() => fire(value), delay)
  })

  if (getCurrentScope()) onScopeDispose(cancel)

  return { cancel, flush: fire }
}
