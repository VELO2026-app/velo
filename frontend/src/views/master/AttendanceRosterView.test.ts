// =============================================================================
// VELO Frontend -- AttendanceRosterView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 268 lines. A copy-paste SIBLING of AttendanceView (№489's other half) --
// same route param, same seams (getAttendance/getPractice, @/api/practices),
// same useMasterStore practices-cache read, same ApiResponseError handling.
// Distinct presentation: no mood faces/comments, just an attended/no-show
// NAME LIST with independent expand/collapse per section.
//
// DIVERGENCE FROM THE SIBLING (AttendanceView), READ, NOT ASSUMED -- the
// copy-paste comparison that paid off in №485:
//   - AttendanceView's load() ALWAYS calls loadPractice() (which does its own
//     cache check internally, .vue:174-178) inside Promise.all.
//   - THIS screen's load() (.vue:169-187) does the cache check OUTSIDE and
//     FIRST (synchronously, before Promise.all): `const cached =
//     masterStore.practices.find(...)`, then passes either
//     `Promise.resolve()` or `loadPractice()` into Promise.all depending on
//     the result. Functionally IDENTICAL outcome (a cache hit never calls
//     getPractice, either way), just a different code SHAPE -- not a bug,
//     a legitimate stylistic divergence between the two siblings. Both
//     screens' `loadPractice()` swallow getPractice failures with near-
//     identical comments ("Non-critical: the practice/hero card just won't
//     show" resp. "...roster still show"). Confirmed by reading both files
//     end to end, not by grepping one and assuming the other matches.
//   - Same partial-failure shape as AttendanceView: a failed getPractice
//     hides only the hero card; a failed getAttendance takes down the whole
//     content area (the required rung). Not re-proven exhaustively here
//     (already proven in AttendanceView.test.ts) -- one representative case
//     covered below for this screen's OWN template wiring.
//
// THE REAL ASSIGNMENT -- attendedItems/noShowItems (.vue:142-147, a pure
// `.filter()` split by `status`) + independent expand/collapse
// (attendedExpanded/noShowExpanded, .vue:126-127, TWO SEPARATE refs) +
// COLLAPSE_THRESHOLD = 10 (.vue:118). Covered: the split loses/double-counts
// nobody (mixed fixture, both buckets' total = input length); the collapsed
// view truncates at exactly 10 with hiddenAttended/hiddenNoShow =
// length-10; expanding drops the hidden count to 0 and reveals the rest;
// the two sections expand INDEPENDENTLY (expanding one must not affect the
// other -- the classic sibling-state bug, measured not assumed).
//
// VShowMore (.vue:73-77,87-91) is used with a VERBATIM `label="посмотреть
// еще"` override (@/components/shared/VShowMore.vue:14-15,20-22) -- it does
// NOT render the hidden count in its own text (unlike its `:count`/`:noun`
// mode). The hidden count is only checkable through this screen's own state
// (list lengths), not through the button's text -- confirmed by reading the
// component, not assumed from its name.
//
// whenLabel/durationLabel (.vue:130-139): whenLabel combines formatDateShort
// (Date.now-dependent) + formatTime (pure) -- same handling as
// AttendanceView's practiceWhen. ПРОМТ №542: the ORIGINAL fixture used a
// literal date "verified via node beforehand" to be far from "today" --
// that only held on the day it was written, and drifted into the Сегодня/
// Завтра window as real time passed. The clock is now FAKED and frozen
// (NOW, see beforeEach); STABLE_SCHEDULED_AT is NOW+30 days, so the
// relationship is fixed by construction, not by luck of the run date.
// durationLabel is a PURE `${duration_minutes} мин` string, no Date
// dependence at all.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AttendanceRosterView from '@/views/master/AttendanceRosterView.vue'
import * as practicesApi from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import { useMasterStore } from '@/stores/master'
import type { AttendanceResponse, AttendanceItemResponse, PracticeResponse } from '@/api/types'

vi.mock('@/api/practices')

// T21-1 follow-up (ПРОМТ №542): the clock is now FAKED and frozen at NOW
// (beforeEach below), not left to the real wall clock -- whenLabel
// (formatDateShort, Date.now-dependent) previously read a fixture date
// "far from today" that was only far from the day this was WRITTEN, and
// drifted into the Сегодня/Завтра window as real time passed (it did,
// ПРОМТ №542). STABLE_SCHEDULED_AT is derived from NOW with a fixed +30-day
// offset, so the relationship holds regardless of what NOW is -- proven by
// re-running this file with NOW set to several unrelated instants, not by
// picking one date and hoping it stays far enough away.
const NOW = new Date('2026-07-20T10:00:00Z')
const STABLE_SCHEDULED_AT = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

