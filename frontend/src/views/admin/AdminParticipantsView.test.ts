// =============================================================================
// VELO Frontend -- AdminParticipantsView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 304 lines. Global participants list -- filter + pagination + admin-store
// thin read. ONE api seam: getParticipants (@/api/admin). Real Pinia,
// AdminPracticesView.test.ts's harness (createPinia/setActivePinia, seed
// useAdminStore().stats directly -- a plain writable ref, this screen never
// calls fetchDashboard itself).
//
// useAdminStore ON THIS SCREEN: read for EXACTLY ONE value,
// `adminStore.stats?.users_count` (.vue:103), feeding the header count badge
// AND the "Все" segment badge (.vue:104-112). It does NOT drive the list --
// same thin-read shape as AdminPracticesView (№485's sibling precedent), not
// assumed, confirmed by reading the whole script.
//
// THE LADDER IS NOT WHAT A GENERIC LIST SCREEN WOULD HAVE -- READ, NOT
// ASSUMED: this screen has NO loading-spinner element at all (no VLoader
// import, no `.v-loader`/`admin-list__loader` anywhere in the template,
// confirmed by grep). The template is only three branches:
//   v-if="participants.length"           -- rows + load-more
//   v-else-if="error"                    -- VEmptyState + Повторить
//   v-else-if="!loading"                 -- "Данных пока нет" card
// During the INITIAL fetch (participants=[], error=false, loading=true), NONE
// of the three branches match -- the screen shows literally nothing below
// the header/segment until the fetch settles. The `!loading` guard on the
// third branch exists ONLY to tell "still loading" apart from "genuinely
// empty", not to show a spinner. Asserted below directly (a pending promise,
// checked mid-flight).
//
// THE ERROR PATH IS ALSO A REAL DIVERGENCE FROM THIS PROJECT'S NEAR-UNIVERSAL
// PATTERN -- READ, NOT ASSUMED: `catch { ... }` (.vue:123) has NO bound error
// parameter at all -- no `ApiResponseError -> e.detail` discrimination is
// even POSSIBLE here. Both the toast ('Не удалось загрузить участников') and
// the VEmptyState description ("Проверьте соединение и попробуйте ещё раз",
// .vue:61, a template-literal-free hardcoded string, NOT bound to any error
// variable) are FIXED regardless of failure cause. Every other admin screen
// covered this session discriminates ApiResponseError vs generic -- this one
// doesn't, on purpose or not. Reported as a structural fact, not fixed.
//
// LOAD-MORE DOES NOT BLANK THE LIST -- THE REAL ASSIGNMENT, MEASURED: the
// catch block (.vue:123-129) only sets `error.value = true` `if (reset)` --
// a failed loadMore (reset=false) touches NEITHER `error` NOR
// `participants.value` at all, so the already-rendered page stays exactly as
// it was, with only the toast firing. Asserted below directly: mount with a
// full first page, trigger a REJECTING loadMore, assert the original rows
// are still in the DOM afterward.
//
// TWO GUARDS, ONE REAL ONE NOT (contrast worth naming, not this screen's own
// finding but relevant context): `load()`'s `if (loading.value) return`
// (.vue:115) IS a real handler-level reentrancy guard -- confirmed with a
// same-tick double loadMore click below, only ONE api call reaches the mock.
// This is the correctly-guarded shape that AdminMasterInviteView.onCreate and
// AdminProfileView.onLogout (this round's other two screens) are missing --
// see their own files' banners.
//
// joinedLabel (.vue:143-149) is a PURE function of its ISO input -- `new
// Date(iso)` + a fixed `timeZone: 'UTC'` Intl call, no `new Date()` (no
// "now") anywhere in it. Deterministic, hardcoded exactly below (verified via
// node before writing the assertion, not guessed): 2025-12-15 -> "Дек 2025".
//
// lastActiveLabel (.vue:152-154) delegates to `dayLabelOf` (@/utils/format),
// which DOES read `new Date()` internally for its Сегодня/Вчера comparison --
// Date.now-dependent, CORRECTING the possibility of hardcoding a relative
// string against a fixed clock. Sidestepped by computing "today"/"yesterday"
// at TEST-RUN time (`new Date().toISOString()`, legal inside a Vitest test
// file -- the Date.now-in-scripts ban applies to Workflow scripts, not this),
// so the Сегодня/Вчера branches are asserted for real, not assumed; the
// "plain date" branch uses a fixed far-past ISO verified via node
// (2019-06-10 -> "10 июня").
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AdminParticipantsView from '@/views/admin/AdminParticipantsView.vue'
import * as adminApi from '@/api/admin'
import { useAdminStore } from '@/stores/admin'
import type { AdminParticipant, AdminStatsResponse } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures -- factory functions. `load()` never mutates a loaded participant
// object in place (reset replaces the array, loadMore spreads a NEW array),
// so the №482 trap doesn't literally bite here, but factories cost nothing.
// -----------------------------------------------------------------------------

