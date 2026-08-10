// =============================================================================
// VELO Frontend -- AdminCatalogView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 424 lines. The GLOBAL taxonomy catalog -- the same catalog AdminMethodRequestsView's
// «Добавить в каталог» promote path (№476) writes into. PATTERN = local-refs +
// a reactive Record (`newStyleLabel`, keyed per direction id) + FIVE mutating
// CRUD operations. No store, confirmed by reading every import. Seams mocked:
// @/api/taxonomy's getFullTaxonomy / createTaxonomyDirection /
// createTaxonomyStyle / updateTaxonomyDirection / updateTaxonomyStyle.
// ApiResponseError kept REAL (importOriginal). NO teleported dialogs on this
// screen -- the edit is INLINE (editingDirectionId gates an input vs a label
// in the SAME row) -- no SC-13 cleanup needed, simpler than №475/№476.
//
// LADDER: only THREE rungs, confirmed by reading the template -- loading
// (.vue:57) / error (.vue:59-66) / content (v-else on the v-for, .vue:68-70).
// NO separate empty rung: an empty `directions` array just renders zero
// `.admin-catalog__dir` cards under the SAME v-else branch -- verified below
// by asserting zero cards render for an empty fixture, not by asserting any
// dedicated empty-state markup (there isn't one).
//
// CORRECTION/CLARIFICATION TO RECON: `load()`'s catch block (.vue:182-183) is
// SILENT -- `catch { error.value = true }`, no toast.error, no e.detail
// extraction at all, unlike AdminMethodRequestsView/AdminPracticesView's
// load() functions. The VEmptyState's description is a hardcoded string, not
// driven by the error. Confirmed by reading the exact lines; asserted below
// as the real (if surprising) behavior, not assumed.
//
// POST-MUTATION REFRESH: all FIVE mutations call `await load()` on success
// (RELOAD from the server), NOT local-state patching -- confirmed at
// .vue:208,228,257,271,284, and stated in the file's own header comment
// (.vue:23-25, "Every mutation refetches the full catalog rather than
// patching local state"). Every success-path test below asserts
// getFullTaxonomy called a SECOND time, not a locally-mutated array.
//
// FIVE FALLBACK STRINGS, confirmed distinct where the code makes them
// distinct: addDirection -> 'Не удалось добавить направление' (.vue:210);
// addStyle -> 'Не удалось добавить вид' (.vue:230); saveDirectionLabel ->
// 'Не удалось сохранить' (.vue:259); toggleDirectionActive AND
// toggleStyleActive BOTH -> 'Не удалось изменить статус' (.vue:273,286) --
// these two are INTENTIONALLY identical (not a copy-paste bug; both are
// generic "status change failed" messages), so the failure-path tests for
// those two are discriminated by WHICH api function was called, not by the
// toast text (the text alone cannot tell them apart).
//
// FIXED (№478, this commit -- source + test together): saveDirectionLabel
// (.vue:250-263) used to have NO reentrancy guard at all -- no busy ref, no
// `:disabled` on the Save icon-button (unlike EVERY other mutating action on
// this screen, which all gate on a busy/loading ref AND disable their
// trigger via `:loading`). THE HABIT: a guard written on four sibling paths
// (addDirection/addStyle/toggleDirectionActive/toggleStyleActive), forgotten
// on the fifth. Root cause confirmed by the operator at file:line before this
// fix landed. Closed with a VERBATIM copy of addStyle's guard shape
// (.vue:220-234): a new `savingDirectionId` ref, `if (!label ||
// savingDirectionId.value) return`, and a `finally` resetting it -- ONE layer
// only, deliberately NOT adding a `:disabled` binding to the Save button
// (owner's ruling: this zone already produced three genuinely redundant
// second layers -- stepNext's guard vs its own `:disabled`, the
// `loading && length` conjunct, the doubled busyId guards across
// №474-№477 -- not adding a fourth candidate here). Before this commit, a
// rapid double-click fired updateTaxonomyDirection TWICE (asserted then,
// pinned as the changelog); the test below now asserts the fixed, single-call
// behavior.
//
// MUTATION DISCIPLINE (per operator correction from №476): a green mutation
// result is investigated and reported as a finding (redundant guard,
// unreachable conjunct), not silently treated as "must be red, retry until
// it is." See the addingDirection/togglingId describe blocks for the results.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminCatalogView from '@/views/admin/AdminCatalogView.vue'
import * as taxonomyApi from '@/api/taxonomy'
import { ApiResponseError } from '@/api/client'
import type { TaxonomyDirectionItem, TaxonomyStyleItem } from '@/api/taxonomy'

