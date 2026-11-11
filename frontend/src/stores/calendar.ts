// =============================================================================
// VELO Frontend -- Calendar Store (Calendar iteration)
// =============================================================================
//
// Dedicated Pinia store for the Calendar screen. Kept SEPARATE from
// usePracticesStore (Dashboard/old catalog) so that week navigation and
// the Calendar facet filters never disturb that shared feed.
//
// Window model: the strip shows a SLIDING 7-day window whose first cell
// is the `weekAnchor` (defaults to today). Prev/next shift the anchor by
// ±7 days. Past windows (anchor < today) are blocked at the UI level via
// `canGoPrev` because past days can no longer be booked.
//
// Loading strategy (agreed): the whole visible window is fetched in ONE
// request (date_from = anchor 00:00, date_to = anchor+6 23:59:59 of the
// window, in the user's local timezone). The volume is small, so:
//   - day dot-markers are derived on the client from the loaded set,
//   - the selected-day list is filtered on the client,
//   - no pagination is needed (avoids the "client filter breaks server
//     pagination" problem entirely).
//
// Since FE-166 step 4 the week itself is server state and lives in Pinia
// Colada (composables/queries/calendar.ts, useCalendarWeek): this store keeps
// only the client state that decides WHICH week -- the window, the selected
// day, the facet filters and the scope -- and exposes it as `weekParams`, the
// query's key. A change of any of them is a new key; Colada drops answers of
// keys no longer on screen, the guard loadToken used to keep by hand.
//
// Facet filters (direction / difficulty / style / duration_bucket /
// time_of_day / practice_type) are applied SERVER-side via getPractices,
// so the loaded week already reflects them.
//
// Timezone note: the week boundaries are computed in the user's local
// timezone (the browser's) -- this only decides which 7 cells the strip
// shows and is intentionally left as-is. Grouping a practice into a day,
// however, uses the VIEWER'S OWN profile timezone (Batch 5 / F5): the
// profile decides in which timezone the viewer sees practice times, so the
// day a practice buckets under must match the time shown on its card. When
// the profile timezone is absent we fall back to 'UTC' (the same neutral
// default the format helpers use), so day and time stay consistent even in
// that edge case -- we do not silently fall back to the browser timezone.
// =============================================================================

import { defineStore } from 'pinia'
import { DateTime } from 'luxon'
import { ref, reactive, computed } from 'vue'
import type { PracticeFilters, PracticeResponse } from '@/api/types'

// Calendar-specific facet filters (excludes pagination/sort/date-range,
// which the store manages itself). Mirrors the facet subset of
// PracticeFilters that the Calendar UI controls.
/** Facet subset of the practice filters the Calendar UI controls (dates and pagination stay with the store). */
export interface CalendarFacetFilters {
  practice_type?: PracticeFilters['practice_type']
  direction?: PracticeFilters['direction']
  difficulty?: PracticeFilters['difficulty']
  style?: PracticeFilters['style']
  duration_bucket?: PracticeFilters['duration_bucket']
  time_of_day?: PracticeFilters['time_of_day']
}

/**
 * The week the calendar shows, as the query reads it (the key of
 * composables/queries/calendar.ts): the fetch range, the facet filters and
 * the scope. In school scope only the range matters for the slice; the feed
 * itself is keyed by the school.
 */
export interface CalendarWeekParams {
  /** ISO start of the fetched range (the window -1 day, widened to the selected day). */
  from: string
  /** ISO end of the fetched range (the window +1 day, widened to the selected day). */
  to: string
  filters: CalendarFacetFilters
  /** Master scope: this master's scheduled practices instead of the viewer's feed. */
  master: string | null
  /** With the master scope: keep only the practices of this school (client-side). */
  schoolFilter: string | null
  /** School scope: this school's upcoming feed, sliced to the range. */
  school: string | null
}

// ---------------------------------------------------------------------------
// Date helpers (local, dependency-free)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for a Date in a specific IANA timezone (en-CA gives ISO order). */
export function calendarDateInTz(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso))
}

/** YYYY-MM-DD for a Date in the browser's local timezone. */
export function localDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** 7 day-Dates starting from `anchor` (normalized to local midnight). */
function weekDays(anchor: Date): Date[] {
  const start = new Date(anchor)
  start.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    return day
  })
}

/** Parse a YYYY-MM-DD local-day key back to a Date at local midnight. */
export function parseLocalDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return DateTime.fromObject({ year: y!, month: m ?? 1, day: d ?? 1 }).toJSDate()
}

/** Today at local midnight. */
function todayMidnight(): Date {
  return DateTime.now().startOf('day').toJSDate()
}