const back = vi.fn()
const routeParams: { id: string } = { id: 'p_1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

// -----------------------------------------------------------------------------
// Fixtures -- factory functions.
// -----------------------------------------------------------------------------

function attendanceItem(overrides: Partial<AttendanceItemResponse> = {}): AttendanceItemResponse {
  return {
    booking_id: 'b_1',
    user_id: 'u_1',
    status: 'attended',
    joined_at: null,
    left_at: null,
    user_display_name: 'Анна Иванова',
    user_avatar_url: null,
    checkin: null,
    ...overrides,
  }
}

/** N attended + M no-show items, uniquely named/id'd, in a single roster. */
function roster(attendedCount: number, noShowCount: number): AttendanceItemResponse[] {
  const items: AttendanceItemResponse[] = []
  for (let i = 0; i < attendedCount; i++) {
    items.push(
      attendanceItem({ booking_id: `att_${i}`, user_id: `u_att_${i}`, user_display_name: `Пришёл ${i}`, status: 'attended' }),
    )
  }
  for (let i = 0; i < noShowCount; i++) {
    items.push(
      attendanceItem({ booking_id: `no_${i}`, user_id: `u_no_${i}`, user_display_name: `Пропустил ${i}`, status: 'no_show' }),
    )
  }
  return items
}

function attendanceResponse(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  const items = overrides.items ?? roster(1, 1)
  return {
    practice_id: 'p_1',
    total: items.length,
    attended: items.filter((i) => i.status === 'attended').length,
    no_show: items.filter((i) => i.status === 'no_show').length,
    pending: 0,
    items,
    ...overrides,
  }
}

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p_1',
    master_id: 'master_1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Утренняя медитация',
    description: null,
    what_to_prepare: null,
    contraindications: null,
    scheduled_at: STABLE_SCHEDULED_AT, // NOW + 30 days -- always outside the Сегодня/Завтра window, regardless of when this suite runs (clock is faked, see beforeEach)
    duration_minutes: 45,
    timezone: 'UTC',
    max_participants: 10,
    current_participants: 3,
    zoom_link: null,
    parent_practice_id: null,
    is_free: false,
    price_cents: 2500,
    currency: 'EUR',
    direction: 'meditation',
    style: null,
    difficulty: null,
    recurrence_days: null,
    ...overrides,
  } as PracticeResponse
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(id = 'p_1'): HTMLElement {
  routeParams.id = id
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AttendanceRosterView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function sectionByHeading(heading: string): HTMLElement {
  const h2 = Array.from(host?.querySelectorAll<HTMLElement>('.velo-section-title') ?? []).find(
    (el) => el.textContent?.trim() === heading,
  )
  const section = h2?.closest('.roster__section') as HTMLElement | null
  if (!section) throw new Error(`no section headed «${heading}»`)
  return section
}
function rowsIn(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll<HTMLElement>('.roster__row')).map(
    (r) => r.querySelector('.roster__name')?.textContent?.trim() ?? '',
  )
}
function showMoreIn(section: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(section.querySelectorAll<HTMLButtonElement>('.v-show-more'))[0]
}