vi.mock('@/api/taxonomy')

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

function style(overrides: Partial<TaxonomyStyleItem> = {}): TaxonomyStyleItem {
  return {
    id: 'st_1',
    direction_id: 'dir_a',
    value: 'silence',
    label: 'Тишина',
    display_order: 0,
    is_active: true,
    source: 'seed',
    ...overrides,
  }
}

function direction(overrides: Partial<TaxonomyDirectionItem> = {}): TaxonomyDirectionItem {
  return {
    id: 'dir_1',
    value: 'meditation',
    label: 'Медитация',
    display_order: 0,
    is_active: true,
    source: 'seed',
    styles: [],
    ...overrides,
  }
}

// Fixed order: index 0/1/2 in the rendered card list.
const DIR_A = direction({
  id: 'dir_a',
  label: 'Медитация',
  source: 'seed',
  styles: [style({ id: 'st_a1', direction_id: 'dir_a', label: 'Тишина' })],
})
const DIR_B_INACTIVE = direction({
  id: 'dir_b',
  label: 'Йога',
  source: 'custom',
  is_active: false,
  styles: [style({ id: 'st_b1', direction_id: 'dir_b', label: 'Нидра', is_active: false })],
})
const DIR_C = direction({
  id: 'dir_c',
  label: 'Дыхание',
  source: 'custom',
  styles: [],
})

