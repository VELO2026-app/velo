// =============================================================================
// VELO Frontend -- AdminPracticesView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 214 lines. Establishes the ADMIN-STORE harness (real useAdminStore, seeded
// ref) that later admin-store screens (incl. the heavier Dashboard) build on.
//
// PATTERN = list-with-full-ladder + a THIN admin-store read. Confirmed by
// reading every import AND stores/admin.ts end to end: the list itself is
// driven by getAdminPractices (@/api/admin, .vue:124) called directly -- the
// store is read for exactly ONE value, `adminStore.stats?.practices_count`
// (.vue:89), feeding the "Все" segment badge. This screen never calls
// fetchDashboard.
//
// ADMIN-STORE SETUP: stores/admin.ts is a setup store whose `stats` is a
// plain `ref<AdminStatsResponse | null>(null)` returned directly from the
// composition function (admin.ts:23,84) -- writable from outside. Pattern
// used below: create + activate a fresh Pinia, get the REAL useAdminStore,
// and SEED `store.stats = <fixture>` directly. NOT mocked as a module, NOT
// its actions stubbed -- this screen only ever READS the ref.
//
// PracticeListCard (@/components/shared) READ END TO END, confirmed to have
// NO fetch seam of its own: no onMounted, no API import, purely a computed
// wrapper over props + the pure `practiceIconFor` util (displayHelpers.ts).
// Left fully real, driven via props/slots exactly as the screen wires it.
//
// CORRECTION TO RECON: formatDateShort (@/utils/format.ts:65-92) is NOT
// Date.now-independent -- it reads `new Date()` internally (format.ts:67) to
// decide the "Сегодня"/"Завтра" relative labels vs a plain "28 февраля" date.
// A fixture dated near the real run date would make this suite flaky
// depending on WHEN it runs.
//
// ПРОМТ №563 (flagged by 137bd8c, fixed here): the ORIGINAL fixture picked
// 2030-03-15 as "far enough in the future to never collide" -- true only
// until 2030 itself, a long fuse, not a fix. Same root-cause treatment as
// AttendanceView.test.ts/AttendanceRosterView.test.ts (137bd8c): the clock
// is now FAKED and frozen at NOW (beforeEach below), and the fixture date is
// derived as NOW + 30 days, so the relationship holds by construction
// regardless of which day the suite runs on. Exact rendered strings ("21
// августа" / "13:00" for NOW=2026-07-22T10:00:00Z + 30 days, in
// Europe/Moscow) verified directly via node before writing the assertions
// below, not guessed.
//
// MONEY: none on this screen. Cyrillic fixtures/expected strings below were
// still typed via the Write tool, not a shell heredoc, per house habit.
//
// No modal, no v-show (grepped -- v-if throughout). No order dependence --
// every test mounts its own app + fresh Pinia.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AdminPracticesView from '@/views/admin/AdminPracticesView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import { useAdminStore } from '@/stores/admin'
import type { AdminPracticeListItem, AdminStatsResponse } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

// ПРОМТ №563: clock is FAKED and frozen at NOW (beforeEach below), same
// pattern as AttendanceView.test.ts/AttendanceRosterView.test.ts (137bd8c).
// STABLE_SCHEDULED_AT is NOW + 30 days, so formatDateShort's Сегодня/Завтра
// branch can never collide with it regardless of when this suite runs.
const NOW = new Date('2026-07-22T10:00:00Z')
const STABLE_SCHEDULED_AT = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function practice(overrides: Partial<AdminPracticeListItem> = {}): AdminPracticeListItem {
  return {
    id: 'p_1',
    title: 'Утренняя медитация',
    direction: 'meditation',
    master_name: 'Анна Мастерова',
    master_verified: true,
    scheduled_at: STABLE_SCHEDULED_AT,
    duration_minutes: 60,
    booked: 5,
    capacity: 10,
    status: 'scheduled',
    timezone: 'Europe/Moscow',
    ...overrides,
  }
}

const P_NOT_FULL = practice({ id: 'p_not_full', title: 'Утренняя медитация', booked: 5, capacity: 10 })
const P_FULL = practice({ id: 'p_full', title: 'Вечерняя йога', booked: 10, capacity: 10 })
const P_UNLIMITED = practice({ id: 'p_unlimited', title: 'Открытый круг', booked: 3, capacity: null })

function paginated(items: AdminPracticeListItem[], total?: number) {
  return { items, total: total ?? items.length, limit: 100, offset: 0 }
}

