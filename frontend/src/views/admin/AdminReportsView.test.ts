// =============================================================================
// VELO Frontend -- AdminReportsView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 357 lines. PATTERN = list-with-ladder + pagination + a filter modal. No
// store, confirmed by reading every import. Seams mocked: @/api/admin's
// getReports. ApiResponseError kept REAL (importOriginal). formatRelative
// (adminHelpers.ts) is Date.now-dependent -- same non-exact handling as
// AdminMethodRequestsView's coverage (№476): fixtures dated as an offset from
// Date.now(), only non-empty text asserted, no exact string.
//
// TELEPORT TRAP (SC-13), HANDLED: ModerationFilterModal wraps VModal
// (`.v-modal__overlay`, Teleport+Transition) -- same cleanup as №475/№476,
// purged in afterEach.
//
// (1) THE STALE-RESPONSE RACE GUARD (`generation`, .vue:173-198, W-3). Built
// with TWO controlled (manually-resolved) promises: apply status filter A
// (open->pending) via the real modal UI, then apply filter B (closed->resolved)
// via the SAME UI before A's promise resolves, THEN resolve A last. The
// rendered list must reflect B, not A -- A's late response must be silently
// discarded. Driven through the real modal (open trigger -> toggle the chip
// -> close via VModal's X, which is how ModerationFilterModal applies --
// there is no separate "Apply" button, closing IS applying, confirmed by
// reading applyAndClose()), not by calling internal functions directly.
//
// (2) THE HONEST-STUB FILTER BOUNDARY. Only `apiStatus` (.vue:163-170) reaches
// getReports: exactly one status selected maps open->pending / closed->
// resolved; both or neither selected -> undefined. Category/priority/date are
// DISPLAY-ONLY (categoryLabel/pillLabel/isPayments) -- selecting a category
// must NOT change the getReports call. Asserted BOTH ways below so that the
// day Zod wires real category/date filtering, the "unchanged args" half goes
// red as the changelog (same discipline as EditProfile's delete-stub /
// SupportView's honest-submit tests).
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminReportsView from '@/views/admin/AdminReportsView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { ReportResponse } from '@/api/admin'

vi.mock('@/api/admin')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function report(overrides: Partial<ReportResponse> = {}): ReportResponse {
  return {
    id: 'r_1',
    reporter_id: 'u_1',
    target_type: 'practice',
    target_id: 'p_1',
    reason: 'Практика не состоялась',
    status: 'pending',
    resolved_by: null,
    resolution_note: null,
    resolved_at: null,
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
    updated_at: null,
    ...overrides,
  }
}

const REPORT_A = report({ id: 'r_a', reason: 'Практика не состоялась' })
const REPORT_B = report({ id: 'r_b', reason: 'Оскорбления в чате' })
const REPORT_C = report({ id: 'r_c', reason: 'Спам в сообщениях' })

function paginated(items: ReportResponse[], total?: number) {
  return { items, total: total ?? items.length, limit: 20, offset: 0 }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminReportsView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.rcard') ?? [])
}
function cardByReason(reason: string): HTMLElement | undefined {
  return cards().find((c) => c.querySelector('.rcard__title')?.textContent?.trim() === reason)
}
function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function moreBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Показать ещё',
  )
}
function filterTriggerBtn(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('.admin-reports__filter')
  if (!el) throw new Error('filter trigger did not render')
  return el
}
function pillLabelText(): string | undefined {
  return filterTriggerBtn().querySelector('span')?.textContent?.trim()
}

// Teleported modal (SC-07 -- never query `host`).
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
function modalIsOpen(): boolean {
  const el = modalOverlay()
  return !!el && !el.classList.contains('v-modal-leave-active')
}
function chipByText(t: string): HTMLElement | undefined {
  return Array.from(modalOverlay()?.querySelectorAll<HTMLElement>('.v-chip') ?? []).find(
    (c) => c.textContent?.trim() === t,
  )
}
function closeModalBtn(): HTMLButtonElement | undefined {
  return modalOverlay()?.querySelector<HTMLButtonElement>('.v-modal__close') ?? undefined
}

/** Opens the filter, toggles the given status chip(s) by label, then closes
 *  via the X button -- closing IS applying (ModerationFilterModal has no
 *  separate Apply button, confirmed by reading applyAndClose()). */
