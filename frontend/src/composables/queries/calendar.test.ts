// =============================================================================
// VELO Frontend -- the calendar's week on Colada (FE-166 step 4)
// =============================================================================
//
// What moved out of stores/calendar.ts: loading the week (the request, the
// scopes, persistence, quiet vs real reloads, errors) and the two derived
// views -- daysWithPractices / selectedDayPractices -- with their F5
// viewer-timezone bucketing and "already started" exclusion. Colada, Pinia and
// persistedCache are real; the API wrappers are mocked. TZ is stubbed to UTC
// so the store's LOCAL date math lines up with the UTC fixtures (the
// technique of stores/calendar.test.ts).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { useCalendarWeek } from '@/composables/queries/calendar'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { useCalendarStore } from '@/stores/calendar'
import { useAuthStore } from '@/stores/auth'
import { flushPersisted, setPersistOwner } from '@/composables/persistedCache'
import * as practicesApi from '@/api/practices'
import * as schoolsApi from '@/api/schools'
import type { PracticeResponse, UserResponse } from '@/api/types'

vi.mock('@/api/practices')
vi.mock('@/api/schools')

const NOW_ISO = '2026-06-15T12:00:00.000Z'

function practice(id: string, scheduledAt: string, extra: Partial<PracticeResponse> = {}) {
  return { id, scheduled_at: scheduledAt, ...extra } as PracticeResponse
}

function page(items: PracticeResponse[]) {
  return { items, total: items.length, limit: 100, offset: 0 }
}

let app: App | null = null
let pinia: Pinia
let week: ReturnType<typeof useCalendarWeek>

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await vi.advanceTimersByTimeAsync(0)
}

/** A fresh app's Pinia with Colada, as app.ts installs it. */
function freshPinia(): void {
  pinia = createPinia()
  createApp({}).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
}

/** Mount a screen that reads the week (after `before` set the store up, as CalendarView's setup does). */
function mount(before: () => void = () => {}): void {
  const Screen = defineComponent({
    setup() {
      before()
      useCalendarStore().init()
      week = useCalendarWeek()
      return () => h('div')
    },
  })
  app = createApp(Screen).use(pinia)
  app.mount(document.createElement('div'))
}

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC')
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW_ISO))
  freshPinia()
  vi.mocked(practicesApi.getPractices).mockReset().mockResolvedValue(page([]))
  vi.mocked(schoolsApi.getSchoolPractices).mockReset().mockResolvedValue(page([]))
})

