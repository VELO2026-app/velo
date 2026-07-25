// =============================================================================
// VELO Frontend -- AdminMethodRequestsView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 423 lines. PATTERN = list-with-ladder + pagination + TWO mutating actions
// (approve / reject) behind dialogs. No store, confirmed by reading every
// import. Seams mocked: @/api/admin's getMethodChangeRequests,
// approveMethodChange, rejectMethodChange. ApiResponseError kept REAL
// (importOriginal). parseMethods kept REAL (pure, taxonomy-matching fixtures
// built by reading it directly -- 'Медитация' matches the bare direction
// label; 'Мой уникальный метод' matches nothing and surfaces as customText).
//
// TWO TRAPS REUSED FROM PRIOR ADMIN COVERAGE:
//   (a) primeMethodTaxonomyCatalog sits in loadInitial's `Promise.all`
//       (.vue:195) -- partial-mocked (importOriginal + spread) to an
//       always-resolving stub, same as AdminMastersView's №472 fix, so a real
//       network call never blocks the whole load into the error rung.
//   (b) TWO teleported surfaces here, not one: VConfirmDialog (wraps VModal,
//       `.v-modal__overlay`) for the promote decision, AND VBottomSheet
//       (`.v-sheet__overlay`, its OWN Teleport+Transition, transition name
//       "v-sheet") for the reject reason. Both purged in afterEach (SC-13) --
//       a closed overlay of EITHER kind can survive app.unmount() and poison
//       the next test's document.body queries.
//
// DATE-DEPENDENT: formatRelative (adminHelpers.ts:115-121, confirmed by
// reading it) uses Date.now(). No exact relative-label string is asserted
// against a fixed fixture date -- only that .mrq__when renders non-empty
// text (learned forward from the formatDateShort/formatPeriodRange misses).
//
// A REAL, NON-OBVIOUS FINDING FROM THE MUTATION PASS (see the busyId-guard
// describe block for the full trail, three separate mutation runs): onApprove
// has its own top-level guard (`if (busyId.value) return`, .vue:231) AND
// doApprove has a SEPARATE one (`if (busyId.value) return`, .vue:242). For
// the immediate-approve (no-dialog) path, these two are FULLY REDUNDANT with
// EACH OTHER, not just belt-and-suspenders in the usual sense: removing
// EITHER ONE ALONE (verified separately, two different runs) leaves the
// immediate-approve double-click test GREEN, because onApprove calls
// doApprove SYNCHRONOUSLY with no `await` between -- by the time the second
// click's onApprove() runs, `busyId` is already set from the first click's
// doApprove() call, so whichever guard is still standing (either one) catches
// it. Only removing BOTH at once turns that test red. The isolated,
// unambiguous proof of doApprove's OWN guard specifically has to go through
// onPromoteConfirm instead, which calls doApprove directly with NO guard of
// its own in front -- that test alone discriminates .vue:242. All three
// mutation states tested and restored; none left in the tree.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminMethodRequestsView from '@/views/admin/AdminMethodRequestsView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminMethodChangeItem, MethodChangeActionResponse } from '@/api/admin'

vi.mock('@/api/admin')

vi.mock('@/utils/methodTaxonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/methodTaxonomy')>()
  return {
    ...actual,
    primeMethodTaxonomyCatalog: vi.fn().mockResolvedValue(undefined),
  }
})

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: toastSuccess }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function item(overrides: Partial<AdminMethodChangeItem> = {}): AdminMethodChangeItem {
  return {
    user_id: 'm_1',
    display_name: 'Мастер Раз',
    first_name: null,
    last_name: null,
    avatar_url: null,
    current_methods: [],
    proposed_methods: ['Медитация'],
    submitted_at: new Date(Date.now() - 5 * 60000).toISOString(),
    ...overrides,
  }
}

// Matches the taxonomy bare direction label -- parseMethods resolves it
// cleanly, customEnabled stays false (verified by reading parseMethods).
const ITEM_MATCHED = item({
  user_id: 'm_matched',
  display_name: 'Мастер Совпавший',
  proposed_methods: ['Медитация'],
})
// Matches NOTHING in the taxonomy -- parseMethods surfaces it verbatim as
// the custom/unmatched variant (customEnabled=true, customText=the label).
const ITEM_CUSTOM = item({
  user_id: 'm_custom',
  display_name: 'Мастер Кастомный',
  proposed_methods: ['Мой уникальный метод'],
})