async function applyStatusFilter(...labels: string[]): Promise<void> {
  filterTriggerBtn().click()
  await flush()
  for (const label of labels) {
    chipByText(label)?.click()
  }
  await flush()
  closeModalBtn()?.click()
  await flush()
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getReports)
    .mockReset()
    .mockResolvedValue(paginated([REPORT_A, REPORT_B], 2))

  back.mockReset()
  push.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13 -- this screen genuinely opens ModerationFilterModal (VModal).
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('AdminReportsView', () => {
  // ===========================================================================
  describe('ladder + recovery', () => {
    it('shows the loading spinner while the initial fetch is in flight, then content', async () => {
      let resolveList!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getReports)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveList = resolve
            }),
        )
      mount()
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveList(paginated([REPORT_A], 1))
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('empty list: shows the success empty-state', async () => {
      vi.mocked(adminApi.getReports).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Обращений нет')
      expect(cards()).toHaveLength(0)
    })

    it('failure (generic error): shows the error rung and toasts the fallback message', async () => {
      vi.mocked(adminApi.getReports).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Не удалось загрузить')
      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки обращений')
    })

    it('failure (ApiResponseError): the toast carries the generic fallback (unmapped code)', async () => {
      // B8 (PROMPT №747): 'server_error' is not a real backend code --
      // unmapped, lands on the call site's own fallback (.vue:194).
      vi.mocked(adminApi.getReports).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки обращений')
    })

    it('"Повторить" calls loadInitial and recovers from error to content', async () => {
      vi.mocked(adminApi.getReports).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty__title')).not.toBeNull()

      vi.mocked(adminApi.getReports).mockResolvedValue(paginated([REPORT_A], 1))
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('the relative timestamp renders SOME non-empty label (date-dependent, not asserted exactly)', async () => {
      mount()
      await flush()

      const sub = cardByReason('Практика не состоялась')?.querySelector('.rcard__sub')
      expect(sub?.textContent?.trim()).toBeTruthy()
    })
  })

  // ===========================================================================
  describe('THE STALE-RESPONSE RACE GUARD (generation, .vue:172-198, W-3)', () => {
    it('a late-arriving response from an earlier filter is discarded; the newer filter wins', async () => {
      mount()
      await flush() // initial load (generation 1) settled

      let resolveA!: (v: ReturnType<typeof paginated>) => void
      let resolveB!: (v: ReturnType<typeof paginated>) => void
      let callCount = 0
      vi.mocked(adminApi.getReports)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              callCount += 1
              if (callCount === 1) resolveA = resolve
              else resolveB = resolve
            }),
        )

      // Filter A: "Открытая" only -> apiStatus 'pending' (generation 2, in flight).
      await applyStatusFilter('Открытая')
      expect(callCount).toBe(1)

      // Filter B: switch to "Закрытая" only, BEFORE A resolves (generation 3, in flight).
      // Toggle off "Открытая", toggle on "Закрытая" -- the sheet re-seeds its
      // draft from the currently APPLIED filter each time it opens (confirmed
      // by reading ModerationFilterModal's own watch(props.open, ...)), so
      // "Открытая" shows selected again and must be explicitly cleared.
      await applyStatusFilter('Открытая', 'Закрытая')
      expect(callCount).toBe(2)

      // B (the newer request) resolves FIRST.
      resolveB(paginated([REPORT_C], 1))
      await flush()
      expect(cards()).toHaveLength(1)
      expect(cardByReason('Спам в сообщениях')).toBeDefined()

      // A (the STALE request) resolves LAST -- must be discarded, not overwrite B.
      resolveA(paginated([REPORT_A, REPORT_B], 2))
      await flush()

      expect(cards()).toHaveLength(1)
      expect(cardByReason('Спам в сообщениях')).toBeDefined()
      expect(cardByReason('Практика не состоялась')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('THE HONEST-STUB FILTER BOUNDARY (.vue:148-170)', () => {
    it('the filter trigger opens the modal; the X button closes it (closing IS applying)', async () => {
      mount()
      await flush()

      expect(modalIsOpen()).toBe(false)
      filterTriggerBtn().click()
      await flush()
      expect(modalIsOpen()).toBe(true)

      closeModalBtn()?.click()
      await flush()
      expect(modalIsOpen()).toBe(false)
    })

    it('status filter -> the api argument: "Открытая" -> pending', async () => {
      mount()
      await flush()

      await applyStatusFilter('Открытая')

      expect(adminApi.getReports).toHaveBeenLastCalledWith('pending', undefined, 20, 0)
    })

    it('status filter -> the api argument: "Закрытая" -> resolved', async () => {
      mount()
      await flush()

      await applyStatusFilter('Закрытая')

      expect(adminApi.getReports).toHaveBeenLastCalledWith('resolved', undefined, 20, 0)
    })

    it('status filter -> BOTH selected -> undefined (no status filter)', async () => {
      mount()
      await flush()

      await applyStatusFilter('Открытая', 'Закрытая')

      expect(adminApi.getReports).toHaveBeenLastCalledWith(undefined, undefined, 20, 0)
    })

    it('selecting a CATEGORY changes the pill label + swaps the card glyph, but does NOT touch the api call', async () => {
      mount()
      await flush()
      const callsBefore = vi.mocked(adminApi.getReports).mock.calls.length

      expect(pillLabelText()).toBe('Фильтр')
      expect(host?.querySelector('.rcard__icon--pay')).toBeNull()

      filterTriggerBtn().click()
      await flush()
      chipByText('Платежи')?.click()
      await flush()
      closeModalBtn()?.click()
      await flush()

      expect(pillLabelText()).toBe('Платежи')
      expect(host?.querySelectorAll('.rcard__icon--pay')).toHaveLength(2) // both cards swap glyph
      // The stub boundary: no NEW api call, and the args are unchanged
      // (still no status filter) -- category is display-only.
      expect(vi.mocked(adminApi.getReports).mock.calls.length).toBe(callsBefore + 1)
      expect(adminApi.getReports).toHaveBeenLastCalledWith(undefined, undefined, 20, 0)
    })
  })

  // ===========================================================================
  describe('pagination (.vue:201-213) -- TWO DISTINCT fallback strings', () => {
    it('loadMore requests the next offset and APPENDS (not replaces)', async () => {
      vi.mocked(adminApi.getReports).mockResolvedValueOnce(paginated([REPORT_A], 2))
      mount()
      await flush()
      expect(cards()).toHaveLength(1)
      expect(moreBtn()).toBeDefined()

      vi.mocked(adminApi.getReports).mockResolvedValueOnce(paginated([REPORT_B], 2))
      moreBtn()?.click()
      await flush()

      expect(adminApi.getReports).toHaveBeenLastCalledWith(undefined, undefined, 20, 1)
      expect(cards()).toHaveLength(2)
      expect(cardByReason('Практика не состоялась')).toBeDefined() // page 1 survived
    })

    it('hasMore is false once every report has been fetched: no "Показать ещё"', async () => {
      vi.mocked(adminApi.getReports).mockResolvedValue(paginated([REPORT_A, REPORT_B], 2))
      mount()
      await flush()

      expect(moreBtn()).toBeUndefined()
    })

    it('loadMore failure toasts its OWN fallback ("Ошибка загрузки"), DIFFERENT from loadInitial\'s ("Ошибка загрузки обращений")', async () => {
      vi.mocked(adminApi.getReports).mockResolvedValueOnce(paginated([REPORT_A], 2))
      mount()
      await flush()

      vi.mocked(adminApi.getReports).mockRejectedValueOnce(new Error('ECONNRESET'))
      moreBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки')
      expect(toastError).not.toHaveBeenCalledWith('Ошибка загрузки обращений')
      // The row from before the failed load-more survives (list not blanked).
      expect(cards()).toHaveLength(1)
    })
  })

  // ===========================================================================
  describe('headerCount + openDetail', () => {
    it('headerCount shows the API total, "—" when 0', async () => {
      vi.mocked(adminApi.getReports).mockResolvedValue(paginated([REPORT_A, REPORT_B], 42))
      mount()
      await flush()
      expect(host?.querySelector('.admin-reports__count')?.textContent).toBe('42')

      vi.mocked(adminApi.getReports).mockResolvedValue(paginated([], 0))
      await applyStatusFilter('Открытая') // any trigger to re-load with a fresh mock
      expect(host?.querySelector('.admin-reports__count')?.textContent).toBe('—')
    })

    it('openDetail pushes admin-report-detail with the id and a DEEP-CLONED report in state', async () => {
      mount()
      await flush()

      cardByReason('Практика не состоялась')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'admin-report-detail',
        params: { id: 'r_a' },
        state: { report: REPORT_A },
      })
      const call = push.mock.calls[0]?.[0] as { state: { report: ReportResponse } }
      expect(call.state.report).not.toBe(REPORT_A) // deep-cloned, not the same reference
    })
  })
})
