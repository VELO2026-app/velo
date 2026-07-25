// =============================================================================
// VELO Frontend -- AttendanceView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 293 lines. Route-param screen over a single practice's attendance/check-ins.
// PATTERN = detail screen, TWO independent-but-coordinated fetches (getAttendance
// + getPractice, both @/api/practices) + a real Pinia useMasterStore (read only,
// for `masterStore.practices` as a cache -- never fetched by this screen itself).
// ApiResponseError kept real. No watch, no mutating action -- purely read-only.
//
// TWO SEPARATE LOADS, THEIR REAL RELATIONSHIP -- READ, NOT ASSUMED: `load()`
// (.vue:160-171) calls `Promise.all([getAttendance(practiceId), loadPractice()])`
// -- loadPractice() IS called FROM load(), not independently, and it has its
// OWN try/catch (.vue:173-184, "Non-critical: the practice card just won't
// show") that SWALLOWS any getPractice failure internally, so `loadPractice()`
// itself never rejects. Net effect: `Promise.all` can only actually REJECT
// because of `getAttendance` failing -- a getPractice failure can never trigger
// the outer catch at all.
//
// THE PARTIAL-FAILURE ANSWER -- MEASURED, CLEAN NEGATIVE: a failed practice
// fetch does NOT blank the attendance list -- `practice.value` simply stays
// null, hiding only the `v-if="practice"` practice card (.vue:50), while the
// full participant list renders normally (attendance succeeded independently).
// The reverse (attendance fails) DOES take down the whole content area,
// including a practice card that might have loaded fine -- but that's the
// ladder's OWN correct behavior (attendance is the required rung), not a
// partial-failure bug. Both directions asserted below, not assumed.
//
// loadPractice() ALSO checks `masterStore.practices` for a cache hit FIRST
// (.vue:174-178) and returns synchronously without ever calling getPractice --
// asserted below (seeded cache -> getPractice never called).
//
// sortedItems (.vue:137-144): rank 0 = has a checkin, rank 1 = no checkin/not
// no_show (pending/confirmed), rank 2 = no_show. Proven below with a fixture
// whose INPUT order is the reverse of the expected output -- an already-sorted
// fixture would prove nothing.
//
// practiceWhen (.vue:129-134) combines formatDateShort (Date.now-dependent for
// Сегодня/Завтра) + formatTime (PURE, no `new Date()` anywhere in it, verified
// by reading format.ts:207-214). ПРОМТ №542: the ORIGINAL fixture picked a
// date "far from today" as of when this was written and verified the exact
// string via node beforehand -- that relationship decays with every day that
// passes and did in fact break (Сегодня/Завтра window reached it). The clock
// is now FAKED and frozen (NOW, see beforeEach); the fixture date is NOW+30
// days, so the relationship is fixed by construction, not by the luck of
// which day the suite happens to run on.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AttendanceView from '@/views/master/AttendanceView.vue'
import * as practicesApi from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import { useMasterStore } from '@/stores/master'
import type { AttendanceResponse, AttendanceItemResponse, PracticeResponse } from '@/api/types'

vi.mock('@/api/practices')

// T21-1 follow-up (ПРОМТ №542): see AttendanceRosterView.test.ts's sibling
// comment -- the clock is now FAKED and frozen at NOW (beforeEach below),
// not left to the real wall clock. practiceWhen (formatDateShort, Date.now-
// dependent) previously read a fixture date "far from today" that was only
// far from the day this was WRITTEN, and drifted into the Сегодня/Завтра
// window as real time passed (it did, ПРОМТ №542). STABLE_SCHEDULED_AT is
// derived from NOW with a fixed +30-day offset, so the relationship holds
// regardless of what NOW is.
const NOW = new Date('2026-07-20T10:00:00Z')
const STABLE_SCHEDULED_AT = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