function paginated(items: AdminMethodChangeItem[], total?: number) {
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
  app = createApp(AdminMethodRequestsView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.mrq') ?? [])
}
function cardByName(name: string): HTMLElement {
  const c = cards().find((c) => c.querySelector('.mrq__name')?.textContent?.trim() === name)
  if (!c) throw new Error(`no request card named «${name}»`)
  return c
}
function btnByText(root: HTMLElement, t: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === t,
  )
}
function retryBtn(): HTMLButtonElement | undefined {
  return host ? btnByText(host, 'Повторить') : undefined
}
function moreBtn(): HTMLButtonElement | undefined {
  return host ? btnByText(host, 'Показать ещё') : undefined
}

// Two DIFFERENT teleported surfaces (SC-07 -- never query `host` for either).
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
function modalIsOpen(): boolean {
  const el = modalOverlay()
  return !!el && !el.classList.contains('v-modal-leave-active')
}
function sheetOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-sheet__overlay')
}
function sheetIsOpen(): boolean {
  const el = sheetOverlay()
  return !!el && !el.classList.contains('v-sheet-leave-active')
}
function sheetTextarea(): HTMLTextAreaElement {
  const el = sheetOverlay()?.querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!el) throw new Error('reject textarea did not render')
  return el
}
function setValue(el: HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getMethodChangeRequests)
    .mockReset()
    .mockResolvedValue(paginated([ITEM_MATCHED, ITEM_CUSTOM], 2))
  vi.mocked(adminApi.approveMethodChange).mockReset()
  vi.mocked(adminApi.rejectMethodChange).mockReset()

  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13 -- both teleported surfaces this screen genuinely opens.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('AdminMethodRequestsView', () => {
  // ===========================================================================
  describe('ladder + recovery', () => {
    it('shows the loading spinner while the initial fetch is in flight, then content', async () => {
      let resolveList!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getMethodChangeRequests).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveList = resolve
          }),
      )
      mount()
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveList(paginated([ITEM_MATCHED], 1))
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('empty list: shows the success empty-state', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Заявок нет')
      expect(cards()).toHaveLength(0)
    })

    it('failure (generic error): shows the error rung and toasts the fallback message', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Не удалось загрузить')
      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки заявок')
    })

    it('failure (ApiResponseError): the toast carries the real backend detail', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Сервер недоступен')
    })

    it('"Повторить" calls loadInitial and recovers from error to content', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty__title')).not.toBeNull()

      vi.mocked(adminApi.getMethodChangeRequests).mockResolvedValue(paginated([ITEM_MATCHED], 1))
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('the relative timestamp renders SOME non-empty label (date-dependent, not asserted exactly)', async () => {
      mount()
      await flush()

      const when = cardByName('Мастер Совпавший').querySelector('.mrq__when')
      expect(when?.textContent?.trim()).toBeTruthy()
    })
  })

  // ===========================================================================
  // NOT a mutation-proof for the `&& items.length === 0` clause specifically
  // (.vue:26) -- attempted that exact mutation (dropped the clause, leaving
  // `v-if="loading"` alone) and this test STILL PASSED. Investigated why:
  // `loading` is written ONLY by loadInitial (never by loadMore, which uses
  // its own separate `loadingMore` ref, .vue:158,209,218) -- and loadInitial
  // itself synchronously resets `items.value = []` as part of the SAME
  // prologue that sets `loading.value = true` (.vue:186-190), before any
  // render can happen. So `loading` and `items.length > 0` can never actually
  // be true at the same time in the CURRENT code -- the clause is provably
  // redundant, not load-bearing. The list-doesn't-blank behavior this test
  // verifies is real and correct, it's just guaranteed by loadMore never
  // touching `loading` at all, not by this specific template clause. Reported
  // as a minor redundancy (same honesty discipline as №474's stepNext
  // finding), not fixed here -- removing the dead clause is a one-line
  // cosmetic cleanup with zero behavior change, out of this task's scope.
  describe('load-more must NOT blank the list (.vue:26)', () => {
    it('rows already rendered stay visible while a load-more is in flight', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockResolvedValueOnce(
        paginated([ITEM_MATCHED], 2),
      )
      mount()
      await flush()
      expect(cards()).toHaveLength(1)
      expect(moreBtn()).toBeDefined()

      let resolvePage2!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getMethodChangeRequests).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve
          }),
      )
      moreBtn()?.click()
      await nextTick()

      // In flight: the loader must NOT take over -- the existing row stays.
      expect(host?.querySelector('.amr__loader')).toBeNull()
      expect(cards()).toHaveLength(1)
      expect(cardByName('Мастер Совпавший')).toBeDefined()

      resolvePage2(paginated([ITEM_CUSTOM], 2))
      await flush()

      expect(cards()).toHaveLength(2)
    })
  })

  // ===========================================================================
  // CORRECTION TO RECON, MEASURED: inverting .vue:233's `customEnabled` check
  // does NOT turn both tests below red -- only the custom-fixture one.
  // Investigated why: parseMethods' own invariant (methodTaxonomy.ts) makes
  // `customEnabled` and `customText !== ''` ALWAYS equal by construction
  // (`customEnabled: unmatched.length > 0`, `customText:
  // unmatched.join(', ')` -- unmatched.length>0 iff the join is non-empty).
  // For the MATCHED fixture, customText is always '' regardless of how
  // customEnabled is negated, so `X && ''` is falsy either way -- the
  // matched-fixture test is structurally insensitive to any single-token
  // mutation of the `customEnabled` half specifically. It has its own,
  // independent mutation-proof instead: removing the `void doApprove(item)`
  // call at .vue:238 turns IT red (0 calls instead of 1) without touching
  // .vue:233 at all -- verified separately, restored, see the ГОТОВО report.
  describe('THE CROWN BRANCH -- approve pauses only for custom methods (.vue:230-239)', () => {
    it('a fully taxonomy-matching proposal approves IMMEDIATELY, no dialog', async () => {
      vi.mocked(adminApi.approveMethodChange).mockResolvedValue({
        user_id: 'm_matched',
        status: 'approved',
      })
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Одобрить')?.click()
      await flush()

      expect(adminApi.approveMethodChange).toHaveBeenCalledWith('m_matched', undefined, undefined)
      expect(modalIsOpen()).toBe(false)
      expect(toastSuccess).toHaveBeenCalledWith('Методы обновлены')
    })

    it('a custom/unmatched proposal makes NO api call yet -- opens the promote dialog with that label', async () => {
      mount()
      await flush()

      btnByText(cardByName('Мастер Кастомный'), 'Одобрить')?.click()
      await flush()

      expect(adminApi.approveMethodChange).not.toHaveBeenCalled()
      expect(modalIsOpen()).toBe(true)
      expect(modalOverlay()?.textContent).toContain('Мой уникальный метод')
    })
  })

  // ===========================================================================
  describe('THE CONSEQUENTIAL ARG -- promote vs not (.vue:257-269)', () => {
    it('«Добавить в каталог» approves WITH the promote array (enters the global catalog)', async () => {
      vi.mocked(adminApi.approveMethodChange).mockResolvedValue({
        user_id: 'm_custom',
        status: 'approved',
      })
      mount()
      await flush()

      btnByText(cardByName('Мастер Кастомный'), 'Одобрить')?.click()
      await flush()
      btnByText(document.body, 'Добавить в каталог')?.click()
      await flush()

      expect(adminApi.approveMethodChange).toHaveBeenCalledWith(
        'm_custom', ['Мой уникальный метод'], undefined,
      )
    })

    it('«Только этому мастеру» approves scoped to THIS master only (T22-6, ПРОМТ №561)', async () => {
      // Was "approves WITHOUT promote (undefined)": that used to mean the
      // label vanished entirely -- no catalog write anywhere (T22-6). Now it
      // takes the OTHER branch, master_only, so the direction gets a real
      // (master-scoped) row instead of nothing.
      vi.mocked(adminApi.approveMethodChange).mockResolvedValue({
        user_id: 'm_custom',
        status: 'approved',
      })
      mount()
      await flush()

      btnByText(cardByName('Мастер Кастомный'), 'Одобрить')?.click()
      await flush()
      btnByText(document.body, 'Только этому мастеру')?.click()
      await flush()

      expect(adminApi.approveMethodChange).toHaveBeenCalledWith(
        'm_custom', undefined, ['Мой уникальный метод'],
      )
    })
  })

  // ===========================================================================
  describe('doApprove success/failure (.vue:241-255)', () => {
    it('success: removes the row and decrements the header count', async () => {
      vi.mocked(adminApi.approveMethodChange).mockResolvedValue({
        user_id: 'm_matched',
        status: 'approved',
      })
      mount()
      await flush()
      expect(host?.querySelector('.amr__count')?.textContent).toBe('2')

      btnByText(cardByName('Мастер Совпавший'), 'Одобрить')?.click()
      await flush()

      expect(cards()).toHaveLength(1)
      expect(() => cardByName('Мастер Совпавший')).toThrow()
      expect(host?.querySelector('.amr__count')?.textContent).toBe('1')
    })

    it('failure: toasts the real detail and the row STAYS', async () => {
      vi.mocked(adminApi.approveMethodChange).mockRejectedValue(
        new ApiResponseError(409, 'Заявка уже обработана', 'already_decided'),
      )
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Одобрить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Заявка уже обработана')
      expect(cardByName('Мастер Совпавший')).toBeDefined()
      expect(cards()).toHaveLength(2)
    })

    it('failure (non-ApiResponseError): falls back to the generic message', async () => {
      vi.mocked(adminApi.approveMethodChange).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Одобрить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка при одобрении')
    })
  })

  // ===========================================================================
  describe('busyId reentrancy + per-row disable (.vue:231,242, real finding -- see banner)', () => {
    it('the busy row disables BOTH its buttons while approving', async () => {
      let resolveApprove!: (v: MethodChangeActionResponse) => void
      vi.mocked(adminApi.approveMethodChange).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApprove = resolve
          }),
      )
      mount()
      await flush()

      const card = cardByName('Мастер Совпавший')
      btnByText(card, 'Одобрить')?.click()
      await flush()

      expect(btnByText(card, 'Одобрить')?.disabled).toBe(true)
      expect(btnByText(card, 'Отклонить')?.disabled).toBe(true)

      resolveApprove({ user_id: 'm_matched', status: 'approved' })
      await flush()
    })

    // Proves overall reentrancy-safety of this button (approveMethodChange
    // called once), but NOT a discriminating proof of either individual
    // guard: onApprove (.vue:231) and doApprove (.vue:242) are FULLY
    // REDUNDANT with each other for THIS specific path (measured, three
    // separate mutation runs -- see the file banner). Removing either guard
    // ALONE leaves this test green; only removing BOTH turns it red. The
    // isolated proof of doApprove's own guard specifically is the
    // promote-confirm test right below.
    it('immediate-approve path: a same-tick double click makes no second api call (either guard alone would do it -- see comment)', async () => {
      let resolveApprove!: (v: MethodChangeActionResponse) => void
      vi.mocked(adminApi.approveMethodChange).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApprove = resolve
          }),
      )
      mount()
      await flush()

      const btn = btnByText(cardByName('Мастер Совпавший'), 'Одобрить')!
      btn.click()
      btn.click() // no await -- DOM disabled attribute not painted yet
      await flush()

      expect(adminApi.approveMethodChange).toHaveBeenCalledTimes(1)

      resolveApprove({ user_id: 'm_matched', status: 'approved' })
      await flush()
    })

    // ISOLATES doApprove's OWN internal guard (.vue:242), unambiguously:
    // onPromoteConfirm calls doApprove directly with NO guard of its own in
    // front (unlike the immediate-approve path above). This is the test that
    // actually goes red if JUST doApprove's own guard is removed -- verified
    // directly, see the mutation trail in the ГОТОВО report.
    it('promote-confirm path: a same-tick double click on "Добавить в каталог" makes no second api call', async () => {
      let resolveApprove!: (v: MethodChangeActionResponse) => void
      vi.mocked(adminApi.approveMethodChange).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApprove = resolve
          }),
      )
      mount()
      await flush()

      btnByText(cardByName('Мастер Кастомный'), 'Одобрить')?.click()
      await flush()

      const confirmBtn = btnByText(document.body, 'Добавить в каталог')!
      confirmBtn.click()
      confirmBtn.click() // no await
      await flush()

      expect(adminApi.approveMethodChange).toHaveBeenCalledTimes(1)

      resolveApprove({ user_id: 'm_custom', status: 'approved' })
      await flush()
    })
  })

  // ===========================================================================
  describe('reject leg (openReject/closeReject/doReject)', () => {
    it('openReject shows the bottom sheet', async () => {
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Отклонить')?.click()
      await flush()

      expect(sheetIsOpen()).toBe(true)
    })

    it('VALIDATION: an empty (or whitespace-only) reason blocks submit with "Укажите причину отказа", no api call', async () => {
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), '   ')
      await flush()
      btnByText(sheetOverlay()!, 'Отклонить заявку')?.click()
      await flush()

      expect(sheetOverlay()?.querySelector('.v-textarea__error')?.textContent?.trim()).toBe(
        'Укажите причину отказа',
      )
      expect(adminApi.rejectMethodChange).not.toHaveBeenCalled()
      expect(sheetIsOpen()).toBe(true)
    })

    it('success: rejectMethodChange called with the TRIMMED reason, row removed, sheet closes', async () => {
      vi.mocked(adminApi.rejectMethodChange).mockResolvedValue({
        user_id: 'm_matched',
        status: 'rejected',
      })
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), '  Не соответствует требованиям  ')
      await flush()
      btnByText(sheetOverlay()!, 'Отклонить заявку')?.click()
      await flush()

      expect(adminApi.rejectMethodChange).toHaveBeenCalledWith(
        'm_matched',
        'Не соответствует требованиям',
      )
      expect(toastSuccess).toHaveBeenCalledWith('Заявка отклонена')
      expect(sheetIsOpen()).toBe(false)
      expect(() => cardByName('Мастер Совпавший')).toThrow()
    })

    it('failure: toasts the real detail and the row stays', async () => {
      vi.mocked(adminApi.rejectMethodChange).mockRejectedValue(
        new ApiResponseError(409, 'Заявка уже обработана', 'already_decided'),
      )
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), 'Причина')
      await flush()
      btnByText(sheetOverlay()!, 'Отклонить заявку')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Заявка уже обработана')
      expect(cardByName('Мастер Совпавший')).toBeDefined()
    })

    it('reject reentrancy: a rapid double-submit makes no second api call (the save button has NO disabled wiring)', async () => {
      let resolveReject!: (v: MethodChangeActionResponse) => void
      vi.mocked(adminApi.rejectMethodChange).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReject = resolve
          }),
      )
      mount()
      await flush()

      btnByText(cardByName('Мастер Совпавший'), 'Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), 'Причина')
      await flush()

      const saveBtn = btnByText(sheetOverlay()!, 'Отклонить заявку')!
      saveBtn.click()
      saveBtn.click()
      await flush()

      expect(adminApi.rejectMethodChange).toHaveBeenCalledTimes(1)

      resolveReject({ user_id: 'm_matched', status: 'rejected' })
      await flush()
    })
  })

  // ===========================================================================
  describe('pagination (.vue:208-220)', () => {
    it('loadMore requests offset = current items length and appends', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockResolvedValueOnce(
        paginated([ITEM_MATCHED], 2),
      )
      mount()
      await flush()
      expect(cards()).toHaveLength(1)

      vi.mocked(adminApi.getMethodChangeRequests).mockResolvedValueOnce(
        paginated([ITEM_CUSTOM], 2),
      )
      moreBtn()?.click()
      await flush()

      expect(adminApi.getMethodChangeRequests).toHaveBeenLastCalledWith(20, 1)
      expect(cards()).toHaveLength(2)
    })

    it('hasMore is false once every item has been fetched: no "Показать ещё"', async () => {
      vi.mocked(adminApi.getMethodChangeRequests).mockResolvedValue(
        paginated([ITEM_MATCHED, ITEM_CUSTOM], 2),
      )
      mount()
      await flush()

      expect(moreBtn()).toBeUndefined()
    })
  })
})
