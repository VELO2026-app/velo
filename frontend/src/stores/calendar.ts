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
import { ref, reactive, computed } from 'vue'
import { getPractices } from '@/api/practices'
import { extractApiError } from '@/composables/useApiError'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import type { PracticeFilters, PracticeResponse } from '@/api/types'

// Calendar-specific facet filters (excludes pagination/sort/date-range,
// which the store manages itself). Mirrors the facet subset of
// PracticeFilters that the Calendar UI controls.
export interface CalendarFacetFilters {
  practice_type?: PracticeFilters['practice_type']
  direction?: PracticeFilters['direction']
  difficulty?: PracticeFilters['difficulty']
  style?: PracticeFilters['style']
  duration_bucket?: PracticeFilters['duration_bucket']
  time_of_day?: PracticeFilters['time_of_day']
}

// ---------------------------------------------------------------------------
// Date helpers (local, dependency-free)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for a Date in a specific IANA timezone (en-CA gives ISO order). */
function calendarDateInTz(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso))
}

/** YYYY-MM-DD for a Date in the browser's local timezone. */
function localDateKey(d: Date): string {
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
function parseLocalDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}

/** Today at local midnight. */
function todayMidnight(): Date {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return t
}

export const useCalendarStore = defineStore('calendar', () => {
  // -- State --
  // First day of the currently viewed 7-day window (local midnight).
  // Defaults to today; never moved earlier than today via the UI.
  const weekAnchor = ref<Date>(todayMidnight())
  // Selected day key (YYYY-MM-DD, local). Defaults to today.
  const selectedDate = ref<string>(localDateKey(weekAnchor.value))
  // Practices for the whole visible week (one request).
  const weekPractices = ref<PracticeResponse[]>([])
  // Active facet filters (server-applied on load).
  const filters = reactive<CalendarFacetFilters>({})

  const loading = ref(false)
  const error = ref<string | null>(null)

  // First-entry guard: init() snaps the window to today only the FIRST time the
  // Calendar is opened in a session. On re-entry (e.g. returning from a practice
  // detail, or re-tapping the tab) the user's selected day/week is preserved —
  // only the data is refreshed. Reset on a fresh app launch (store recreated).
  const initialized = ref(false)

  // Ticks each minute so the selected-day list drops a practice the moment it
  // starts (a started practice can no longer be booked). The backend feed
  // already excludes started practices on fetch; this keeps the open calendar
  // correct live, without waiting for a reload.
  const now = ref<number>(Date.now())
  setInterval(() => {
    now.value = Date.now()
  }, 60_000)

  // F5: the timezone in which THIS VIEWER sees practice times (their profile).
  // Used to bucket practices into calendar days so the day matches the time
  // shown on the card. ComputedRef -> groupings below stay reactive if the
  // profile timezone changes within the session.
  const viewerTz = useViewerTimezone()

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

  // -- Derived: set of local-day keys that have at least one practice --
  // Markers are computed in the VIEWER'S profile timezone (F5) so a practice
  // shows under the same day its card time is rendered in. Falls back to 'UTC'
  // (never the browser) when the profile timezone is absent.
  const daysWithPractices = computed<Set<string>>(() => {
    const tz = viewerTz.value ?? 'UTC'
    const set = new Set<string>()
    for (const p of weekPractices.value) {
      // Skip already-started practices so a day's dot matches its (filtered)
      // list — a day whose practices have all started shows no dot.
      if (new Date(p.scheduled_at).getTime() <= now.value) continue
      set.add(calendarDateInTz(p.scheduled_at, tz))
    }
    return set
  })

  // -- Derived: practices on the selected day (client-side slice) --
  const selectedDayPractices = computed<PracticeResponse[]>(() => {
    const tz = viewerTz.value ?? 'UTC'
    return (
      weekPractices.value
        .filter((p) => calendarDateInTz(p.scheduled_at, tz) === selectedDate.value)
        // Hide already-started practices (can't be booked anymore). Comparison is
        // in epoch ms (tz-independent); for future days every practice passes.
        .filter((p) => new Date(p.scheduled_at).getTime() > now.value)
        .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    )
  })

  // -- Actions --

  let loadToken = 0
  /**
   * Load every practice in the current week in one request.
   * date_from/date_to are the local Monday 00:00 .. Sunday 23:59:59.999.
   * Facet filters are passed through to the backend.
   *
   * [ribbon perf] `silent`: a scroll-driven reload must not churn the UI
   * state (loader/error) -- the ribbon commit is a background refresh for
   * the new window's day markers. The token drops stale responses: rapid
   * scroll/arrow sequences fire overlapping requests and the LAST one owns
   * the truth -- an earlier response landing late must not clobber it.
   */
  async function loadWeek(silent = false): Promise<void> {
    const token = ++loadToken
    if (!silent) loading.value = true
    error.value = null

    const week = days.value
    // W-2: the week boundaries are local (browser TZ), but the server filters
    // scheduled_at in UTC and practices carry their OWN timezone. Near midnight
    // in extreme timezones a practice that belongs to this week locally can
    // fall just outside the UTC window. Widen the requested range by one day
    // on each side so no such practice is missed; the client still groups by
    // calendarDateInTz, so the extra days never leak into the wrong week.
    const from = new Date(week[0]!)
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - 1)
    const to = new Date(week[6]!)
    to.setHours(23, 59, 59, 999)
    to.setDate(to.getDate() + 1)

    // [ribbon] The selected day may sit OUTSIDE the visible week -- the
    // ribbon scrolls freely while the selection keeps its date (shiftDays).
    // Widen the fetched range to cover the selected date too, so the list
    // below never empties on a scroll; the client still groups by
    // calendarDateInTz, so nothing leaks into the wrong day.
    const selDay = parseLocalDateKey(selectedDate.value)
    const selFrom = new Date(selDay)
    selFrom.setDate(selDay.getDate() - 1)
    const selTo = new Date(selDay)
    selTo.setHours(23, 59, 59, 999)
    selTo.setDate(selDay.getDate() + 1)
    if (selFrom < from) from.setTime(selFrom.getTime())
    if (selTo > to) to.setTime(selTo.getTime())

    const query: PracticeFilters = {
      ...filters,
      date_from: from.toISOString(),
      date_to: to.toISOString(),
      sort_by: 'scheduled_at',
      sort_order: 'asc',
    }

    try {
      // A week (+- 1 day buffer) of practices is small; one page covers it.
      const res = await getPractices(query, 100, 0)
      if (token !== loadToken) return // superseded by a newer load
      weekPractices.value = res.items
    } catch (e) {
      if (token !== loadToken) return // superseded -- keep the newer truth
      error.value = extractApiError(e, 'Не удалось загрузить календарь')
      weekPractices.value = []
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  /** Select a specific day (YYYY-MM-DD, local). Does not reload (same week). */
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
  }

  /** Move the window 7 days back and reload. No-op if already at today. */
  async function prevWeek(): Promise<void> {
    if (!canGoPrev.value) return
    shiftWindow(-7)
    await loadWeek()
  }

  /** Move the window 7 days forward and reload. */
  async function nextWeek(): Promise<void> {
    shiftWindow(7)
    await loadWeek()
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
   * loadWeek widens its range to cover the selected date. The reload is
   * SILENT (a marker refresh -- no loader/error churn).
   */
  async function shiftDays(delta: number): Promise<void> {
    const clamped = Math.max(delta, -maxBackDays.value)
    if (clamped === 0) return
    const a = new Date(weekAnchor.value)
    a.setDate(a.getDate() + clamped)
    weekAnchor.value = a
    // Scroll is ONLY scroll -- FULL STOP. The selection NEVER moves: in the
    // default state (today selected, today = the first visible day) a clamp
    // to the visible window would re-introduce exactly the bug this action
    // exists to kill -- every scroll dragging the selection (and the list
    // below) along. The list keeps showing the selected day regardless of
    // how far the ribbon scrolls, because loadWeek widens its range to
    // cover the selected date (see there).
    await loadWeek(true)
  }

  /** Replace facet filters and reload the current week. */
  async function applyFilters(next: CalendarFacetFilters): Promise<void> {
    // Reassign keys explicitly so cleared facets (undefined) are respected.
    filters.practice_type = next.practice_type
    filters.direction = next.direction
    filters.difficulty = next.difficulty
    filters.style = next.style
    filters.duration_bucket = next.duration_bucket
    filters.time_of_day = next.time_of_day
    await loadWeek()
  }

  /**
   * Open the Calendar. On the FIRST entry of a session, snap the window to
   * today. On re-entry (returning from a practice detail, re-tapping the tab)
   * keep the user's selected day/week — only refresh the data — so leaving and
   * coming back lands on the same day the user was viewing.
   */
  async function init(): Promise<void> {
    if (!initialized.value) {
      const today = todayMidnight()
      weekAnchor.value = today
      selectedDate.value = localDateKey(today)
      initialized.value = true
    }
    await loadWeek()
  }

  return {
    // state
    weekAnchor,
    selectedDate,
    weekPractices,
    filters,
    loading,
    error,
    // derived
    days,
    canGoPrev,
    maxBackDays,
    daysWithPractices,
    selectedDayPractices,
    // actions
    loadWeek,
    selectDay,
    prevWeek,
    nextWeek,
    shiftDays,
    applyFilters,
    init,
    // helpers (exported for the view: local day key of a Date)
    localDateKey,
  }
})