afterEach(() => {
  app?.unmount()
  app = null
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('useCalendarWeek -- loading the week', () => {
  it('requests the week +-1 day (UTC boundaries), sorted ascending, and shows it', async () => {
    const items = [practice('a', '2026-06-16T10:00:00Z')]
    vi.mocked(practicesApi.getPractices).mockResolvedValue(page(items))
    mount()
    await flush()

    expect(practicesApi.getPractices).toHaveBeenCalledWith(
      expect.objectContaining({
        date_from: '2026-06-14T00:00:00.000Z',
        date_to: '2026-06-22T23:59:59.999Z',
        sort_by: 'scheduled_at',
        sort_order: 'asc',
      }),
      100,
      0,
    )
    expect(week.weekPractices.value).toEqual(items)
    expect(week.loading.value).toBe(false)
    expect(week.error.value).toBeNull()
  })

  it('a booking mutation refetches the week on screen quietly: no loading flag, data kept', async () => {
    const items = [practice('a', '2026-06-16T10:00:00Z')]
    vi.mocked(practicesApi.getPractices).mockResolvedValue(page(items))
    mount()
    await flush()

    const refetched = invalidateAfter(useQueryCache(pinia), 'cancelBooking')
    await nextTick()
    expect(week.loading.value).toBe(false)
    expect(week.weekPractices.value).toEqual(items)
    await refetched
    expect(practicesApi.getPractices).toHaveBeenCalledTimes(2)
  })

  it("a restart draws the last session's default week at once, then revalidates", async () => {
    const items = [practice('kept', '2026-06-16T10:00:00Z')]
    vi.mocked(practicesApi.getPractices).mockResolvedValue(page(items))
    setPersistOwner('u1')
    mount()
    await flush()
    flushPersisted()
    app?.unmount()

    freshPinia() // a fresh app
    vi.mocked(practicesApi.getPractices).mockReturnValue(new Promise(() => {}))
    mount()
    await nextTick()

    expect(week.weekPractices.value.map((p) => p.id)).toEqual(['kept'])
    expect(week.loading.value).toBe(false)
  })

  it('a master scope with a school filter keeps only THAT school practices of the master (owner 2026-10-03)', async () => {
    vi.mocked(practicesApi.getPractices).mockResolvedValue(
      page([
        practice('school', '2026-06-16T10:00:00Z', { school_id: 'g1' }),
        practice('personal', '2026-06-16T11:00:00Z', { school_id: null }),
        practice('foreign', '2026-06-16T12:00:00Z', { school_id: 'g2' }),
      ]),
    )
    mount(() => useCalendarStore().setMasterScope('master_1', 'g1'))
    await flush()

    expect(practicesApi.getPractices).toHaveBeenCalledWith(
      expect.objectContaining({ master_id: 'master_1', status: 'scheduled' }),
      100,
      0,
    )
    expect(week.weekPractices.value.map((p) => p.id)).toEqual(['school'])
  })

  it('a master scope WITHOUT a school filter keeps the whole master feed (owner 2026-10-03)', async () => {
    vi.mocked(practicesApi.getPractices).mockResolvedValue(
      page([
        practice('school', '2026-06-16T10:00:00Z', { school_id: 'g1' }),
        practice('personal', '2026-06-16T11:00:00Z', { school_id: null }),
      ]),
    )
    mount(() => useCalendarStore().setMasterScope('master_1'))
    await flush()

    expect(week.weekPractices.value.map((p) => p.id)).toEqual(['school', 'personal'])
  })

  it('on failure: the raw error, and nothing of the failed week on screen', async () => {
    const error = new Error('network down')
    vi.mocked(practicesApi.getPractices).mockRejectedValue(error)
    mount()
    await flush()

    expect(week.error.value).toBe(error)
    expect(week.weekPractices.value).toEqual([])
    expect(week.loading.value).toBe(false)
  })

  it('a failed QUIET refresh (ribbon scroll) keeps the practices on screen', async () => {
    vi.mocked(practicesApi.getPractices).mockResolvedValue(
      page([practice('a', '2026-06-16T10:00:00Z')]),
    )
    mount()
    await flush()

    vi.mocked(practicesApi.getPractices).mockRejectedValue(new Error('network down'))
    useCalendarStore().shiftDays(3)
    await flush()

    expect(week.error.value).not.toBeNull()
    expect(week.weekPractices.value.map((p) => p.id)).toEqual(['a'])
  })

  it('a real reload (next week) shows the loader while the previous week stands in', async () => {
    vi.mocked(practicesApi.getPractices).mockResolvedValue(
      page([practice('a', '2026-06-16T10:00:00Z')]),
    )
    mount()
    await flush()

    vi.mocked(practicesApi.getPractices).mockReturnValue(new Promise(() => {}))
    useCalendarStore().nextWeek()
    await flush()

    expect(week.loading.value).toBe(true)
    // The selected day moved +7: nothing of the old week lands on it.
    expect(week.selectedDayPractices(Date.now())).toEqual([])
  })

  it('a ribbon scroll is quiet: no loader while the next range loads', async () => {
    mount()
    await flush()

    vi.mocked(practicesApi.getPractices).mockReturnValue(new Promise(() => {}))
    useCalendarStore().shiftDays(2)
    await flush()

    expect(week.loading.value).toBe(false)
  })
})

describe('useCalendarWeek -- school scope', () => {
  it("slices the window out of the school's whole feed and opens on its nearest practice", async () => {
    vi.mocked(schoolsApi.getSchoolPractices).mockResolvedValue(
      page([
        practice('near', '2026-07-02T10:00:00Z'),
        practice('next-week', '2026-07-12T10:00:00Z'),
      ]),
    )
    mount(() => useCalendarStore().setSchoolScope('g7'))
    await flush()

    expect(schoolsApi.getSchoolPractices).toHaveBeenCalledWith('g7', 100, 0)
    expect(practicesApi.getPractices).not.toHaveBeenCalled()
    expect(useCalendarStore().selectedDate).toBe('2026-07-02')
    expect(week.weekPractices.value.map((p) => p.id)).toEqual(['near'])
  })
})

describe('useCalendarWeek -- derived views', () => {
  async function mountWith(items: PracticeResponse[], setup: () => void = () => {}) {
    vi.mocked(practicesApi.getPractices).mockResolvedValue(page(items))
    mount(setup)
    await flush()
  }

  it('daysWithPractices falls back to UTC when the viewer has no profile timezone', async () => {
    // 21:30 UTC on the 15th stays the 15th under a UTC bucket.
    await mountWith([practice('p1', '2026-06-15T21:30:00Z')])

    expect(week.daysWithPractices(Date.now())).toEqual(new Set(['2026-06-15']))
  })

  it("daysWithPractices buckets by the VIEWER'S profile timezone and drops already-started practices", async () => {
    await mountWith(
      [
        // 21:30 UTC (future: now is 12:00 UTC) = 00:30 the NEXT day in Moscow (UTC+3).
        practice('future', '2026-06-15T21:30:00Z'),
        // 10:00 UTC is BEFORE "now" -- already started, must be excluded.
        practice('started', '2026-06-15T10:00:00Z'),
      ],
      () => {
        useAuthStore().user = { id: 'u1', timezone: 'Europe/Moscow' } as unknown as UserResponse
      },
    )

    expect(week.daysWithPractices(Date.now())).toEqual(new Set(['2026-06-16']))
  })

  it('selectedDayPractices filters to the selected day, excludes started ones, sorts ascending', async () => {
    await mountWith([
      practice('late', '2026-06-15T18:00:00Z'),
      practice('early', '2026-06-15T14:00:00Z'),
      practice('started', '2026-06-15T09:00:00Z'), // before "now" (12:00)
      practice('other-day', '2026-06-16T14:00:00Z'),
    ])

    expect(week.selectedDayPractices(Date.now()).map((p) => p.id)).toEqual(['early', 'late'])
  })

  it('selectedDayPractices is empty when nothing matches the selected day', async () => {
    await mountWith([practice('p', '2026-06-15T14:00:00Z')])
    useCalendarStore().selectDay('2026-06-19')

    expect(week.selectedDayPractices(Date.now())).toEqual([])
  })
})
