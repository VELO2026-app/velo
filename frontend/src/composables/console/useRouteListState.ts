// =============================================================================
// VELO Frontend -- the tab and the page of a console table, kept in the URL (FE-262)
// =============================================================================
//
// A console list is a tab strip plus numbered pages. Both live in the route
// query (`?tab=pending&page=2`) so a reload, a link and the Back button from a
// detail screen land on the same slice of the list. A change replaces the
// history entry: flipping through tabs and pages is not navigation. A filter
// of the screen rides in the same query (`setQuery`); a tab, a page or a
// filter change keeps the others' marks.
// =============================================================================

import { computed, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { pageCountOf } from '@/utils/console/pagerItems'

/** The tab and the page of a console table, and how to change them. */
export interface RouteListState<Tab extends string> {
  /** The current tab (the first one when the URL names none, or an unknown one). */
  tab: ComputedRef<Tab>
  /** The current 1-based page (1 when the URL names none, or a bad one). */
  page: ComputedRef<number>
  /** Switch the tab; the page goes back to the first. */
  setTab: (tab: Tab) => void
  /** Go to a page. */
  setPage: (page: number) => void
  /**
   * Set or clear (undefined) other marks of the query -- a filter of the
   * screen; the page goes back to the first.
   */
  setQuery: (marks: Record<string, string | undefined>) => void
  /**
   * Keep the page inside the list: `lastPage` is the last page the list has,
   * once it is known (undefined while no answer has come). A URL that names a
   * page past it -- the last row of the last page left, a stale link -- is
   * replaced by the last page. Called once the screen has its query, which
   * is what knows the total.
   */
  clampTo: (lastPage: MaybeRefOrGetter<number | undefined>) => void
}

/** The last page of a list of `total` rows (the first while it is empty), or undefined while the total is unknown. */
export function lastPageOf(total: number | undefined, pageSize: number): number | undefined {
  return total === undefined ? undefined : pageCountOf(total, pageSize)
}

/**
 * Read and write the tab and the page of a console table in the route query.
 *
 * @param tabs - The tabs, the first one is the default (it leaves no mark in the URL)
 */
export function useRouteListState<Tab extends string>(
  tabs: readonly [Tab, ...Tab[]],
): RouteListState<Tab> {
  const route = useRoute()
  const router = useRouter()
  const first = tabs[0]

  const tab = computed<Tab>(() => {
    const value = route.query.tab
    return typeof value === 'string' && (tabs as readonly string[]).includes(value)
      ? (value as Tab)
      : first
  })
  const page = computed<number>(() => {
    const value = Number(route.query.page)
    return Number.isInteger(value) && value >= 1 ? value : 1
  })

  function write(nextTab: Tab, nextPage: number, marks: Record<string, string | undefined> = {}) {
    const query = { ...route.query }
    if (nextTab === first) delete query.tab
    else query.tab = nextTab
    if (nextPage === 1) delete query.page
    else query.page = String(nextPage)
    for (const [name, value] of Object.entries(marks)) {
      if (value === undefined) delete query[name]
      else query[name] = value
    }
    void router.replace({ query })
  }

  return {
    tab,
    page,
    setTab: (next) => write(next, 1),
    setPage: (next) => write(tab.value, next),
    setQuery: (marks) => write(tab.value, 1, marks),
    clampTo: (lastPage) =>
      watch(
        () => [page.value, toValue(lastPage)] as const,
        ([current, last]) => {
          if (last !== undefined && current > last) write(tab.value, last)
        },
        { immediate: true },
      ),
  }
}