/** Calendar screen state: sliding 7-day window, selected day, facet filters, scope -- the week to load. */
export const useCalendarStore = defineStore('calendar', () => {
  // -- State --
  // First day of the currently viewed 7-day window (local midnight).
  // Defaults to today; never moved earlier than today via the UI.
  const weekAnchor = ref<Date>(todayMidnight())
  // Selected day key (YYYY-MM-DD, local). Defaults to today.
  const selectedDate = ref<string>(localDateKey(weekAnchor.value))
  // Active facet filters (server-applied by the week query).
  const filters = reactive<CalendarFacetFilters>({})

  /**
   * [ribbon perf] The last window change was a ribbon scroll (shiftDays): its
   * reload is a background refresh for the new window's day markers and must
   * not churn the UI (no loader). Any other change -- arrows, filters, scope,
   * the screen's entry -- is a real reload.
   */
  const quietWindow = ref(false)

  // MASTER scope (owner 2026-09-30): when set, the week feed is THIS master's
  // scheduled practices (the public feed, master_id + status=scheduled) instead
  // of the viewer's own -- the stacked user-calendar-master route. Pinia state
  // is a singleton shared with the tab calendar, so the view resets it to null
  // on unmount; the week query folds it into its request.
  // Owner 2026-10-03: in the curator's school context the route carries
  // ?schoolId and the feed drops the master's practices OUTSIDE that school.
  // The public endpoint has no school param, so the query filters the response
  // client-side by the practices' own school_id (null on personal
  // practices, a foreign school's id otherwise). Cleared with the scope.
  const masterScope = ref<string | null>(null)
  const masterSchoolFilter = ref<string | null>(null)
  function setMasterScope(masterId: string | null, schoolFilter: string | null = null): void {
    masterScope.value = masterId
    masterSchoolFilter.value = schoolFilter
    quietWindow.value = false
  }

  // SCHOOL scope (owner 2026-10-01): the upcoming-practices tab copy
  // (i18n:user.screens.schoolPage.tabs.upcoming) on the school page
  // opens the calendar scoped to ONE school's upcoming practices. The school
  // feed endpoint (GET /schools/{id}/practices) has no date params, so its
  // full upcoming list is one query, and every weekly window is sliced from it
  // client-side; the strip can only reach future weeks and the feed is
  // all-future by definition. Same singleton-reset contract as masterScope:
  // the view clears it on unmount.
  const schoolScope = ref<string | null>(null)
  /** The school whose feed already snapped the window (snapToSchoolFeed): once per mode entry. */
  const snappedSchool = ref<string | null>(null)
  function setSchoolScope(schoolId: string | null): void {
    schoolScope.value = schoolId
    snappedSchool.value = null
    quietWindow.value = false
  }

  // First-entry guard: init() snaps the window to today only the FIRST time the
  // Calendar is opened in a session. On re-entry (e.g. returning from a practice
  // detail, or re-tapping the tab) the user's selected day/week is preserved —
  // only the data is refreshed. Reset on a fresh app launch (store recreated).
  const initialized = ref(false)

  // "Now" is NOT owned by the store: the derived views (useCalendarWeek) take
  // it as an argument. The caller (CalendarView) feeds its own useNow() clock,
  // so the minute tick follows the screen's lifecycle.

  // -- Derived: the 7 day-Dates of the current window --
  const days = computed<Date[]>(() => weekDays(weekAnchor.value))

  // Prev arrow is disabled when the window already starts at today
  // (we don't navigate into the past: those days can't be booked).
  const canGoPrev = computed<boolean>(
    () => localDateKey(weekAnchor.value) !== localDateKey(new Date()),
  )

  // [ribbon] Day-granular back limit for the strip's drag: how many days the
  // visible window may still move BACK before it starts at today. Same
  // contract as canGoPrev (that one is just `> 0`), expressed in days so the
  // drag can clamp/rubber-band mid-gesture instead of only at commit.
  const maxBackDays = computed<number>(() =>
    Math.max(0, Math.round((weekAnchor.value.getTime() - todayMidnight().getTime()) / 86_400_000)),
  )

  /**
   * The week to load: range, filters and scope -- the week query's key.
   *
   * @remarks
   * W-2: the week boundaries are local (browser TZ), but the server filters
   * scheduled_at in UTC and practices carry their OWN timezone. Near midnight
   * in extreme timezones a practice that belongs to this week locally can
   * fall just outside the UTC window. The range is widened by one day on each
   * side so no such practice is missed; the client still groups by
   * calendarDateInTz, so the extra days never leak into the wrong week.
   *
   * [ribbon] The selected day may sit OUTSIDE the visible week -- the ribbon
   * scrolls freely while the selection keeps its date (shiftDays). The range
   * is widened to cover the selected date too, so the list below never
   * empties on a scroll.
   */
  const weekParams = computed<CalendarWeekParams>(() => {
    const week = days.value
    const from = new Date(week[0]!)
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - 1)
    const to = new Date(week[6]!)
    to.setHours(23, 59, 59, 999)
    to.setDate(to.getDate() + 1)

    const selDay = parseLocalDateKey(selectedDate.value)
    const selFrom = new Date(selDay)
    selFrom.setDate(selDay.getDate() - 1)
    const selTo = new Date(selDay)
    selTo.setHours(23, 59, 59, 999)
    selTo.setDate(selDay.getDate() + 1)
    if (selFrom < from) from.setTime(selFrom.getTime())
    if (selTo > to) to.setTime(selTo.getTime())

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      filters: { ...filters },
      master: masterScope.value,
      schoolFilter: masterSchoolFilter.value,
      school: schoolScope.value,
    }
  })

  // -- Actions --

  /** Select a specific day (YYYY-MM-DD, local). The range only grows if the day is outside it. */
  function selectDay(dateKey: string): void {
    selectedDate.value = dateKey
  }

  /** Shift the window by ±7 days; also shift selectedDate so its position
   *  in the strip (and weekday) is preserved. */
  function shiftWindow(deltaDays: number): void {
    const a = new Date(weekAnchor.value)
    a.setDate(a.getDate() + deltaDays)
    weekAnchor.value = a
    const s = parseLocalDateKey(selectedDate.value)
    s.setDate(s.getDate() + deltaDays)
    selectedDate.value = localDateKey(s)
    quietWindow.value = false
  }

  /** Move the window 7 days back. No-op if already at today. */
  function prevWeek(): void {
    if (!canGoPrev.value) return
    shiftWindow(-7)
  }

  /** Move the window 7 days forward. */
  function nextWeek(): void {
    shiftWindow(7)
  }

  /**
   * [ribbon] Day-granular shift from the strip's drag: move the VISIBLE
   * WINDOW by `delta` days, clamped so it never starts before today.
   *
   * [owner pass] Scroll is ONLY scroll -- the SELECTED day keeps its own
   * date, always: no highlight jumping, no list churn under the ribbon (in
   * the default state today = the first visible day, so any clamp would
   * drag the selection along -- the exact bug this avoids). The list keeps
   * showing the selected day however far the ribbon scrolls, because
   * weekParams widens its range to cover the selected date. The reload is
   * QUIET (a marker refresh -- no loader).
   */
  function shiftDays(delta: number): void {
    const clamped = Math.max(delta, -maxBackDays.value)
    if (clamped === 0) return
    const a = new Date(weekAnchor.value)
    a.setDate(a.getDate() + clamped)
    weekAnchor.value = a
    quietWindow.value = true
  }

  /** Replace facet filters (the week query reloads with them). */
  function applyFilters(next: CalendarFacetFilters): void {
    // Reassign keys explicitly so cleared facets (undefined) are respected.
    filters.practice_type = next.practice_type
    filters.direction = next.direction
    filters.difficulty = next.difficulty
    filters.style = next.style
    filters.duration_bucket = next.duration_bucket
    filters.time_of_day = next.time_of_day
    quietWindow.value = false
  }

  /**
   * Open the Calendar. On the FIRST entry of a session, snap the window to
   * today. On re-entry (returning from a practice detail, re-tapping the tab)
   * keep the user's selected day/week -- the week query refreshes the data --
   * so leaving and coming back lands on the same day the user was viewing.
   */
  function init(): void {
    if (!initialized.value) {
      const today = todayMidnight()
      weekAnchor.value = today
      selectedDate.value = localDateKey(today)
      initialized.value = true
    }
    quietWindow.value = false
  }

  /**
   * School scope: open ON the practices. The default window is today's week,
   * and a school whose nearest practice sits further out would read as an
   * empty calendar. Snap the window and the selection to the nearest upcoming
   * practice's day (bucketed in the viewer's timezone, the rule the day list
   * uses) -- once per mode entry; in-mode week navigation never re-snaps.
   *
   * @param feed - The school's upcoming feed, as loaded.
   * @param timeZone - The viewer's profile timezone ('UTC' when absent).
   */
  function snapToSchoolFeed(feed: readonly PracticeResponse[], timeZone: string): void {
    const school = schoolScope.value
    if (school === null || snappedSchool.value === school) return
    snappedSchool.value = school
    const nearest = feed
      .filter((p) => new Date(p.scheduled_at).getTime() > Date.now())
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())[0]
    if (!nearest) return
    const dayKey = calendarDateInTz(nearest.scheduled_at, timeZone)
    weekAnchor.value = parseLocalDateKey(dayKey)
    selectedDate.value = dayKey
  }

  /**
   * Back to the initial state at the account boundary (platform/session.ts):
   * today's window, no filters or scopes, first entry not yet made. The
   * weeks themselves are Colada entries, emptied by the account scope.
   */
  function $reset(): void {
    const today = todayMidnight()
    weekAnchor.value = today
    selectedDate.value = localDateKey(today)
    for (const key of Object.keys(filters) as Array<keyof CalendarFacetFilters>) {
      delete filters[key]
    }
    masterScope.value = null
    masterSchoolFilter.value = null
    schoolScope.value = null
    snappedSchool.value = null
    quietWindow.value = false
    initialized.value = false
  }

  return {
    // state
    weekAnchor,
    selectedDate,
    filters,
    masterScope,
    masterSchoolFilter,
    schoolScope,
    quietWindow,
    // derived
    days,
    canGoPrev,
    maxBackDays,
    weekParams,
    // actions
    selectDay,
    prevWeek,
    nextWeek,
    shiftDays,
    applyFilters,
    setMasterScope,
    setSchoolScope,
    snapToSchoolFeed,
    init,
    $reset,
    // helpers (exported for the view: local day key of a Date)
    localDateKey,
  }
})
