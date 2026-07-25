// =============================================================================
// VELO Frontend -- AdminReportDetailView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 375 lines. The detail screen for AdminReportsView (№479) -- reuses that
// coverage's fixtures. PATTERN = route-param detail screen + two mutating
// moderation actions (resolve/dismiss). No store, confirmed by reading every
// import. Seams mocked: @/api/admin's getReportById / resolveReport /
// dismissReport. ApiResponseError kept REAL (importOriginal). No teleported
// dialogs -- the notes are inline VTextareas, no SC-13 cleanup needed.
//
// THE STATE-SEED CHECK (the archetype bug from BookingConfirmedView,
// commit 235a714): read .vue:198-204 directly --
//   const stateData = (history.state as { report?: ReportResponse }).report
//   if (stateData && stateData.id === reportId) { ... trust it ... }
// This DOES verify `stateData.id === reportId` before trusting the passed-in
// object. CLEAN NEGATIVE -- the archetype bug is NOT present here. Both
// directions asserted below: a MATCHING seeded id skips the fetch entirely; a
// MISMATCHED seeded id (stale object from a previous navigation) is correctly
// ignored and a real fetch happens instead. Seeded via
// `window.history.replaceState()` BEFORE mount (the screen reads it during
// setup, same technique as AdminWithdrawalDetailView.test.ts's precedent).
//
// LADDER CLASSIFICATION (SW8, fixed ПРОМТ №577): FOUR rungs now --
// loading / error / not-found / content. Previously a fetch FAILURE and a
// genuinely NOT-FOUND state rendered the EXACT SAME UI (.vue's old catch
// block never set any error/not-found flag, `report.value` simply stayed
// null, so `v-else-if="report"` fell through to the same final `v-else`,
// "Жалоба не найдена", with only a toast -- easy to miss -- as the sole
// signal something was actually wrong, and no retry). The catch now sets a
// distinct `error` ref with its own rung + "Повторить", matching sibling
// admin detail screens (AdminPracticeDetailView, AdminMasterReviewView,
// AdminWithdrawalDetailView). The old not-found `v-else` fallback is kept
// (matching those same siblings' own defensive fallback) but is not
// reachable via any fetch failure anymore -- getReportById either resolves
// or throws, never resolves to a falsy report.
//
// formatDateTime (adminHelpers.ts:99-107, fixed SW10 same round) now pins
// `timeZone: 'UTC'` explicitly -- deterministic across machines/CI.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminReportDetailView from '@/views/admin/AdminReportDetailView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { ReportResponse } from '@/api/admin'

vi.mock('@/api/admin')

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'r_pending' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: toastSuccess }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function report(overrides: Partial<ReportResponse> = {}): ReportResponse {
  return {
    id: 'r_pending',
    reporter_id: 'u_1',
    target_type: 'practice',
    target_id: '11111111-2222-3333-4444-555555555555',
    reason: 'Практика не состоялась',
    status: 'pending',
    resolved_by: null,
    resolution_note: null,
    resolved_at: null,
    created_at: '2026-06-01T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

const REPORT_PENDING = report({ id: 'r_pending', status: 'pending' })
const REPORT_RESOLVED = report({
  id: 'r_resolved',
  status: 'resolved',
  resolved_at: '2026-06-02T11:30:00Z',
  resolution_note: 'Меры приняты',
})

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

/** Seed router state (or clear it), set the route param, then mount -- the
 *  screen reads history.state during setup (.vue:199), seeding after is too
 *  late (same order requirement as AdminWithdrawalDetailView.test.ts). */
function mount(id: string, stateReport: ReportResponse | null = null): HTMLElement {
  routeParams.id = id
  window.history.replaceState(stateReport ? { report: stateReport } : {}, '')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminReportDetailView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}
function textareaWrap(label: string): HTMLElement {
  const wrap = Array.from(host?.querySelectorAll<HTMLElement>('.v-textarea') ?? []).find(
    (w) => w.querySelector('.v-textarea__label')?.textContent?.trim() === label,
  )
  if (!wrap) throw new Error(`no textarea labelled «${label}»`)
  return wrap
}
function textareaField(label: string): HTMLTextAreaElement {
  const el = textareaWrap(label).querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!el) throw new Error(`no <textarea> under «${label}»`)
  return el
}
function textareaErrorText(label: string): string {
  return textareaWrap(label).querySelector('.v-textarea__error')?.textContent?.trim() ?? ''
}
function setValue(el: HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function btnByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function resolveBtn(): HTMLButtonElement {
  const b = btnByText('Решить')
  if (!b) throw new Error('Решить button did not render')
  return b
}
function dismissBtn(): HTMLButtonElement {
  const b = btnByText('Отклонить')
  if (!b) throw new Error('Отклонить button did not render')
  return b
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getReportById).mockReset().mockResolvedValue(REPORT_PENDING)
  vi.mocked(adminApi.resolveReport).mockReset()
  vi.mocked(adminApi.dismissReport).mockReset()

  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.history.replaceState({}, '')
  vi.clearAllMocks()
})