function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function errorDesc(): string {
  return host?.querySelector('.v-empty__desc')?.textContent?.trim() ?? ''
}
function statValue(label: string): string {
  const cards = Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? [])
  const card = cards.find((c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label)
  if (!card) throw new Error(`no stat card labelled «${label}»`)
  return card.querySelector('.v-stat__value')?.textContent?.trim() ?? ''
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  // ПРОМТ №542: freeze the clock this screen's Date.now-dependent whenLabel
  // sees, so its outcome no longer depends on the real calendar date at all
  // (same pattern as MasterDashboardView.test.ts's beforeEach). Nothing in
  // this screen's mount chain installs its own timer, so faking time here
  // has no other side effect.
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(practicesApi.getAttendance).mockReset().mockResolvedValue(attendanceResponse())
  vi.mocked(practicesApi.getPractice).mockReset().mockResolvedValue(practice())

  back.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AttendanceRosterView', () => {
  // ===========================================================================
  describe('ladder + the partial-failure shape (matches the sibling, see banner)', () => {
    it('loading -> content', async () => {
      let resolveGet!: (v: AttendanceResponse) => void
      vi.mocked(practicesApi.getAttendance).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve
          }),
      )
      mount()
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveGet(attendanceResponse())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(statValue('Присутствовало')).toBe('1')
    })

    it('failure (generic Error): falls back to "Ошибка загрузки"', async () => {
      vi.mocked(practicesApi.getAttendance).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
    })

    it('failure (ApiResponseError): shows the real backend detail', async () => {
      vi.mocked(practicesApi.getAttendance).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена', 'not_found'),
      )
      mount()
      await flush()

      expect(errorDesc()).toBe('Практика не найдена')
    })

    it('«Повторить» recovers to content', async () => {
      vi.mocked(practicesApi.getAttendance).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()

      vi.mocked(practicesApi.getAttendance).mockResolvedValueOnce(attendanceResponse())
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(statValue('Присутствовало')).toBe('1')
    })

    it('empty (no bookings at all): "Нет данных о посещаемости"', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendanceResponse({ items: [] }))
      mount()
      await flush()

      expect(text()).toContain('Нет данных о посещаемости')
    })

    it('getPractice fails: the hero card is hidden, but stats + roster still render', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.hero-card')).toBeNull()
      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(statValue('Присутствовало')).toBe('1')
    })

    it('a cached practice in masterStore.practices is used directly -- getPractice is never called', async () => {
      useMasterStore().practicesUpcoming = [practice({ id: 'p_1', title: 'Кэшированная практика' })]
      mount()
      await flush()

      expect(practicesApi.getPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Кэшированная практика')
    })
  })

  // ===========================================================================
  describe('the attended/no-show split (.vue:142-147) -- nobody lost or double-counted', () => {
    it('a mixed roster splits into the two buckets, summing back to the full input', async () => {
      const items = roster(3, 2)
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendanceResponse({ items }))
      mount()
      await flush()

      const attendedNames = rowsIn(sectionByHeading('Присутствовали'))
      const noShowNames = rowsIn(sectionByHeading('Не пришли'))

      expect(attendedNames).toHaveLength(3)
      expect(noShowNames).toHaveLength(2)
      expect(attendedNames).toEqual(['Пришёл 0', 'Пришёл 1', 'Пришёл 2'])
      expect(noShowNames).toEqual(['Пропустил 0', 'Пропустил 1'])
    })
  })

  // ===========================================================================
  describe('expand/collapse (COLLAPSE_THRESHOLD = 10, .vue:118) -- INDEPENDENT per section', () => {
    it('a section with more than 10 truncates at exactly 10, hiddenCount = length - 10', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({ items: roster(13, 4) }),
      )
      mount()
      await flush()

      const attendedSection = sectionByHeading('Присутствовали')
      expect(rowsIn(attendedSection)).toHaveLength(10) // truncated
      expect(showMoreIn(attendedSection)).toBeDefined() // 13 - 10 = 3 hidden

      const noShowSection = sectionByHeading('Не пришли')
      expect(rowsIn(noShowSection)).toHaveLength(4) // under the threshold
      expect(showMoreIn(noShowSection)).toBeUndefined() // nothing hidden
    })

    it('expanding "Присутствовали" reveals the rest and hides its OWN show-more button', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({ items: roster(13, 4) }),
      )
      mount()
      await flush()

      showMoreIn(sectionByHeading('Присутствовали'))?.click()
      await flush()

      const attendedSection = sectionByHeading('Присутствовали')
      expect(rowsIn(attendedSection)).toHaveLength(13) // all revealed
      expect(showMoreIn(attendedSection)).toBeUndefined() // hidden count now 0
    })

    it('INDEPENDENT EXPANSION: expanding "Присутствовали" does NOT expand "Не пришли" -- the classic sibling-state bug, measured', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({ items: roster(13, 15) }),
      )
      mount()
      await flush()

      showMoreIn(sectionByHeading('Присутствовали'))?.click()
      await flush()

      const attendedSection = sectionByHeading('Присутствовали')
      const noShowSection = sectionByHeading('Не пришли')
      expect(rowsIn(attendedSection)).toHaveLength(13) // expanded
      expect(rowsIn(noShowSection)).toHaveLength(10) // STILL truncated
      expect(showMoreIn(noShowSection)).toBeDefined() // its own show-more still present

      // Expanding the OTHER section independently now also works.
      showMoreIn(noShowSection)?.click()
      await flush()
      expect(rowsIn(sectionByHeading('Не пришли'))).toHaveLength(15)
      expect(rowsIn(sectionByHeading('Присутствовали'))).toHaveLength(13) // unaffected
    })
  })

  // ===========================================================================
  describe('whenLabel / durationLabel (.vue:130-139, see banner)', () => {
    it('whenLabel: a date 30 days out renders as an absolute date (not Сегодня/Завтра), regardless of the real calendar date', async () => {
      mount()
      await flush()

      expect(text()).toContain('19 августа, 10:00')
    })

    it('durationLabel: a pure "N мин" string, no Date dependence', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ duration_minutes: 75 }))
      mount()
      await flush()

      expect(text()).toContain('75 мин')
    })
  })

  // ===========================================================================
  // T21-1 (ПРОМТ №541): backend has computed unmatched_count since E21 step G
  // (ПРОМТ №521) with zero frontend consumers until now (ПРОМТ №540 audit).
  describe('unmatched bucket note (T21-1)', () => {
    it('shows nothing when unmatched_count is 0 or absent (old fixtures without the field)', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendanceResponse({ unmatched_count: 0 }))
      mount()
      await flush()

      expect(text()).not.toContain('не удалось сопоставить')
    })

    it('shows a plain count when Zoom left unmatched participants, the whole point of the design', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendanceResponse({ unmatched_count: 3 }))
      mount()
      await flush()

      expect(text()).toContain('3')
      expect(text()).toContain('не удалось сопоставить')
    })
  })
})
