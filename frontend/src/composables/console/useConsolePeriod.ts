// =============================================================================
// VELO Frontend -- the period window of the console, kept in the URL (FE-268)
// =============================================================================
//
// The dashboard and the analytics show the same window of figures: a week or
// a month, and how many periods back. It lives in the route query
// (`?period=month&offset=-1`) so a reload, a link and the Back button from
// another module land on the same window. The defaults (this week) leave no
// mark in the URL. A period after the current one does not exist: an offset
// above zero reads as zero.
// =============================================================================

import { computed, type ComputedRef } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import type { AdminPeriodWindow } from '@/composables/queries/admin'

/** The window a route query names; what it cannot mean falls back to this week. */
export function periodFromQuery(query: LocationQuery): AdminPeriodWindow {
  const offset = Number.parseInt(String(query.offset ?? ''), 10)
  return {
    period: query.period === 'month' ? 'month' : 'week',
    offset: Number.isFinite(offset) && offset < 0 ? offset : 0,
  }
}

/** The query parameters of a window: nothing for this week. */
export function periodToQuery(window: AdminPeriodWindow): Record<string, string> {
  return {
    ...(window.period === 'week' ? {} : { period: window.period }),
    ...(window.offset === 0 ? {} : { offset: String(window.offset) }),
  }
}

/** The period window of the route and how to move it (the other query parameters stay). */
export function useConsolePeriod(): {
  periodWindow: ComputedRef<AdminPeriodWindow>
  setWindow: (next: AdminPeriodWindow) => void
} {
  const route = useRoute()
  const router = useRouter()
  return {
    periodWindow: computed(() => periodFromQuery(route.query)),
    setWindow(next) {
      const rest = Object.fromEntries(
        Object.entries(route.query).filter(([name]) => name !== 'period' && name !== 'offset'),
      )
      void router.replace({ query: { ...rest, ...periodToQuery(next) } })
    },
  }
}