function participant(overrides: Partial<AdminParticipant> = {}): AdminParticipant {
  return {
    id: 'u_1',
    name: 'Анна Иванова',
    telegram_id: 123456,
    avatar_url: null,
    practices_count: 5,
    created_at: '2025-12-15T00:00:00Z', // matches the .vue header's own "Дек 2025" example
    last_login_at: '2019-06-10T00:00:00Z', // far-past, deterministic "10 июня"
    ...overrides,
  }
}

function paginated(items: AdminParticipant[], total?: number) {
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
  app = createApp(AdminParticipantsView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.prow') ?? [])
}
function rowByName(name: string): HTMLElement | undefined {
  return rows().find((r) => r.querySelector('.prow__name')?.textContent?.trim() === name)
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
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(adminApi.getParticipants)
    .mockReset()
    .mockResolvedValue(paginated([participant()], 1))

  back.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminParticipantsView', () => {
  // ===========================================================================
  describe('ladder (NO loading-spinner element -- see banner)', () => {
    it('mid-flight (participants=[], error=false, loading=true): NONE of the three branches render', async () => {
      let resolveGet!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getParticipants)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveGet = resolve
            }),
        )
      mount()
      await nextTick()

      expect(rows()).toHaveLength(0)
      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(host?.querySelector('.admin-list__empty')).toBeNull()

      resolveGet(paginated([participant()], 1))
      await flush()

      expect(rows()).toHaveLength(1)
    })

    it('success: renders one row per participant', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValue(
        paginated(
          [participant({ id: 'u_1', name: 'Анна' }), participant({ id: 'u_2', name: 'Борис' })],
          2,
        ),
      )
      mount()
      await flush()

      expect(rows()).toHaveLength(2)
    })

    it('success with an empty list: shows "Данных пока нет"', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.admin-list__empty')?.textContent?.trim()).toBe('Данных пока нет')
      expect(rows()).toHaveLength(0)
    })

    it('failure: fixed error title/description (no ApiResponseError discrimination -- see banner), toast fires the same fixed string', async () => {
      vi.mocked(adminApi.getParticipants).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent?.trim()).toBe(
        'Не удалось загрузить участников',
      )
      expect(host?.querySelector('.v-empty__desc')?.textContent?.trim()).toBe(
        'Проверьте соединение и попробуйте ещё раз',
      )
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить участников')
      expect(rows()).toHaveLength(0)
    })

    it('«Повторить» recovers to content', async () => {
      vi.mocked(adminApi.getParticipants).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty')).not.toBeNull()

      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(paginated([participant()], 1))
      buttonByText('Повторить')?.click()
      await flush()

      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(rows()).toHaveLength(1)
    })
  })

  // ===========================================================================
  describe('filter (watch(filter, load), .vue:93,136)', () => {
    it('initial load: getParticipants("all", "week", 0, 100, 0)', async () => {
      mount()
      await flush()

      expect(adminApi.getParticipants).toHaveBeenCalledWith('all', 'week', 0, 100, 0)
    })

    it('selecting "Новые"/"Активные" re-fetches with the mapped filter, offset reset to 0', async () => {
      mount()
      await flush()

      segmentItem('Новые').click()
      await flush()
      expect(adminApi.getParticipants).toHaveBeenLastCalledWith('new', 'week', 0, 100, 0)

      segmentItem('Активные').click()
      await flush()
      expect(adminApi.getParticipants).toHaveBeenLastCalledWith('active', 'week', 0, 100, 0)
    })

    it('switching filter REPLACES the list (reset), not appends -- a stale page from the old filter does not linger', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(
        paginated([participant({ id: 'u_all', name: 'Все-фильтр Юзер' })], 1),
      )
      mount()
      await flush()
      expect(rowByName('Все-фильтр Юзер')).toBeDefined()

      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(
        paginated([participant({ id: 'u_new', name: 'Новый Юзер' })], 1),
      )
      segmentItem('Новые').click()
      await flush()

      expect(rowByName('Все-фильтр Юзер')).toBeUndefined()
      expect(rowByName('Новый Юзер')).toBeDefined()
      expect(rows()).toHaveLength(1)
    })
  })

  // ===========================================================================
  describe('pagination (load(reset)/loadMore, .vue:114-140)', () => {
    it('loadMore APPENDS with pageOffset = current participants.length', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(
        paginated([participant({ id: 'u_1' }), participant({ id: 'u_2' })], 5),
      )
      mount()
      await flush()
      expect(rows()).toHaveLength(2)

      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(
        paginated([participant({ id: 'u_3' })], 5),
      )
      buttonByText('Показать ещё')?.click()
      await flush()

      expect(adminApi.getParticipants).toHaveBeenLastCalledWith('all', 'week', 0, 100, 2)
      expect(rows()).toHaveLength(3) // appended, not replaced
    })

    it('hasMore hides "Показать ещё" once participants.length >= total', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValue(paginated([participant()], 1))
      mount()
      await flush()

      expect(buttonByText('Показать ещё')).toBeUndefined()
    })

    it('LOAD-MORE DOES NOT BLANK THE LIST: a rejecting loadMore leaves the already-rendered page untouched, only the toast fires', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(
        paginated([participant({ id: 'u_1', name: 'Уже Загружен' })], 5),
      )
      mount()
      await flush()
      expect(rowByName('Уже Загружен')).toBeDefined()

      vi.mocked(adminApi.getParticipants).mockRejectedValueOnce(new Error('ECONNRESET'))
      buttonByText('Показать ещё')?.click()
      await flush()

      expect(rowByName('Уже Загружен')).toBeDefined() // still there, not blanked
      expect(host?.querySelector('.v-empty')).toBeNull() // no error rung either -- reset stayed false
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить участников')
    })

    it('a same-tick double loadMore click reaches the api ONCE -- if(loading.value) return is a real, working guard here', async () => {
      let resolveMore!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getParticipants).mockResolvedValueOnce(paginated([participant()], 5))
      mount()
      await flush()

      vi.mocked(adminApi.getParticipants).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMore = resolve
          }),
      )
      const btn = buttonByText('Показать ещё')!
      btn.click()
      btn.click() // no await between -- the button has no :disabled binding of its own
      await flush()

      expect(adminApi.getParticipants).toHaveBeenCalledTimes(2) // 1 initial + 1 loadMore, not 3
      resolveMore(paginated([participant({ id: 'u_2' })], 5))
      await flush()
    })
  })

  // ===========================================================================
  describe('labels (.vue:143-154, see banner for Date-dependence)', () => {
    it('joinedLabel: a pure function of created_at, deterministic ("Дек 2025")', async () => {
      mount()
      await flush()

      expect(host?.querySelector('.prow__meta')?.textContent).toContain('Дек 2025')
    })

    it('lastActiveLabel: "Сегодня" for a last_login_at of right now', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValue(
        paginated([participant({ last_login_at: new Date().toISOString() })], 1),
      )
      mount()
      await flush()

      const metas = host?.querySelectorAll('.prow__meta')
      expect(Array.from(metas ?? []).some((m) => m.textContent?.includes('Сегодня'))).toBe(true)
    })

    it('lastActiveLabel: "Вчера" for a last_login_at of exactly one day ago', async () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      vi.mocked(adminApi.getParticipants).mockResolvedValue(
        paginated([participant({ last_login_at: yesterday.toISOString() })], 1),
      )
      mount()
      await flush()

      const metas = host?.querySelectorAll('.prow__meta')
      expect(Array.from(metas ?? []).some((m) => m.textContent?.includes('Вчера'))).toBe(true)
    })

    it('lastActiveLabel: a plain "D month" string for a far-past date', async () => {
      mount() // default fixture: last_login_at = 2019-06-10
      await flush()

      const metas = host?.querySelectorAll('.prow__meta')
      expect(Array.from(metas ?? []).some((m) => m.textContent?.includes('10 июня'))).toBe(true)
    })

    it('telegram_id/last_login_at absent: their own row lines simply do not render', async () => {
      vi.mocked(adminApi.getParticipants).mockResolvedValue(
        paginated([participant({ telegram_id: null, last_login_at: null })], 1),
      )
      mount()
      await flush()

      const row = rows()[0]
      expect(row?.querySelector('.prow__sub')).toBeNull()
      const metas = Array.from(row?.querySelectorAll('.prow__meta') ?? [])
      expect(metas.some((m) => m.textContent?.includes('Последняя'))).toBe(false)
    })
  })

  // ===========================================================================
  describe('header + store badge (.vue:103-112)', () => {
    it('seeding adminStore.stats.users_count shows it in the header AND the "Все" badge', async () => {
      mount()
      useAdminStore().stats = stats({ users_count: 342 })
      await flush()

      expect(host?.querySelector('.admin-list__count')?.textContent?.trim()).toBe('342')
      expect(segmentBadge('Все')).toBe('342')
    })

    it('adminStore.stats = null: header shows "—", no badge on "Все"', async () => {
      mount()
      useAdminStore().stats = null
      await flush()

      expect(host?.querySelector('.admin-list__count')?.textContent?.trim()).toBe('—')
      expect(segmentBadge('Все')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('messageStub (.vue:157-159)', () => {
    it('clicking the message button toasts the stub, no navigation', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.prow__msg')?.click()
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Сообщения пока недоступны')
      expect(back).not.toHaveBeenCalled()
    })
  })
})
