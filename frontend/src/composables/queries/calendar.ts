// =============================================================================
// VELO Frontend -- the calendar's week on Pinia Colada (FE-166 step 4)
// =============================================================================
//
// The Calendar screen reads ONE query whose key is the week the calendar
// store describes (stores/calendar.ts, weekParams): the viewer's feed
// (`GET /practices` for the range and facets), a master's public feed (the
// stacked master calendar), or a school's whole upcoming feed (the stacked
// school calendar -- the endpoint has no dates, each window is a client-side
// slice). Every key sits under `keys.practices.lists()`, so the booking
// mutations and the master's practice changes refetch the week on screen
// (./invalidation.ts) -- the legacy `calendar.loadWeek(true)` lines are gone.
//
// Window moves keep the previous week on screen while the next one loads
// (placeholderData, same scope only): the selected day's list stays, and a
// skeleton shows only where there is nothing to show -- except after a ribbon
// scroll, whose reload is a quiet marker refresh (store.quietWindow).
// =============================================================================

import { computed, shallowRef, watch } from 'vue'
import { defineQueryOptions, useQuery, type UseQueryEntry } from '@pinia/colada'
import { getPractices } from '@/api/practices'
import { getSchoolPractices } from '@/api/schools'
import { keys } from '@/composables/queries/keys'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { calendarDateInTz, useCalendarStore, type CalendarWeekParams } from '@/stores/calendar'
import { seedPractices } from '@/stores/practices'
import type { PracticeFilters, PracticeResponse } from '@/api/types'

// School feed pagination (owner 2026-10-01): the endpoint caps a page at 100;
// two pages (200 rows) mirror the school page's own all-pages honesty stop
// and are beyond any real school.
const SCHOOL_FEED_PAGE = 100
const SCHOOL_FEED_MAX_PAGES = 2

/** The week params without the school scope: what the practices request depends on. */
export type CalendarFeedParams = Omit<CalendarWeekParams, 'school'>

/**
 * Query options for one week of the viewer's feed, or of a master's public
 * feed (`GET /practices` with the range, the facets and the scope).
 *
 * @remarks
 * Persisted for the viewer's own feed (no master scope): a cold start draws
 * the week at once, then revalidates. Window focus refetches it: seats and
 * practices change by others' hands. Every answer seeds the practice
 * details (stores/practices.ts), so a tap opens the detail with content.
 */
export const calendarWeekQuery = defineQueryOptions((params: CalendarFeedParams) => ({
  key: keys.practices.calendarWeek(params),
  query: async (): Promise<PracticeResponse[]> => {
    const query: PracticeFilters = {
      ...params.filters,
      // Master scope (owner 2026-09-30): the stacked master calendar reads the
      // PUBLIC feed for one master, scheduled only -- never the viewer's own
      // practices, never drafts/past ones.
      ...(params.master ? { master_id: params.master, status: 'scheduled' as const } : {}),
      date_from: params.from,
      date_to: params.to,
      sort_by: 'scheduled_at',
      sort_order: 'asc',
    }
    // A week (+- 1 day buffer) of practices is small; one page covers it.
    const res = await getPractices(query, 100, 0)
    seedPractices(res.items)
    // School-context master scope (owner 2026-10-03): keep only the master's
    // practices in THAT school; personal ones (school_id null) and other
    // schools' ones are not the curator's business here.
    return params.master && params.schoolFilter
      ? res.items.filter((p) => p.school_id === params.schoolFilter)
      : res.items
  },
  refetchOnWindowFocus: true,
  meta: { persist: params.master === null },
}))

/**
 * Query options for a school's whole upcoming feed (`GET /schools/{id}/practices`,
 * up to SCHOOL_FEED_MAX_PAGES pages) -- the stacked school calendar slices
 * each week out of it.
 */
export const schoolCalendarFeedQuery = defineQueryOptions((schoolId: string) => ({
  key: keys.practices.schoolUpcoming(schoolId),
  query: async (): Promise<PracticeResponse[]> => {
    const first = await getSchoolPractices(schoolId, SCHOOL_FEED_PAGE, 0)
    const items = [...first.items]
    const pages = Math.ceil(first.total / SCHOOL_FEED_PAGE)
    for (let p = 1; p < Math.min(pages, SCHOOL_FEED_MAX_PAGES); p++) {
      const res = await getSchoolPractices(schoolId, SCHOOL_FEED_PAGE, p * SCHOOL_FEED_PAGE)
      if (!res.items.length) break
      items.push(...res.items)
    }
    seedPractices(items)
    return items
  },
  refetchOnWindowFocus: true,
}))

/** The scope part of a calendar key: entries of another scope never stand in for this one. */
function scopeOf(key: readonly unknown[] | undefined): string {
  const params = key?.[2] as { calendar?: CalendarFeedParams; schoolId?: string } | undefined
  if (params?.schoolId) return `school:${params.schoolId}`
  const feed = params?.calendar
  return `feed:${feed?.master ?? ''}:${feed?.schoolFilter ?? ''}`
}