describe('AdminReportDetailView', () => {
  // ===========================================================================
  describe('THE STATE-SEED CHECK (.vue:198-204) -- clean negative, both directions', () => {
    it('a MATCHING seeded report skips the fetch entirely', async () => {
      mount('r_pending', REPORT_PENDING)
      await flush()

      expect(adminApi.getReportById).not.toHaveBeenCalled()
      expect(text()).toContain('Практика не состоялась')
    })

    it('a MISMATCHED seeded report (stale from a previous navigation) is ignored -- a real fetch happens instead', async () => {
      const staleFromAnotherReport = report({ id: 'r_completely_different' })
      vi.mocked(adminApi.getReportById).mockResolvedValue(REPORT_PENDING)

      mount('r_pending', staleFromAnotherReport) // seeded id != route id

      await flush()

      expect(adminApi.getReportById).toHaveBeenCalledWith('r_pending')
      expect(text()).toContain('Практика не состоялась') // the FETCHED report, not the stale one
    })
  })

  // ===========================================================================
  describe('ladder (SW8: error rung distinct from not-found -- see banner)', () => {
    it('loading -> content for a valid id', async () => {
      let resolveGet!: (v: ReportResponse) => void
      vi.mocked(adminApi.getReportById).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve
          }),
      )
      mount('r_pending')
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveGet(REPORT_PENDING)
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(text()).toContain('Практика не состоялась')
    })

    it('SW8: a fetch failure lands in a DISTINCT error rung, not "not found" -- with a retry button', async () => {
      vi.mocked(adminApi.getReportById).mockRejectedValue(new Error('ECONNRESET'))
      mount('r_missing')
      await flush()

      expect(host?.querySelector('.report-detail__not-found')).toBeNull()
      expect(text()).not.toContain('Жалоба не найдена')
      expect(text()).toContain('Ошибка загрузки')
      expect(btnByText('Повторить')).toBeDefined()
    })

    it('failure (ApiResponseError): the error rung carries the real backend detail', async () => {
      vi.mocked(adminApi.getReportById).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount('r_missing')
      await flush()

      expect(text()).toContain('Сервер недоступен')
    })

    it('SW8: «Повторить» recovers to content after a failure', async () => {
      vi.mocked(adminApi.getReportById).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount('r_missing')
      await flush()

      expect(btnByText('Повторить')).toBeDefined()

      vi.mocked(adminApi.getReportById).mockResolvedValueOnce(REPORT_PENDING)
      btnByText('Повторить')?.click()
      await flush()

      expect(text()).not.toContain('Ошибка загрузки')
      expect(text()).toContain('Практика не состоялась')
      expect(adminApi.getReportById).toHaveBeenCalledTimes(2)
    })

    it('the header back arrow calls router.back() regardless of ladder state', async () => {
      vi.mocked(adminApi.getReportById).mockRejectedValue(new Error('ECONNRESET'))
      mount('r_missing')
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-back')?.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================================================
  describe('THE STATUS GATE (.vue:84,130)', () => {
    it('a PENDING report shows the resolve/dismiss actions, no "processed" card', async () => {
      mount('r_pending', REPORT_PENDING)
      await flush()

      expect(resolveBtn()).toBeDefined()
      expect(dismissBtn()).toBeDefined()
      expect(host?.querySelector('.report-detail__processed')).toBeNull()
    })

    it('an ALREADY-PROCESSED report hides the actions and shows the "processed" card', async () => {
      mount('r_resolved', REPORT_RESOLVED)
      await flush()

      expect(btnByText('Решить')).toBeUndefined()
      expect(btnByText('Отклонить')).toBeUndefined()
      expect(host?.querySelector('.report-detail__processed')?.textContent).toContain('Решена')
    })
  })

  // ===========================================================================
  describe('resolve (.vue:218-237)', () => {
    it('VALIDATION: an empty note blocks submit with "Введите примечание к решению", no api call', async () => {
      mount('r_pending', REPORT_PENDING)
      await flush()

      resolveBtn().click()
      await flush()

      expect(textareaErrorText('Примечание к решению *')).toBe('Введите примечание к решению')
      expect(adminApi.resolveReport).not.toHaveBeenCalled()
    })

    it('a whitespace-only note is ALSO rejected (trim check)', async () => {
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание к решению *'), '   ')
      await flush()
      resolveBtn().click()
      await flush()

      expect(textareaErrorText('Примечание к решению *')).toBe('Введите примечание к решению')
      expect(adminApi.resolveReport).not.toHaveBeenCalled()
    })

    it('success: resolveReport called with the id + trimmed note, toasts, navigates to admin-reports', async () => {
      vi.mocked(adminApi.resolveReport).mockResolvedValue(REPORT_RESOLVED)
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание к решению *'), '  Меры приняты  ')
      await flush()
      resolveBtn().click()
      await flush()

      expect(adminApi.resolveReport).toHaveBeenCalledWith('r_pending', 'Меры приняты')
      expect(toastSuccess).toHaveBeenCalledWith('Жалоба решена')
      // S-1/S-2: push to the list, not back() -- fresh loadInitial() on return.
      expect(push).toHaveBeenCalledWith({ name: 'admin-reports' })
    })

    it('failure: toasts (detail / fallback) and the report STAYS pending (no navigation)', async () => {
      vi.mocked(adminApi.resolveReport).mockRejectedValue(
        new ApiResponseError(409, 'Жалоба уже обработана', 'already_decided'),
      )
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание к решению *'), 'Меры приняты')
      await flush()
      resolveBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Жалоба уже обработана')
      expect(push).not.toHaveBeenCalled()
      expect(resolveBtn()).toBeDefined() // still pending, actions still shown
    })

    it('failure (non-ApiResponseError): falls back to the SAME shared string as dismiss (see banner) -- discriminated by which api was called', async () => {
      vi.mocked(adminApi.resolveReport).mockRejectedValue(new Error('ECONNRESET'))
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание к решению *'), 'Меры приняты')
      await flush()
      resolveBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка при обработке')
      expect(adminApi.resolveReport).toHaveBeenCalledTimes(1)
      expect(adminApi.dismissReport).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('dismiss (.vue:239-253)', () => {
    it('success: dismissReport called with the id + trimmed note (or undefined when empty), toasts, navigates', async () => {
      vi.mocked(adminApi.dismissReport).mockResolvedValue(REPORT_RESOLVED)
      mount('r_pending', REPORT_PENDING)
      await flush()

      dismissBtn().click() // no note -- optional field
      await flush()

      expect(adminApi.dismissReport).toHaveBeenCalledWith('r_pending', undefined)
      expect(toastSuccess).toHaveBeenCalledWith('Жалоба отклонена')
      expect(push).toHaveBeenCalledWith({ name: 'admin-reports' })
    })

    it('a filled (optional) note is sent, trimmed', async () => {
      vi.mocked(adminApi.dismissReport).mockResolvedValue(REPORT_RESOLVED)
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание (необязательно)'), '  Не подтверждено  ')
      await flush()
      dismissBtn().click()
      await flush()

      expect(adminApi.dismissReport).toHaveBeenCalledWith('r_pending', 'Не подтверждено')
    })

    it('failure: toasts (detail / the SAME shared fallback as resolve) and the report STAYS pending', async () => {
      vi.mocked(adminApi.dismissReport).mockRejectedValue(
        new ApiResponseError(409, 'Жалоба уже обработана', 'already_decided'),
      )
      mount('r_pending', REPORT_PENDING)
      await flush()

      dismissBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Жалоба уже обработана')
      expect(push).not.toHaveBeenCalled()
      expect(dismissBtn()).toBeDefined()
    })

    it('failure (non-ApiResponseError): falls back to "Ошибка при обработке" -- discriminated by WHICH api was called', async () => {
      vi.mocked(adminApi.dismissReport).mockRejectedValue(new Error('ECONNRESET'))
      mount('r_pending', REPORT_PENDING)
      await flush()

      dismissBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка при обработке')
      expect(adminApi.dismissReport).toHaveBeenCalledTimes(1)
      expect(adminApi.resolveReport).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // CROSS-ACTION GUARD (anyLoading = resolving || dismissing, .vue:182). Built
  // to actually isolate what protects the cross-case, not assume it. FIXED in
  // №481 (this commit's fix -- see the source diff): onResolve/onDismiss
  // (.vue:224,240) originally checked ONLY their own flag (`resolving.value` /
  // `dismissing.value`), so a same-tick cross-click (before the template's
  // `:disabled="anyLoading"`, .vue:99,120, could paint) reached the handler
  // body unblocked -- confirmed live in №480's coverage pass, reported as a
  // real finding, not fixed there. Root cause: `anyLoading` (.vue:182) already
  // existed and expressed exactly the cross-block intent, but the handlers
  // never consulted it -- they only checked their OWN flag. Closed by
  // swapping both checks to `if (anyLoading.value) return`. The `:disabled`
  // binding stays (owner's ruling, №481) -- it is real UX feedback (the
  // button visibly greys out), not a redundant second layer; the two tests
  // below now cover BOTH layers on purpose, not by accident.
  describe('cross-action guard (anyLoading, .vue:182)', () => {
    it('REALISTIC interaction: once resolving has painted, the Dismiss button is a real disabled <button> -- a click on it is a no-op', async () => {
      let resolveResolve!: (v: ReportResponse) => void
      vi.mocked(adminApi.resolveReport).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveResolve = resolve
          }),
      )
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание к решению *'), 'Меры приняты')
      await flush()
      resolveBtn().click()
      await flush() // let the :disabled="anyLoading" binding paint

      expect(dismissBtn().disabled).toBe(true)
      dismissBtn().click()
      await flush()

      expect(adminApi.dismissReport).not.toHaveBeenCalled()

      resolveResolve(REPORT_RESOLVED)
      await flush()
    })

    // FIXED (№481, this commit -- source + test together): onResolve/onDismiss
    // now check `anyLoading.value` instead of only their own flag (.vue:224,240),
    // so a same-tick cross-click is blocked at the handler layer too, not just
    // by the (still present, still the UX feedback layer) :disabled paint.
    it('FIXED: a same-tick cross-click is now blocked at the handler layer -- dismissReport is NOT called', async () => {
      let resolveResolve!: (v: ReportResponse) => void
      vi.mocked(adminApi.resolveReport).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveResolve = resolve
          }),
      )
      vi.mocked(adminApi.dismissReport).mockResolvedValue(REPORT_RESOLVED)
      mount('r_pending', REPORT_PENDING)
      await flush()

      setValue(textareaField('Примечание к решению *'), 'Меры приняты')
      await flush()

      resolveBtn().click()
      dismissBtn().click() // no await -- anyLoading is true reactively, but unpainted
      await flush()

      expect(adminApi.dismissReport).not.toHaveBeenCalled()

      resolveResolve(REPORT_RESOLVED)
      await flush()
    })
  })

  // ===========================================================================
  describe('meta rendering (.vue:38-81, targetRoute .vue:187-196)', () => {
    it('target_type=practice: the ID is a clickable link -> pushes admin-practice-detail', async () => {
      mount('r_pending', REPORT_PENDING) // target_type: 'practice'
      await flush()

      const link = host?.querySelector<HTMLButtonElement>('.report-detail__meta-val--link')
      expect(link).not.toBeNull()
      link?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'admin-practice-detail',
        params: { id: REPORT_PENDING.target_id },
      })
    })

    it('target_type=master: pushes admin-master-review', async () => {
      const masterReport = report({ id: 'r_m', target_type: 'master', target_id: 'master_1' })
      mount('r_m', masterReport)
      await flush()

      host
        ?.querySelector<HTMLButtonElement>('.report-detail__meta-val--link')
        ?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'admin-master-review',
        params: { id: 'master_1' },
      })
    })

    it('target_type=user: NO link -- a plain mono span, no navigation possible', async () => {
      const userReport = report({ id: 'r_u', target_type: 'user', target_id: 'user_1' })
      mount('r_u', userReport)
      await flush()

      expect(host?.querySelector('.report-detail__meta-val--link')).toBeNull()
      const plain = Array.from(
        host?.querySelectorAll('.report-detail__meta-val--mono') ?? [],
      ).find((el) => !el.classList.contains('report-detail__meta-val--link'))
      expect(plain?.textContent?.trim()).toContain('user_1'.slice(0, 8))
    })

    it('resolved_at / resolution_note blocks render ONLY when present', async () => {
      mount('r_pending', REPORT_PENDING) // both null
      await flush()
      expect(text()).not.toContain('Обработана')
      // "Примечание" alone would also match the dismiss textarea's OWN label
      // ("Примечание (необязательно)"), which always renders while pending --
      // query the resolution_note meta block specifically instead.
      expect(host?.querySelector('.report-detail__meta-note')).toBeNull()

      app?.unmount()
      host?.remove()

      mount('r_resolved', REPORT_RESOLVED) // both present
      await flush()
      expect(text()).toContain('Обработана')
      expect(host?.querySelector('.report-detail__meta-note')?.textContent).toBe('Меры приняты')
    })
  })
})