const back = vi.fn()
const routeParams: { id: string } = { id: 'p_1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

// -----------------------------------------------------------------------------
// Fixtures -- factory functions (per-call), the №482/№488 isolation discipline.
// -----------------------------------------------------------------------------

function attendanceItem(overrides: Partial<AttendanceItemResponse> = {}): AttendanceItemResponse {
  return {
    booking_id: 'b_1',
    user_id: 'u_1',
    status: 'confirmed',
    joined_at: null,
    left_at: null,
    user_display_name: 'Анна Иванова',
    user_avatar_url: null,
    checkin: null,
    ...overrides,
  }
}

function attendanceResponse(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  return {
    practice_id: 'p_1',
    total: 1,
    attended: 0,
    no_show: 0,
    pending: 1,
    items: [attendanceItem()],
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
    duration_minutes: 60,
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
  app = createApp(AttendanceView)
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

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.checkins__item') ?? [])
}
function rowByName(name: string): HTMLElement | undefined {
  return rows().find((r) => r.querySelector('.checkins__name')?.textContent?.trim() === name)
}
function rowNames(): string[] {
  return rows().map((r) => r.querySelector('.checkins__name')?.textContent?.trim() ?? '')
}

function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function errorDesc(): string {
  return host?.querySelector('.v-empty__desc')?.textContent?.trim() ?? ''
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  // ПРОМТ №542: freeze the clock this screen's Date.now-dependent
  // practiceWhen sees, so its outcome no longer depends on the real
  // calendar date at all (same pattern as MasterDashboardView.test.ts).
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

describe('AttendanceView', () => {
  // ===========================================================================
  describe('ladder', () => {
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
      expect(rows().length).toBe(1)
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
      expect(rows().length).toBe(1)
    })

    it('empty (total===0): "Нет записавшихся"', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({ total: 0, items: [] }),
      )
      mount()
      await flush()

      expect(text()).toContain('Нет записавшихся')
      expect(rows()).toHaveLength(0)
    })
  })

  // ===========================================================================
  describe('the partial-failure answer (see banner)', () => {
    it('getPractice fails: the practice card is hidden, but the FULL participant list still renders', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new Error('ECONNRESET'))
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({ total: 1, items: [attendanceItem({ user_display_name: 'Борис' })] }),
      )
      mount()
      await flush()

      expect(host?.querySelector('.checkins__practice')).toBeNull() // no practice card
      expect(host?.querySelector('.v-empty')).toBeNull() // NOT the error rung either
      expect(rowByName('Борис')).toBeDefined() // attendance list intact
    })

    it('getAttendance fails: the WHOLE content area (including any practice data) is replaced by the error rung', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice())
      vi.mocked(practicesApi.getAttendance).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty')).not.toBeNull()
      expect(host?.querySelector('.checkins__practice')).toBeNull()
      expect(rows()).toHaveLength(0)
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
  describe('sortedItems (.vue:137-144) -- proven with a SCRAMBLED input order', () => {
    it('checked-in first, then awaiting, then no-show -- regardless of input order', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          total: 3,
          items: [
            // Deliberately in the REVERSE of the expected output order.
            attendanceItem({
              booking_id: 'b_noshow',
              user_display_name: 'Не Пришёл',
              status: 'no_show',
              checkin: null,
            }),
            attendanceItem({
              booking_id: 'b_pending',
              user_display_name: 'Ожидающий',
              status: 'confirmed',
              checkin: null,
            }),
            attendanceItem({
              booking_id: 'b_checked',
              user_display_name: 'Отметился',
              status: 'confirmed',
              checkin: { mood: 7, comment: null },
            }),
          ],
        }),
      )
      mount()
      await flush()

      expect(rowNames()).toEqual(['Отметился', 'Ожидающий', 'Не Пришёл'])
    })
  })

  // ===========================================================================
  describe('checkinBadge (.vue:121-125) and practiceWhen (.vue:129-134)', () => {
    it('badge = "checkedIn/total"', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          total: 3,
          items: [
            attendanceItem({ booking_id: 'b1', checkin: { mood: 5, comment: null } }),
            attendanceItem({ booking_id: 'b2', checkin: null }),
            attendanceItem({ booking_id: 'b3', checkin: null }),
          ],
        }),
      )
      mount()
      await flush()

      expect(text()).toContain('1/3')
    })

    it('practiceWhen: a date 30 days out renders as an absolute date (not Сегодня/Завтра), regardless of the real calendar date', async () => {
      mount()
      await flush()

      expect(text()).toContain('19 августа, 10:00')
    })

    it('no practice loaded: practiceWhen is empty, no sub-line renders', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.checkins__practice-sub')).toBeNull()
    })
  })

  // ===========================================================================
  describe('displayName / initials (.vue:147-153) fallbacks', () => {
    it('user_display_name present: shown as-is', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({ items: [attendanceItem({ user_display_name: 'Виктория Орлова' })] }),
      )
      mount()
      await flush()

      expect(rowByName('Виктория Орлова')).toBeDefined()
    })

    it('user_display_name absent: falls back to "#" + first 8 chars of user_id', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          items: [attendanceItem({ user_display_name: null, user_id: '12345678-abcd-ef00' })],
        }),
      )
      mount()
      await flush()

      expect(rowByName('#12345678')).toBeDefined()
    })

    it('initials: first letter of the display name, uppercased', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          items: [
            attendanceItem({ user_display_name: 'жанна', status: 'confirmed', checkin: null }),
          ],
        }),
      )
      mount()
      await flush()

      expect(host?.querySelector('.checkins__face--pending')?.textContent?.trim()).toBe('Ж')
    })
  })

  // ===========================================================================
  describe('per-status body content (.vue:74-84)', () => {
    it('checked in WITH a comment: shows the comment, not a status line', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          items: [
            attendanceItem({
              user_display_name: 'С Комментарием',
              checkin: { mood: 8, comment: 'Было прекрасно!' },
            }),
          ],
        }),
      )
      mount()
      await flush()

      const row = rowByName('С Комментарием')
      expect(row?.querySelector('.checkins__comment')?.textContent?.trim()).toBe('Было прекрасно!')
      expect(row?.querySelector('.checkins__meta')).toBeNull()
    })

    it('checked in WITHOUT a comment: "Без комментария", not "Ожидает check-in"', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          items: [attendanceItem({ user_display_name: 'Без Слов', checkin: { mood: 6, comment: null } })],
        }),
      )
      mount()
      await flush()

      expect(rowByName('Без Слов')?.querySelector('.checkins__meta')?.textContent?.trim()).toBe(
        'Без комментария',
      )
    })

    it('no_show: "Не пришёл" + the × face, not a mood avatar', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          items: [
            attendanceItem({ user_display_name: 'Пропустил', status: 'no_show', checkin: null }),
          ],
        }),
      )
      mount()
      await flush()

      const row = rowByName('Пропустил')
      expect(row?.querySelector('.checkins__face--noshow')).not.toBeNull()
      expect(row?.querySelector('.checkins__meta')?.textContent?.trim()).toBe('Не пришёл')
    })

    it('pending (no checkin, not no_show): "Ожидает check-in" + initials face', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendanceResponse({
          items: [
            attendanceItem({ user_display_name: 'Ждёт', status: 'confirmed', checkin: null }),
          ],
        }),
      )
      mount()
      await flush()

      const row = rowByName('Ждёт')
      expect(row?.querySelector('.checkins__face--pending')).not.toBeNull()
      expect(row?.querySelector('.checkins__meta')?.textContent?.trim()).toBe('Ожидает check-in')
    })
  })
})