/** Keep the previous week on screen while the next loads -- within the same scope only. */
function samePlaceholder(
  previous: PracticeResponse[] | undefined,
  previousEntry: UseQueryEntry | undefined,
  next: readonly unknown[],
): PracticeResponse[] | undefined {
  if (!previousEntry || scopeOf(previousEntry.key) !== scopeOf(next)) return undefined
  return previous
}

/**
 * The calendar screen's week: the practices of the store's week, the day
 * markers and the selected day's list, and the loading / error state.
 *
 * @remarks
 * Call in the screen's setup. `error` is the raw error of the last request
 * (ADR: the screen words it). After a failed QUIET refresh (a ribbon scroll)
 * the week already on screen stays; after any other failure the list is
 * empty and the error shows.
 */
export function useCalendarWeek() {
  const store = useCalendarStore()
  const viewerTz = useViewerTimezone()

  const query = useQuery<PracticeResponse[]>(() => {
    const { school, ...feed } = store.weekParams
    const options = school ? schoolCalendarFeedQuery(school) : calendarWeekQuery(feed)
    return {
      ...options,
      placeholderData: (previous, previousEntry) =>
        samePlaceholder(previous, previousEntry, options.key),
    }
  })

  // School scope: open on the nearest practice, once the feed is known.
  watch(
    () => [store.schoolScope, query.data.value] as const,
    ([school, feed]) => {
      if (school && feed && !query.isPlaceholderData.value) {
        store.snapToSchoolFeed(feed, viewerTz.value ?? 'UTC')
      }
    },
    { immediate: true },
  )

  /** The last week shown -- what a failed quiet refresh keeps on screen. */
  const lastShown = shallowRef<PracticeResponse[]>([])
  const loaded = computed<PracticeResponse[] | undefined>(() => {
    const data = query.data.value
    if (data === undefined) return undefined
    if (!store.weekParams.school) return data
    // School scope: this window's slice of the whole upcoming feed.
    const fromMs = new Date(store.weekParams.from).getTime()
    const toMs = new Date(store.weekParams.to).getTime()
    return data.filter((p) => {
      const at = new Date(p.scheduled_at).getTime()
      return at >= fromMs && at <= toMs
    })
  })
  watch(loaded, (week) => {
    if (week !== undefined) lastShown.value = week
  })

  const weekPractices = computed<PracticeResponse[]>(() => {
    if (loaded.value !== undefined) return loaded.value
    return store.quietWindow && query.error.value != null ? lastShown.value : []
  })

  const fetching = computed(() => query.asyncStatus.value === 'loading')
  /**
   * Nothing of THIS week loaded yet and its request runs -- the skeleton's
   * condition. While the previous week stands in (placeholder -- `useQuery`
   * reports it as `success`), only a real reload counts as loading, not a
   * ribbon scroll's quiet marker refresh.
   */
  const loading = computed(() => {
    if (!fetching.value) return false
    if (query.isPlaceholderData.value) return !store.quietWindow
    return query.status.value === 'pending'
  })

  /**
   * Day keys (viewer timezone) with at least one practice not yet started.
   *
   * @param nowMs - The caller's reactive clock (epoch ms); reading it inside a
   *   `computed` keeps the markers live as practices start.
   */
  function daysWithPractices(nowMs: number): Set<string> {
    const tz = viewerTz.value ?? 'UTC'
    const set = new Set<string>()
    for (const p of weekPractices.value) {
      // Skip already-started practices so a day's dot matches its (filtered)
      // list -- a day whose practices have all started shows no dot.
      if (new Date(p.scheduled_at).getTime() <= nowMs) continue
      set.add(calendarDateInTz(p.scheduled_at, tz))
    }
    return set
  }

  /**
   * The selected day's practices not yet started, sorted ascending (the day
   * bucketed in the viewer's profile timezone, F5).
   *
   * @param nowMs - The caller's reactive clock (epoch ms), as in daysWithPractices.
   */
  function selectedDayPractices(nowMs: number): PracticeResponse[] {
    const tz = viewerTz.value ?? 'UTC'
    return (
      weekPractices.value
        .filter((p) => calendarDateInTz(p.scheduled_at, tz) === store.selectedDate)
        // Hide already-started practices (can't be booked anymore). Comparison is
        // in epoch ms (tz-independent); for future days every practice passes.
        .filter((p) => new Date(p.scheduled_at).getTime() > nowMs)
        .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    )
  }

  return {
    weekPractices,
    loading,
    fetching,
    error: query.error,
    daysWithPractices,
    selectedDayPractices,
    /** Refetch now (the error state's retry), keeping what is shown. */
    refetch: () => query.refetch(),
    /** Refresh if stale (a return to the kept-alive tab). */
    refresh: () => query.refresh(),
  }
}