function stats(overrides: Partial<AdminStatsResponse> = {}): AdminStatsResponse {
  return {
    users_count: 0,
    masters_count: 0,
    practices_count: 0,
    pending_verifications: 0,
    pending_method_changes: 0,
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminPracticesView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function cards(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.practice-list-card') ?? [])
}
function cardByTitle(title: string): HTMLButtonElement | undefined {
  return cards().find(
    (c) => c.querySelector('.practice-list-card__title')?.textContent?.trim() === title,
  )
}
function segmentItem(label: string): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment__item') ?? []).find(
    (b) => b.textContent?.includes(label),
  )
  if (!btn) throw new Error(`no segment item containing «${label}»`)
  return btn
}
function segmentBadge(label: string): string | undefined {
  return segmentItem(label).querySelector('.v-segment__badge')?.textContent?.trim()
}
function buttonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  // ПРОМТ №563: freeze the clock this screen's Date.now-dependent
  // formatDateShort sees, so its outcome no longer depends on the real
  // calendar date at all (same pattern as AttendanceView.test.ts).
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(adminApi.getAdminPractices)
    .mockReset()
    .mockResolvedValue(paginated([P_NOT_FULL, P_FULL, P_UNLIMITED], 3))

  back.mockReset()
  push.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminPracticesView', () => {
  // ===========================================================================
  describe('ladder + recovery', () => {
    it('shows the loading spinner while the fetch is in flight, then replaces it on resolve', async () => {
      let resolveList!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getAdminPractices).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveList = resolve
          }),
      )
      mount()
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(cards()).toHaveLength(0)

      resolveList(paginated([P_NOT_FULL], 1))
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('success: renders one PracticeListCard per practice', async () => {
      mount()
      await flush()

      expect(cards()).toHaveLength(3)
    })

    it('success with an empty list: shows the "Данных пока нет" card', async () => {
      vi.mocked(adminApi.getAdminPractices).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.admin-list__empty')?.textContent).toBe('Данных пока нет')
      expect(cards()).toHaveLength(0)
    })

    it('failure: shows the error VEmptyState and NO cards', async () => {
      vi.mocked(adminApi.getAdminPractices).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Не удалось загрузить практики')
      expect(cards()).toHaveLength(0)
    })

    it('"Повторить" re-calls load and recovers from error to content', async () => {
      vi.mocked(adminApi.getAdminPractices).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty__title')).not.toBeNull()

      vi.mocked(adminApi.getAdminPractices).mockResolvedValue(paginated([P_NOT_FULL], 1))
      buttonByText('Повторить')?.click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(cards()).toHaveLength(1)
    })
  })

  // ===========================================================================
  describe('error message branch (.vue:128)', () => {
    it('ApiResponseError: the description shows the REAL backend detail', async () => {
      vi.mocked(adminApi.getAdminPractices).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__desc')?.textContent).toBe('Сервер недоступен')
    })

    it('a non-ApiResponseError falls back to "Ошибка загрузки"', async () => {
      vi.mocked(adminApi.getAdminPractices).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__desc')?.textContent).toBe('Ошибка загрузки')
    })
  })

  // ===========================================================================
  describe('scope filter (watch(filter, load), .vue:117-120,139)', () => {
    it('selecting each segment re-calls getAdminPractices with the mapped scope', async () => {
      mount()
      await flush()
      expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('all', 100, 0)

      segmentItem('Предстоящие').click()
      await flush()
      expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('upcoming', 100, 0)

      segmentItem('Прошедшие').click()
      await flush()
      expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('past', 100, 0)

      segmentItem('Все').click()
      await flush()
      expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('all', 100, 0)
    })
  })

  // ===========================================================================
  describe('store badge -- the harness point (.vue:89-94)', () => {
    it('seeding adminStore.stats.practices_count shows it as the "Все" segment badge', async () => {
      mount()
      useAdminStore().stats = stats({ practices_count: 27 })
      await flush()

      expect(segmentBadge('Все')).toBe('27')
    })

    it('adminStore.stats = null: the "Все" segment has NO badge', async () => {
      mount()
      useAdminStore().stats = null
      await flush()

      expect(segmentBadge('Все')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('headerCount (.vue:91)', () => {
    it('after a fetch, shows the scope total from the response', async () => {
      vi.mocked(adminApi.getAdminPractices).mockResolvedValue(
        paginated([P_NOT_FULL, P_FULL, P_UNLIMITED], 99),
      )
      mount()
      await flush()

      expect(host?.querySelector('.admin-list__count')?.textContent).toBe('99')
    })

    it('before the fetch settles, shows "—"', () => {
      vi.mocked(adminApi.getAdminPractices).mockReset().mockImplementation(() => new Promise(() => {}))
      mount()

      expect(host?.querySelector('.admin-list__count')?.textContent).toBe('—')
    })
  })

  // ===========================================================================
  describe('card meta helpers', () => {
    it('duration renders as "N мин"', async () => {
      mount()
      await flush()

      const card = cardByTitle('Утренняя медитация')!
      expect(card.querySelector('.practice-list-card__dur')?.textContent).toContain('60 мин')
    })

    it('when/whenTime render via the real formatters, against the frozen clock', async () => {
      mount()
      await flush()

      const card = cardByTitle('Утренняя медитация')!
      expect(card.querySelector('.practice-list-card__when')?.textContent?.trim()).toBe('21 августа')
      expect(card.querySelector('.practice-list-card__dur span')?.textContent?.trim()).toBe('13:00')
    })

    it('capacity shows "booked/capacity"; not full renders without the rose class', async () => {
      mount()
      await flush()

      const card = cardByTitle('Утренняя медитация')!
      const cap = card.querySelector('.admin-cap')
      expect(cap?.textContent).toContain('5/10')
      expect(cap?.classList.contains('admin-cap--full')).toBe(false)
    })

    it('booked >= capacity: the rose "full" class is applied', async () => {
      mount()
      await flush()

      const card = cardByTitle('Вечерняя йога')!
      const cap = card.querySelector('.admin-cap')
      expect(cap?.textContent).toContain('10/10')
      expect(cap?.classList.contains('admin-cap--full')).toBe(true)
    })

    it('null capacity renders "∞" and is never full', async () => {
      mount()
      await flush()

      const card = cardByTitle('Открытый круг')!
      const cap = card.querySelector('.admin-cap')
      expect(cap?.textContent).toContain('3/∞')
      expect(cap?.classList.contains('admin-cap--full')).toBe(false)
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('tapping a card pushes admin-practice-detail with the practice id', async () => {
      mount()
      await flush()

      cardByTitle('Утренняя медитация')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'admin-practice-detail',
        params: { id: 'p_not_full' },
      })
    })
  })
})