function taxonomy(directions: TaxonomyDirectionItem[]) {
  return { directions }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminCatalogView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function dirCards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.admin-catalog__dir') ?? [])
}
function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function iconBtn(card: HTMLElement, label: string): HTMLButtonElement | undefined {
  return card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined
}
function textBtn(card: HTMLElement, t: string): HTMLButtonElement | undefined {
  return Array.from(card.querySelectorAll<HTMLButtonElement>('.v-btn')).find(
    (b) => b.textContent?.trim() === t,
  )
}
// NOTE: verified by dumping the actual rendered DOM -- a `class` prop passed
// to VInput lands on the INNER `<input>` element itself, alongside
// `v-input__field` (VInput's own template binds $attrs there, not on the
// wrapping root div). So these are COMPOUND selectors on `.v-input__field`,
// not a descendant lookup through a differently-classed ancestor.
function addDirectionInput(): HTMLInputElement {
  const el = host?.querySelector<HTMLInputElement>('.v-input__field.admin-catalog__add-input')
  if (!el) throw new Error('add-direction input did not render')
  return el
}
function addDirectionBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === '+ Добавить',
  )
}
function editInput(card: HTMLElement): HTMLInputElement {
  const el = card.querySelector<HTMLInputElement>('.v-input__field.admin-catalog__edit-input')
  if (!el) throw new Error('edit input did not render')
  return el
}
function styleInput(card: HTMLElement): HTMLInputElement {
  const el = card.querySelector<HTMLInputElement>('.v-input__field.admin-catalog__add-style-input')
  if (!el) throw new Error('add-style input did not render')
  return el
}
function styleAddBtn(card: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(card.querySelectorAll<HTMLButtonElement>('.v-btn')).find(
    (b) => b.textContent?.trim() === '+',
  )
}
function chips(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>('.v-chip'))
}
function setValue(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(taxonomyApi.getFullTaxonomy)
    .mockReset()
    .mockResolvedValue(taxonomy([DIR_A, DIR_B_INACTIVE, DIR_C]))
  vi.mocked(taxonomyApi.createTaxonomyDirection).mockReset()
  vi.mocked(taxonomyApi.createTaxonomyStyle).mockReset()
  vi.mocked(taxonomyApi.updateTaxonomyDirection).mockReset()
  vi.mocked(taxonomyApi.updateTaxonomyStyle).mockReset()

  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminCatalogView', () => {
  // ===========================================================================
  describe('ladder + recovery', () => {
    it('shows the loading spinner while the fetch is in flight, then content', async () => {
      let resolveList!: (v: ReturnType<typeof taxonomy>) => void
      vi.mocked(taxonomyApi.getFullTaxonomy)
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

      resolveList(taxonomy([DIR_A]))
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(dirCards()).toHaveLength(1)
    })

    it('an EMPTY catalog renders zero direction cards -- there is no dedicated empty rung', async () => {
      vi.mocked(taxonomyApi.getFullTaxonomy).mockResolvedValue(taxonomy([]))
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(dirCards()).toHaveLength(0)
    })

    it('failure: shows the error rung with a STATIC description (load() never calls toast.error)', async () => {
      vi.mocked(taxonomyApi.getFullTaxonomy).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить каталог',
      )
      expect(host?.querySelector('.v-empty__desc')?.textContent).toBe(
        'Проверьте соединение и попробуйте ещё раз',
      )
      // Confirmed: load()'s catch block never toasts, unlike the other admin
      // list screens -- this is the real behavior, not an oversight to "fix".
      expect(toastError).not.toHaveBeenCalled()
    })

    it('"Повторить" calls load and recovers from error to content', async () => {
      vi.mocked(taxonomyApi.getFullTaxonomy).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty__title')).not.toBeNull()

      vi.mocked(taxonomyApi.getFullTaxonomy).mockResolvedValue(taxonomy([DIR_A]))
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(dirCards()).toHaveLength(1)
    })
  })

  // ===========================================================================
  describe('addDirection (.vue:200-214)', () => {
    it('success: createTaxonomyDirection called with a genSlug-shaped value + the label, toasts, RELOADS (not local patch)', async () => {
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockResolvedValue(direction())
      mount()
      await flush()

      setValue(addDirectionInput(), 'Новое направление')
      await flush()
      addDirectionBtn()?.click()
      await flush()

      expect(taxonomyApi.createTaxonomyDirection).toHaveBeenCalledTimes(1)
      const body = vi.mocked(taxonomyApi.createTaxonomyDirection).mock.calls[0]?.[0]
      // genSlug(): `custom_${Math.random().toString(36).slice(2,10)}` -- shape
      // asserted, not a literal (it's random).
      expect(body?.value).toMatch(/^custom_[a-z0-9]+$/)
      expect(body?.label).toBe('Новое направление')
      expect(toastSuccess).toHaveBeenCalledWith('Направление добавлено')
      // RELOAD confirmed: getFullTaxonomy called a second time (mount + this).
      expect(taxonomyApi.getFullTaxonomy).toHaveBeenCalledTimes(2)
      expect(addDirectionInput().value).toBe('') // input cleared
    })

    it('failure (ApiResponseError): toasts the real detail', async () => {
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockRejectedValue(
        new ApiResponseError(409, 'Такое направление уже есть', 'duplicate'),
      )
      mount()
      await flush()

      setValue(addDirectionInput(), 'Дубликат')
      await flush()
      addDirectionBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Такое направление уже есть')
    })

    it("failure (non-ApiResponseError): falls back to addDirection's OWN fallback string", async () => {
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      setValue(addDirectionInput(), 'Что-то новое')
      await flush()
      addDirectionBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось добавить направление')
    })

    it('addingDirection guard: a same-tick double click makes no second api call', async () => {
      let resolveCreate!: (v: TaxonomyDirectionItem) => void
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve
          }),
      )
      mount()
      await flush()

      setValue(addDirectionInput(), 'Направление')
      await flush()
      const btn = addDirectionBtn()!
      btn.click()
      btn.click() // no await -- DOM disabled attribute not painted yet
      await flush()

      expect(taxonomyApi.createTaxonomyDirection).toHaveBeenCalledTimes(1)

      resolveCreate(direction())
      await flush()
    })

    it('the button is disabled when the input is empty/whitespace-only', async () => {
      mount()
      await flush()

      expect(addDirectionBtn()?.disabled).toBe(true)

      setValue(addDirectionInput(), '   ')
      await flush()
      expect(addDirectionBtn()?.disabled).toBe(true)

      setValue(addDirectionInput(), 'Реальный текст')
      await flush()
      expect(addDirectionBtn()?.disabled).toBe(false)
    })
  })

  // ===========================================================================
  describe('addStyle (.vue:220-234) + per-direction Record isolation', () => {
    it('success: createTaxonomyStyle called with the RIGHT direction id + label, toasts, reloads', async () => {
      vi.mocked(taxonomyApi.createTaxonomyStyle).mockResolvedValue(style())
      mount()
      await flush()

      const cardA = dirCards()[0]! // DIR_A
      setValue(styleInput(cardA), 'Новый вид')
      await flush()
      styleAddBtn(cardA)?.click()
      await flush()

      expect(taxonomyApi.createTaxonomyStyle).toHaveBeenCalledTimes(1)
      const [dirId, body] = vi.mocked(taxonomyApi.createTaxonomyStyle).mock.calls[0]!
      expect(dirId).toBe('dir_a')
      expect(body.value).toMatch(/^custom_[a-z0-9]+$/)
      expect(body.label).toBe('Новый вид')
      expect(toastSuccess).toHaveBeenCalledWith('Вид добавлен')
      expect(taxonomyApi.getFullTaxonomy).toHaveBeenCalledTimes(2)
    })

    it("ISOLATION: typing under direction A does not leak into direction C's input", async () => {
      mount()
      await flush()

      const cardA = dirCards()[0]! // DIR_A (active)
      const cardC = dirCards()[2]! // DIR_C (active)
      setValue(styleInput(cardA), 'Стиль A')
      setValue(styleInput(cardC), 'Стиль C')
      await flush()

      expect(styleInput(cardA).value).toBe('Стиль A')
      expect(styleInput(cardC).value).toBe('Стиль C')

      vi.mocked(taxonomyApi.createTaxonomyStyle).mockResolvedValue(style())
      styleAddBtn(cardA)?.click()
      await flush()

      const [dirIdA, bodyA] = vi.mocked(taxonomyApi.createTaxonomyStyle).mock.calls[0]!
      expect(dirIdA).toBe('dir_a')
      expect(bodyA.label).toBe('Стиль A')

      // C's field is untouched by A's submit.
      expect(styleInput(dirCards()[2]!).value).toBe('Стиль C')
    })

    it('failure (ApiResponseError): toasts the real detail', async () => {
      vi.mocked(taxonomyApi.createTaxonomyStyle).mockRejectedValue(
        new ApiResponseError(409, 'Такой вид уже есть', 'duplicate'),
      )
      mount()
      await flush()

      const cardA = dirCards()[0]!
      setValue(styleInput(cardA), 'Дубликат')
      await flush()
      styleAddBtn(cardA)?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Такой вид уже есть')
    })

    it("failure (non-ApiResponseError): falls back to addStyle's OWN fallback string", async () => {
      vi.mocked(taxonomyApi.createTaxonomyStyle).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      const cardA = dirCards()[0]!
      setValue(styleInput(cardA), 'Вид')
      await flush()
      styleAddBtn(cardA)?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось добавить вид')
    })
  })

  // ===========================================================================
  describe('inline edit (startEditDirection/cancelEdit/saveDirectionLabel, .vue:241-261)', () => {
    it('startEditDirection seeds draftLabel and switches that row to input mode', async () => {
      mount()
      await flush()

      const cardA = dirCards()[0]!
      expect(cardA.querySelector('.admin-catalog__edit-input')).toBeNull()

      iconBtn(cardA, 'Редактировать')?.click()
      await flush()

      expect(editInput(cardA).value).toBe('Медитация')
    })

    it('cancelEdit exits WITHOUT calling any api', async () => {
      mount()
      await flush()

      const cardA = dirCards()[0]!
      iconBtn(cardA, 'Редактировать')?.click()
      await flush()
      setValue(editInput(cardA), 'Изменённое (не сохранится)')
      await flush()
      iconBtn(cardA, 'Отмена')?.click()
      await flush()

      expect(cardA.querySelector('.admin-catalog__edit-input')).toBeNull()
      expect(cardA.querySelector('.admin-catalog__dir-title')?.textContent).toBe('Медитация')
      expect(taxonomyApi.updateTaxonomyDirection).not.toHaveBeenCalled()
    })

    it('saveDirectionLabel sends the DRAFTED label, toasts, reloads', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockResolvedValue(direction())
      mount()
      await flush()

      const cardA = dirCards()[0]!
      iconBtn(cardA, 'Редактировать')?.click()
      await flush()
      setValue(editInput(cardA), 'Медитация (обновлено)')
      await flush()
      iconBtn(cardA, 'Сохранить')?.click()
      await flush()

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledWith('dir_a', {
        label: 'Медитация (обновлено)',
      })
      expect(toastSuccess).toHaveBeenCalledWith('Сохранено')
      expect(taxonomyApi.getFullTaxonomy).toHaveBeenCalledTimes(2)
    })

    it('failure (ApiResponseError): toasts the real detail', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockRejectedValue(
        new ApiResponseError(409, 'Такая метка уже занята', 'duplicate'),
      )
      mount()
      await flush()

      const cardA = dirCards()[0]!
      iconBtn(cardA, 'Редактировать')?.click()
      await flush()
      setValue(editInput(cardA), 'Занято')
      await flush()
      iconBtn(cardA, 'Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Такая метка уже занята')
    })

    it("failure (non-ApiResponseError): falls back to saveDirectionLabel's OWN fallback string", async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      const cardA = dirCards()[0]!
      iconBtn(cardA, 'Редактировать')?.click()
      await flush()
      setValue(editInput(cardA), 'Что-то')
      await flush()
      iconBtn(cardA, 'Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить')
    })

    // FIXED (see file banner, №478): saveDirectionLabel now carries
    // `savingDirectionId`, a verbatim copy of addStyle's guard shape --
    // ONE layer only, no `:disabled` added to the Save button (owner's
    // ruling: this zone already has three genuinely redundant second layers,
    // not adding a fourth candidate). A rapid double-click now fires the
    // PATCH once.
    it('saveDirectionLabel reentrancy guard: a rapid double-click on Save makes no second api call', async () => {
      let resolveSave!: (v: TaxonomyDirectionItem) => void
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve
          }),
      )
      mount()
      await flush()

      const cardA = dirCards()[0]!
      iconBtn(cardA, 'Редактировать')?.click()
      await flush()
      setValue(editInput(cardA), 'Двойной клик')
      await flush()

      const saveBtn = iconBtn(cardA, 'Сохранить')!
      saveBtn.click()
      saveBtn.click() // no await -- no :disabled exists to block this at the DOM level
      await flush()

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledTimes(1)

      resolveSave(direction())
      await flush()
    })
  })

  // ===========================================================================
  describe('activate/deactivate (.vue:266-290)', () => {
    it('an ACTIVE direction shows "Деактивировать"; toggling calls the api with is_active=false, reloads', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockResolvedValue(direction())
      mount()
      await flush()

      const cardA = dirCards()[0]! // active
      expect(textBtn(cardA, 'Деактивировать')).toBeDefined()
      expect(textBtn(cardA, 'Активировать')).toBeUndefined()

      textBtn(cardA, 'Деактивировать')?.click()
      await flush()

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledWith('dir_a', {
        is_active: false,
      })
      expect(taxonomyApi.getFullTaxonomy).toHaveBeenCalledTimes(2)
    })

    it('an INACTIVE direction shows "Активировать"; toggling calls the api with is_active=true', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockResolvedValue(direction())
      mount()
      await flush()

      const cardB = dirCards()[1]! // DIR_B_INACTIVE
      expect(textBtn(cardB, 'Активировать')).toBeDefined()
      expect(textBtn(cardB, 'Деактивировать')).toBeUndefined()

      textBtn(cardB, 'Активировать')?.click()
      await flush()

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledWith('dir_b', { is_active: true })
    })

    it('an INACTIVE direction hides its styles entirely (no chips, no add-style input)', async () => {
      mount()
      await flush()

      const cardB = dirCards()[1]!
      expect(chips(cardB)).toHaveLength(0)
      expect(cardB.querySelector('.admin-catalog__add-style-input')).toBeNull()
      expect(cardB.querySelector('.admin-catalog__none')?.textContent).toContain('Неактивно')
    })

    it("failure: toasts the real detail (ApiResponseError) or the toggle's OWN fallback", async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      const cardA = dirCards()[0]!
      textBtn(cardA, 'Деактивировать')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось изменить статус')
    })

    it('a style toggle calls updateTaxonomyStyle with the flipped is_active, reloads', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockResolvedValue(style())
      mount()
      await flush()

      const cardA = dirCards()[0]!
      chips(cardA)[0]?.click() // Тишина, is_active: true -> toggling to false
      await flush()

      expect(taxonomyApi.updateTaxonomyStyle).toHaveBeenCalledWith('st_a1', { is_active: false })
      expect(taxonomyApi.getFullTaxonomy).toHaveBeenCalledTimes(2)
    })

    it('a style-toggle failure falls back to the SAME shared string as the direction toggle (not a copy-paste bug -- see banner)', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      const cardA = dirCards()[0]!
      chips(cardA)[0]?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось изменить статус')
      // Discriminated by WHICH api was called, since the text is identical:
      expect(taxonomyApi.updateTaxonomyStyle).toHaveBeenCalledTimes(1)
      expect(taxonomyApi.updateTaxonomyDirection).not.toHaveBeenCalled()
    })

    it('togglingId is SHARED ACROSS ROWS (same function, two directions): a same-tick double toggle makes only one call', async () => {
      let resolveToggle!: (v: TaxonomyDirectionItem) => void
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveToggle = resolve
          }),
      )
      mount()
      await flush()

      const cardA = dirCards()[0]!
      const cardC = dirCards()[2]!
      textBtn(cardA, 'Деактивировать')?.click()
      textBtn(cardC, 'Деактивировать')?.click() // no await -- same togglingId ref
      await flush()

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledTimes(1)

      resolveToggle(direction())
      await flush()
    })

    // Mutation-checked which guard actually discriminates here: removing
    // toggleDirectionActive's OWN guard (.vue:267) left this test GREEN --
    // it still sets togglingId unconditionally, so toggleStyleActive's guard
    // (.vue:280) catches the second click regardless. Only removing
    // toggleStyleActive's OWN guard turns THIS test red. So this is really an
    // isolated proof of .vue:280, not .vue:267 -- both were verified
    // separately and restored; see the ГОТОВО report for the full trail.
    it('togglingId is SHARED ACROSS FUNCTIONS: a direction toggle in flight blocks a style toggle on the SAME card', async () => {
      let resolveToggle!: (v: TaxonomyDirectionItem) => void
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveToggle = resolve
          }),
      )
      mount()
      await flush()

      const cardA = dirCards()[0]!
      textBtn(cardA, 'Деактивировать')?.click() // toggleDirectionActive -- sets togglingId
      chips(cardA)[0]?.click() // toggleStyleActive -- SAME togglingId ref, no await
      await flush()

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledTimes(1)
      expect(taxonomyApi.updateTaxonomyStyle).not.toHaveBeenCalled()

      resolveToggle(direction())
      await flush()
    })
  })

  // ===========================================================================
  // PROMPT №503 commit 4: a long/unbreakable title or style label used to force
  // this whole screen wider than the viewport (missing overflow-wrap on
  // .admin-catalog__dir-title, missing wrap-or-truncate on this screen's
  // VChip usage). happy-dom has NO layout engine -- getComputedStyle returns
  // empty strings for scoped-style properties here (same limitation noted in
  // FeedbackView.test.ts), so actual overflow/no-overflow cannot be asserted
  // in this suite.
  //
  // MUTATION-CHECKED, reported not silently trusted: reverting the CSS-only
  // fix (both .vue files back to pre-commit-4) leaves BOTH tests below green
  // -- they only assert the long content lands inside the target elements/
  // selectors (.admin-catalog__dir-title, .admin-catalog__chips > .v-chip),
  // which was already true before this commit (no template changed, only
  // <style>). They do NOT prove the CSS fix itself; they guard against a
  // future refactor silently renaming/moving these classes out from under
  // the (untestable-here) CSS rules. Real "does it still overflow"
  // verification is UNVERIFIED by this suite and needs the owner's device
  // check.
  // ===========================================================================
  describe('long/unbreakable content lands in the elements the overflow fix targets (PROMPT №503 commit 4)', () => {
    it('a long single-word direction title renders inside .admin-catalog__dir-title (the overflow-wrap target)', async () => {
      const longLabel = 'Суперкалифраджилистикэкспиалидоциознейшийпрактикующий'
      vi.mocked(taxonomyApi.getFullTaxonomy).mockResolvedValue(
        taxonomy([direction({ id: 'dir_long', label: longLabel, styles: [] })]),
      )
      mount()
      await flush()

      const title = dirCards()[0]!.querySelector('.admin-catalog__dir-title')
      expect(title).not.toBeNull()
      expect(title?.textContent).toBe(longLabel)
    })

    it('a long single-word style label renders as a .v-chip inside .admin-catalog__chips (the wrap-or-truncate target)', async () => {
      const longLabel = 'Экстраординарноглубокаярасслабляющаяпрактикадыхания'
      vi.mocked(taxonomyApi.getFullTaxonomy).mockResolvedValue(
        taxonomy([
          direction({
            id: 'dir_a',
            styles: [style({ id: 'st_long', direction_id: 'dir_a', label: longLabel })],
          }),
        ]),
      )
      mount()
      await flush()

      const chipsContainer = dirCards()[0]!.querySelector('.admin-catalog__chips')
      expect(chipsContainer).not.toBeNull()
      const chip = chipsContainer?.querySelector('.v-chip')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toContain(longLabel)
    })
  })
})
