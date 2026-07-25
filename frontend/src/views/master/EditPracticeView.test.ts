// =============================================================================
// VELO Frontend -- EditPracticeView Screen Tests
// =============================================================================
//
// The only screen a master can destroy a practice from, and both ways out are
// one-way doors:
//
//   cancelPractice() (EditPracticeView.vue:588) POSTs /practices/:id/cancel,
//   which refunds EVERY confirmed booking on the backend, atomically
//   (api/practices.ts:115-125). There is no un-cancel endpoint. Money has left.
//   The screen's own success toast says it out loud: «возвраты выполнены».
//
//   deletePractice() (:615) soft-deletes a draft. The screen's own confirm text
//   is «Это действие нельзя отменить» (:603).
//
// So the assertions that earn their keep here are: neither action fires on a
// single click, each one reaches the RIGHT id, cancel carries the RIGHT scope
// (a wrong scope refunds a whole series instead of one evening), delete is
// offered on a draft and NOWHERE else, and a failure never claims success nor
// navigates away.
//
// PATTERN C (hybrid) -- the two halves are driven through DIFFERENT seams, and
// mixing them would gut the test (velo-idiom §3 of Step 3):
//   - DATA half: the practice arrives from useMasterStore's cache OR, on a miss,
//     from getPractice() (:465-475). The store is a DEPENDENCY, not the thing
//     under test, so it is mocked wholesale behind getters over a mutable object
//     (the guards.test.ts trick, velo-idiom §5); @/api/practices is the other
//     seam.
//   - FORM half: `form` is a local reactive() the screen fills from the fetched
//     practice (populateForm, :430-454). It is driven by REAL DOM interaction --
//     typing into the field, tapping the real teleported DatePickerSheet -- never
//     by poking `form`. Faking the form would mean asserting our own fixture.
//
// NO PINIA. Verified rather than assumed: `useMasterStore` is module-mocked
// above, and NO child this screen renders resolves a store of its own (grep for
// use*Store over src/components hits only BookingPopup and RoleSwitchSection,
// neither of which is in this tree). The PracticeDetailView precedent installs a
// real Pinia because ITS children need one; ours do not, and installing one to
// look consistent would be cargo.
//
// TIME IS PINNED (vi.setSystemTime), for two independent reasons:
//   - todayLocalISO() feeds the date picker's :min from the wall clock (W-8,
//     :374) -- which day cells are disabled is otherwise a different answer
//     every run.
//   - CancelPracticeDialog renders formatDateShort(), which compares against
//     `new Date()` for «Сегодня»/«Завтра» (utils/format.ts:65-85).
// Fixtures are literals relative to the frozen instant.
//
// TIMEZONE: the FIXTURE's zone is pinned (Europe/Moscow), the RUNNER's is not,
// and the assertions are written so it need not be. populateForm renders the
// stored UTC instant as wall-clock in the PRACTICE's own zone (:441-443) and
// save() converts it back through that same zone (:523-531) -- a round-trip that
// is stable in every runner zone. That is the property under test; Moscow is
// UTC+3 with no DST since 2014, so the arithmetic is a constant.
//
// NO NBSP NORMALISATION, deliberately. This screen renders no formatMoney at
// all -- there is no price field in the template (the price is carried in `form`
// and shipped unchanged on save, :548), and CancelPracticeDialog shows title /
// when / participant count, no amounts. The one money assertion here is on the
// PATCH BODY's integer cents, not on rendered text, so the ru U+00A0 trap
// (velo-idiom §11) cannot bite. If a price field is ever added to this form,
// this paragraph stops being true.
//
// THE TAXONOMY CATALOG IS SEAMED AT ensureTaxonomyCatalog(), not at the network.
// It rides a module-level cache that lives for the whole test FILE
// (utils/methodTaxonomy.ts:109,169-178) -- letting the real one run would make
// test N's options depend on whether test N-1 warmed it, which is exactly the
// order dependence the banner would then have to declare. Mocked to null, every
// test gets the hardcoded DIRECTION_OPTIONS fallback (practiceOptions.ts:268-271).
//
// NO ORDER DEPENDENCE. Declaration order is execution order, but nothing here
// relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import EditPracticeView from '@/views/master/EditPracticeView.vue'
import * as practicesApi from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import type { MasterProfileResponse, PracticeResponse, UpdatePracticeRequest } from '@/api/types'

vi.mock('@/api/practices')

// Seamed at the helper, not at @/api/taxonomy: the real one caches for the whole
// file (see the banner). Resolving null = catalog cold -> hardcoded fallback.
vi.mock('@/utils/methodTaxonomy', async () => {
  const actual =
    await vi.importActual<typeof import('@/utils/methodTaxonomy')>('@/utils/methodTaxonomy')
  return { ...actual, ensureTaxonomyCatalog: vi.fn() }
})
import { ensureTaxonomyCatalog } from '@/utils/methodTaxonomy'

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// The master store is a DEPENDENCY: the screen reads its practices cache and
// asks it to invalidate after a mutation. Getters over a mutable object so tests
// mutate state instead of re-mocking (velo-idiom §5).
//
// A4 V3 (ПРОМТ №571): profile/profileLoaded added -- directionOptions/
// styleOptionsForForm now filter to the master's own confirmed methods,
// same as CreatePracticeView.test.ts's masterState.
const masterState: {
  practices: PracticeResponse[]
  profile: MasterProfileResponse | null
  profileLoaded: boolean
} = { practices: [], profile: null, profileLoaded: true }
const refreshMyPractices = vi.fn()
vi.mock('@/stores/master', () => ({
  useMasterStore: () => ({
    get practices() {
      return masterState.practices
    },
    get profile() {
      return masterState.profile
    },
    get profileLoaded() {
      return masterState.profileLoaded
    },
    refreshMyPractices,
  }),
}))

const NOW = new Date('2026-07-20T12:00:00Z')

// Europe/Moscow (UTC+3, no DST) on purpose: it is NOT the runner's zone, so a
// screen that rendered the editor's zone instead of the practice's would show
// 10:00 here and fail loudly.
function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'master_1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Утренняя практика',
    description: 'Описание',
    what_to_prepare: 'Коврик',
    contraindications: 'Беременность',
    // 2 days out, 13:00 Moscow wall-clock.
    scheduled_at: '2026-07-22T10:00:00Z',
    duration_minutes: 60,
    timezone: 'Europe/Moscow',
    max_participants: 10,
    current_participants: 3,
    zoom_link: 'https://zoom.us/j/1',
    parent_practice_id: null,
    is_free: false,
    price_cents: 2599,
    currency: 'EUR',
    direction: 'yoga',
    style: 'hatha',
    difficulty: 'beginner',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  } as PracticeResponse
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(EditPracticeView)
  app.mount(host)
  return host
}

/** Put the practice in the store cache and mount -- the instant path (:465-470). */
function mountCached(p: PracticeResponse): HTMLElement {
  masterState.practices = [p]
  routeParams.id = p.id
  return mount()
}

// onMounted's network branch awaits getPractice() then re-renders; the deepest
// chain in the file is cancel(): await cancelPractice -> await refreshMyPractices
// -> push -> re-render, and the fire-and-forget ensureTaxonomyCatalog().then()
// lands somewhere alongside it. Four awaits plus the paint; six leaves margin.
// (velo-idiom §3: count YOUR chain, do not copy a number. This one is counted.)
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

function titleField(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('.v-input__field') ?? null
}

function field(selector: string): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>(selector) ?? null
}

function typeInto(el: HTMLInputElement | null, value: string): void {
  if (!el) throw new Error('field not rendered')
  el.value = value
  el.dispatchEvent(new Event('input'))
}

// A4 V3: this screen's VSelects carry no `placeholder` prop (unlike
// CreatePracticeView's), so there is no first placeholder <option> to key
// off of (VSelect.vue:23) -- identify by the rendered <label> text instead.
function selectByLabel(label: string): HTMLSelectElement | undefined {
  const wrappers = Array.from(host?.querySelectorAll('.v-select') ?? [])
  const wrapper = wrappers.find(
    (w) => w.querySelector('.v-select__label')?.textContent?.trim() === label,
  )
  return wrapper?.querySelector<HTMLSelectElement>('select.v-select__field') ?? undefined
}

function choose(el: HTMLSelectElement | undefined, value: string): void {
  if (!el) throw new Error('select not rendered')
  el.value = value
  if (el.value !== value) throw new Error(`option "${value}" is not offered`)
  el.dispatchEvent(new Event('change'))
}

// -- Teleported overlays (VModal.vue:20, VBottomSheet.vue:18) live on
//    document.body, NOT under host (SC-07). Each is scoped to its OWN dialog:
//    VConfirmDialog and CancelPracticeDialog are BOTH always in the tree (only
//    :open differs), and a dead one may still be parked from earlier in the same
//    test -- a bare document.body button search would click the wrong dialog.

/** The branded cancel modal's «Отменить» (CancelPracticeDialog.vue:52). */
function cancelModalConfirm(): HTMLButtonElement | undefined {
  const actions = document.body.querySelector('.cpd__actions')
  return Array.from(actions?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Отменить',
  ) as HTMLButtonElement | undefined
}

/** The branded cancel modal's «Не отменять». */
function cancelModalDismiss(): HTMLButtonElement | undefined {
  const actions = document.body.querySelector('.cpd__actions')
  return Array.from(actions?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Не отменять',
  ) as HTMLButtonElement | undefined
}

/** The generic VConfirmDialog's confirm button (VConfirmDialog.vue:27-33). */
function confirmDialogConfirm(label: string): HTMLButtonElement | undefined {
  const actions = document.body.querySelector('.v-confirm__actions')
  return Array.from(actions?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined
}

/** Drive the REAL teleported DatePickerSheet: open it, tap `day`, save. */
async function pickDay(day: number): Promise<void> {
  host?.querySelector<HTMLElement>('.edit-practice__picker')?.click()
  await flush()

  const cell = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dps__day')).find(
    (b) => !b.disabled && b.textContent?.trim() === String(day),
  )
  if (!cell) throw new Error(`day ${day} is not selectable in the open month`)
  cell.click()
  await flush()

  const save = document.body.querySelector<HTMLButtonElement>('.v-sheet__save')
  if (!save) throw new Error('sheet save button not rendered')
  save.click()
  await flush()
}

/** The body the screen actually PATCHed. */
function sentBody(): UpdatePracticeRequest {
  const call = vi.mocked(practicesApi.updatePractice).mock.calls[0]
  if (!call) throw new Error('updatePractice was never called')
  return call[1]
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  masterState.practices = []
  // A4 V3: matches the default practice() fixture's direction='yoga'/
  // style='hatha' -- keeps every pre-existing test (none of which cares
  // about taxonomy) on a CONFIRMED value, so directionOptions/
  // styleOptionsForForm never empty out from under them. The tests that
  // specifically exercise the filter/rejection override this per-test.
  masterState.profile = { methods: ['Йога', 'Йога — Хатха-йога'] } as MasterProfileResponse
  masterState.profileLoaded = true
  routeParams.id = 'p1'
  vi.mocked(ensureTaxonomyCatalog).mockReset().mockResolvedValue(null)
  vi.mocked(practicesApi.getPractice).mockReset().mockResolvedValue(practice())
  vi.mocked(practicesApi.updatePractice).mockReset().mockResolvedValue(practice())
  vi.mocked(practicesApi.deletePractice).mockReset().mockResolvedValue(undefined)
  vi.mocked(practicesApi.cancelPractice)
    .mockReset()
    .mockResolvedValue(practice({ status: 'cancelled' }))
  refreshMyPractices.mockReset().mockResolvedValue(undefined)
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  window.history.replaceState({}, '')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // MANDATORY (SC-13). A CLOSED teleported overlay survives app.unmount():
  // VModal/VBottomSheet wrap it in a <Transition> (VModal.vue:21-22,
  // VBottomSheet.vue:19-20), and when `open` flips to false Vue holds the leaving
  // element pending a transitionend that happy-dom never fires. It stays parked
  // directly on document.body, outliving the app that owns its handlers. The next
  // test then finds the DEAD dialog first in document order, clicks it, and
  // nothing happens -- the signature is that the FIRST modal test in the file
  // passes and every later one fails while the screen is perfectly healthy.
  // This screen parks three of them: VConfirmDialog + CancelPracticeDialog (both
  // .v-modal__overlay) and the two picker sheets (.v-sheet__overlay).
  document.body
    .querySelectorAll('.v-modal__overlay, .v-sheet__overlay')
    .forEach((el) => el.remove())

  window.history.replaceState({}, '')
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('EditPracticeView', () => {
  describe('the state ladder', () => {
    it('shows the loader while the practice is in flight', async () => {
      vi.mocked(practicesApi.getPractice).mockReturnValue(
        new Promise(() => {}) as Promise<PracticeResponse>,
      )
      mount()
      await flush()

      expect(host?.querySelector('.edit-practice__loader')).not.toBeNull()
      expect(button('Сохранить')).toBeUndefined()
    })

    it('a cache HIT renders instantly and never touches the network', async () => {
      // :465-470 -- the list already fetched this record; refetching it would
      // put a spinner in front of a master who just tapped a card they can see.
      mountCached(practice({ title: 'Вечерняя йога' }))
      await flush()

      expect(practicesApi.getPractice).not.toHaveBeenCalled()
      expect(host?.querySelector('.edit-practice__loader')).toBeNull()
      expect(titleField()?.value).toBe('Вечерняя йога')
    })

    it('a cache MISS fetches THIS practice by the route id', async () => {
      routeParams.id = 'p42'
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p42', title: 'Из сети' }),
      )
      mount()
      await flush()

      expect(practicesApi.getPractice).toHaveBeenCalledWith('p42')
      expect(titleField()?.value).toBe('Из сети')
    })

    it('a cached OTHER practice is not mistaken for this one', async () => {
      // `.find(p => p.id === practiceId)` (:465). Matching loosely here would
      // load a master's other practice into an editor titled with this one's id
      // -- and then PATCH it.
      masterState.practices = [practice({ id: 'p_other', title: 'Чужая' })]
      routeParams.id = 'p1'
      mount()
      await flush()

      expect(practicesApi.getPractice).toHaveBeenCalledWith('p1')
      expect(titleField()?.value).toBe('Утренняя практика')
    })

    it('a failed fetch surfaces the REAL backend detail and offers no form', async () => {
      // The empty state's «Практика не найдена» is the screen's OWN constant
      // (:58) -- the backend's message reaches the master only through the toast
      // (:477). Asserting both, and claiming neither is the other (SC-05).
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(404, 'Практика удалена', 'not_found'),
      )
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Практика удалена')
      expect(text()).toContain('Практика не найдена')
      expect(titleField()).toBeNull()
      expect(button('Сохранить')).toBeUndefined()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить практику')
    })

    it('the not-found state offers a way back to the list', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      button('Назад')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-practices' })
    })
  })

  describe('the form holds the practice\'s own values', () => {
    it('renders the date and time in the PRACTICE\'s timezone, not the editor\'s', async () => {
      // :441-443. 10:00Z is 13:00 in Europe/Moscow. A screen that rendered the
      // browser's zone would show a master a time their students will not see,
      // and then save that time back.
      mountCached(practice())
      await flush()

      const pickers = Array.from(
        host?.querySelectorAll('.edit-practice__picker') ?? [],
      ) as HTMLElement[]
      expect(pickers[0]?.textContent?.trim()).toBe('22 июля 2026')
      expect(pickers[1]?.textContent?.trim()).toBe('13:00')
    })

    it('an UNCAPPED practice shows an empty seats field, not «null» or 0', async () => {
      // `p.max_participants != null ? String(...) : ''` (:446). Rendering null as
      // "0" would cap an open practice the moment the master saves anything.
      mountCached(practice({ max_participants: null }))
      await flush()

      expect(field('input[type="number"]')?.value).toBe('')
    })

    it('renders the practice\'s own text fields', async () => {
      mountCached(practice({ contraindications: 'Травмы спины' }))
      await flush()

      const areas = Array.from(host?.querySelectorAll('textarea') ?? [])
      expect(areas.map((a) => (a as HTMLTextAreaElement).value)).toContain('Травмы спины')
      expect(field('input[type="url"]')?.value).toBe('https://zoom.us/j/1')
    })
  })

  describe('Направление/Вид: confirmed-methods parity with CreatePracticeView (A4 V3, ПРОМТ №571)', () => {
    it('offers NOTHING (not the whole catalogue) while the master profile has not loaded yet', async () => {
      // Mirrors CreatePracticeView's identical test (ПРОМТ №556, OWNER-2).
      // Before this fix, EditPracticeView's directionOptions was
      // catalogDirectionOptions(catalog.value) unconditionally -- it never
      // consulted profileLoaded/confirmedMethods at all, so this state was
      // indistinguishable from "profile loaded, everything confirmed".
      masterState.profile = null
      masterState.profileLoaded = false
      mountCached(practice())
      await flush()

      const opts = Array.from(selectByLabel('Направление')?.options ?? []).map((o) =>
        o.textContent?.trim(),
      )
      expect(opts).not.toContain('Йога')
      expect(opts).not.toContain('Медитация')
      expect(opts).toHaveLength(0)
    })

    it('narrows Направление to the master\'s own confirmed methods, not the whole catalogue', async () => {
      // The real break this closes: before the fix, a master confirmed for
      // ONLY "Йога" still saw the full catalogue (Медитация, Дыхательные
      // практики, ...) on the edit screen, unlike CreatePracticeView which
      // already narrows this (T21-6, ПРОМТ №546).
      masterState.profile = { methods: ['Йога', 'Йога — Хатха-йога'] } as MasterProfileResponse
      mountCached(practice())
      await flush()

      const opts = Array.from(selectByLabel('Направление')?.options ?? []).map((o) =>
        o.textContent?.trim(),
      )
      expect(opts).toContain('Йога')
      expect(opts).not.toContain('Медитация')
    })

    it('narrows Вид практики to the confirmed styles for the CURRENT direction', async () => {
      masterState.profile = { methods: ['Йога', 'Йога — Хатха-йога'] } as MasterProfileResponse
      mountCached(practice({ direction: 'yoga', style: 'hatha' }))
      await flush()

      const opts = Array.from(selectByLabel('Вид практики')?.options ?? []).map((o) =>
        o.textContent?.trim(),
      )
      expect(opts).toContain('Хатха-йога')
      // "Йога — Кундалини" is NOT in this master's confirmed methods.
      expect(opts).not.toContain('Кундалини-йога')
    })

    it('picking a different CONFIRMED direction reaches the PATCH body', async () => {
      // Exercises the filtered select through a REAL interaction, not just
      // its option list -- confirms the fix actually WIRES into form.direction
      // and onDirectionChange still resets the now-stale style.
      masterState.profile = { methods: ['Йога', 'Медитация'] } as MasterProfileResponse
      mountCached(practice({ direction: 'yoga', style: 'hatha' }))
      await flush()

      choose(selectByLabel('Направление'), 'meditation')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().direction).toBe('meditation')
      expect(sentBody().style).toBeNull()
    })
  })

  describe('what each status is allowed to do', () => {
    it('a DRAFT offers publish and delete, never cancel', async () => {
      // Cancelling a draft is meaningless -- nobody has paid for it yet, so
      // there is nothing to refund. Delete is its one-way door (:221-231).
      mountCached(practice({ status: 'draft' }))
      await flush()

      expect(button('Опубликовать практику')).toBeDefined()
      expect(button('Удалить черновик')).toBeDefined()
      expect(button('Отменить практику')).toBeUndefined()
    })

    it('a SCHEDULED practice offers cancel, never delete', async () => {
      // The inverse of the draft case, and the sharper half: DELETE has no
      // refund path (api/practices.ts:110-113). Offering it on a practice
      // students have paid for would strip the record out from under their money.
      mountCached(practice({ status: 'scheduled' }))
      await flush()

      expect(button('Отменить практику')).toBeDefined()
      expect(button('Удалить черновик')).toBeUndefined()
      expect(button('Опубликовать практику')).toBeUndefined()
    })

    it('a LIVE practice offers cancel, never delete', async () => {
      mountCached(practice({ status: 'live' }))
      await flush()

      expect(button('Отменить практику')).toBeDefined()
      expect(button('Удалить черновик')).toBeUndefined()
    })

    it('a COMPLETED practice is readonly -- no save, no actions', async () => {
      // isTerminal (:408-413). Editing or cancelling a practice that already
      // happened would rewrite history that students have already been billed for.
      mountCached(practice({ status: 'completed' }))
      await flush()

      expect(host?.querySelector('.edit-practice__readonly-banner')).not.toBeNull()
      expect(text()).toContain('Редактирование недоступно')
      expect(text()).toContain('Завершена')
      expect(button('Сохранить')).toBeUndefined()
      expect(button('Отменить практику')).toBeUndefined()
      expect(button('Удалить черновик')).toBeUndefined()
    })

    it('a CANCELLED practice is readonly and cannot be cancelled AGAIN', async () => {
      // A second cancel would be a second refund run against the same bookings.
      mountCached(practice({ status: 'cancelled' }))
      await flush()

      expect(text()).toContain('Отменена')
      expect(text()).toContain('Редактирование недоступно')
      expect(button('Отменить практику')).toBeUndefined()
      expect(button('Сохранить')).toBeUndefined()
    })

    it('a DELETED practice is readonly with no badge at all', async () => {
      // masterPracticeBadge('deleted') is null (practiceStatus.ts:38-41), so the
      // v-if drops it -- the banner still has to say the screen is readonly, or a
      // deleted practice would look editable.
      mountCached(practice({ status: 'deleted' }))
      await flush()

      expect(host?.querySelector('.edit-practice__readonly-banner')).not.toBeNull()
      expect(text()).toContain('Редактирование недоступно')
      expect(button('Сохранить')).toBeUndefined()
    })
  })

  describe('cancelling: real refunds, no inverse', () => {
    it('«Отменить практику» does NOT cancel -- it only opens the branded modal', async () => {
      // One click must never refund a room full of students (:578-580).
      mountCached(practice({ status: 'scheduled' }))
      await flush()

      button('Отменить практику')?.click()
      await flush()

      expect(practicesApi.cancelPractice).not.toHaveBeenCalled()
      expect(cancelModalConfirm()).toBeDefined()
    })

    it('the modal warns that money will move, and names THIS practice', async () => {
      // The master's entire basis for the decision: which practice, when, and
      // how many people are about to be refunded (CancelPracticeDialog.vue:24-40).
      mountCached(practice({ status: 'scheduled', title: 'Вечерняя йога' }))
      await flush()

      button('Отменить практику')?.click()
      await flush()

      const modal = document.body.querySelector('.cpd')?.textContent ?? ''
      expect(modal).toContain('Отменить практику?')
      expect(modal).toContain('Вечерняя йога')
      expect(modal).toContain('Оплаты вернутся автоматически')
      expect(modal).toContain('3 участников')
      // Rendered in the practice's own zone: 10:00Z = 13:00 Moscow, 22 July.
      expect(modal).toContain('22 июля, 13:00')
    })

    it('«Не отменять» closes the modal and refunds nothing', async () => {
      mountCached(practice({ status: 'scheduled' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      cancelModalDismiss()?.click()
      await flush()

      expect(practicesApi.cancelPractice).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    })

    it('confirming cancels THIS practice, scoped to «this» only', async () => {
      // A non-series practice has no siblings, so the scope radio is hidden and
      // the dialog's 'one' default maps to 'this' (CancelPracticeDialog.vue:91-93).
      // Shipping 'this_and_future' here would be a wider refund than asked for.
      mountCached(practice({ id: 'p7', status: 'scheduled', practice_type: 'live' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      cancelModalConfirm()?.click()
      await flush()

      expect(practicesApi.cancelPractice).toHaveBeenCalledTimes(1)
      expect(practicesApi.cancelPractice).toHaveBeenCalledWith('p7', 'this')
    })

    it('a non-series practice offers NO scope radio', async () => {
      mountCached(practice({ status: 'scheduled', practice_type: 'live' }))
      await flush()

      button('Отменить практику')?.click()
      await flush()

      expect(document.body.querySelector('.cpd__recur')).toBeNull()
      expect(document.body.querySelectorAll('.v-radio')).toHaveLength(0)
    })

    it('a SERIES defaults to «Только эту» -- the narrow refund, not the wide one', async () => {
      // The default decides what happens to every FUTURE occurrence's bookings.
      // Defaulting wide would refund a whole course because a master cancelled
      // one evening (CancelPracticeDialog.vue:83).
      mountCached(practice({ id: 'p7', status: 'scheduled', practice_type: 'series' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      expect(document.body.querySelector('.cpd__recur')?.textContent).toContain(
        'Это регулярная практика',
      )
      const radios = Array.from(document.body.querySelectorAll('.v-radio'))
      expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
      expect(radios[0]?.textContent).toContain('Только эту')

      cancelModalConfirm()?.click()
      await flush()

      expect(practicesApi.cancelPractice).toHaveBeenCalledWith('p7', 'this')
    })

    it('picking «Эту и будущие» on a series sends this_and_future', async () => {
      // The radio's own vocabulary is 'one'/'future'; the backend's is
      // 'this'/'this_and_future' (api/practices.ts:120-124). The mapping is the
      // only thing standing between the two, and it decides the refund's blast
      // radius.
      mountCached(practice({ id: 'p7', status: 'scheduled', practice_type: 'series' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      const wide = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.v-radio')).find(
        (b) => b.textContent?.includes('Эту и будущие'),
      )
      expect(wide).toBeDefined()
      wide?.click()
      await flush()

      cancelModalConfirm()?.click()
      await flush()

      expect(practicesApi.cancelPractice).toHaveBeenCalledWith('p7', 'this_and_future')
    })

    it('on success: says the refunds ran, invalidates the cache, leaves the editor', async () => {
      // refreshMyPractices is not cosmetic (:592): the list still holds the
      // pre-cancel record, and THIS screen loads from that cache (:465) -- a
      // stale entry would re-open a cancelled practice with a live cancel button.
      mountCached(practice({ status: 'scheduled' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      cancelModalConfirm()?.click()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Практика отменена, возвраты выполнены')
      expect(refreshMyPractices).toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith({ name: 'master-practices' })
    })

    it('a FAILED cancel surfaces the real reason and never claims the refunds ran', async () => {
      // Telling a master «возвраты выполнены» when the POST failed is the worst
      // outcome on this screen: they walk away believing their students were
      // paid back.
      vi.mocked(practicesApi.cancelPractice).mockRejectedValue(
        new ApiResponseError(409, 'Практика уже началась', 'already_live'),
      )
      mountCached(practice({ status: 'scheduled' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      cancelModalConfirm()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Практика уже началась')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(refreshMyPractices).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.cancelPractice).mockRejectedValue(new TypeError('boom'))
      mountCached(practice({ status: 'scheduled' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      cancelModalConfirm()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отменить')
      expect(push).not.toHaveBeenCalled()
    })

    it('does NOT refund twice when confirm is hit twice in flight', async () => {
      // The `cancelling` re-entry guard (:585). A second POST here is a second
      // refund run against the same bookings.
      let resolve!: (v: PracticeResponse) => void
      vi.mocked(practicesApi.cancelPractice).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mountCached(practice({ status: 'scheduled' }))
      await flush()
      button('Отменить практику')?.click()
      await flush()

      cancelModalConfirm()?.click()
      await nextTick()
      cancelModalConfirm()?.click()
      await nextTick()

      expect(practicesApi.cancelPractice).toHaveBeenCalledTimes(1)

      resolve(practice({ status: 'cancelled' }))
      await flush()
    })
  })

  describe('deleting a draft: «нельзя отменить»', () => {
    it('«Удалить черновик» does NOT delete -- it only opens the confirm', async () => {
      mountCached(practice({ status: 'draft' }))
      await flush()

      button('Удалить черновик')?.click()
      await flush()

      expect(practicesApi.deletePractice).not.toHaveBeenCalled()
      expect(confirmDialogConfirm('Удалить')).toBeDefined()
    })

    it('the confirm says the action cannot be undone', async () => {
      // :603. The screen makes this promise to the master; it is the only warning
      // between them and an irreversible soft-delete.
      mountCached(practice({ status: 'draft' }))
      await flush()

      button('Удалить черновик')?.click()
      await flush()

      expect(document.body.querySelector('.v-confirm__text')?.textContent).toBe(
        'Удалить черновик? Это действие нельзя отменить.',
      )
    })

    it('«Отмена» in the confirm deletes nothing', async () => {
      mountCached(practice({ status: 'draft' }))
      await flush()
      button('Удалить черновик')?.click()
      await flush()

      confirmDialogConfirm('Отмена')?.click()
      await flush()

      expect(practicesApi.deletePractice).not.toHaveBeenCalled()
    })

    it('confirming deletes THIS draft by id, invalidates the cache and leaves', async () => {
      mountCached(practice({ id: 'p7', status: 'draft' }))
      await flush()
      button('Удалить черновик')?.click()
      await flush()

      confirmDialogConfirm('Удалить')?.click()
      await flush()

      expect(practicesApi.deletePractice).toHaveBeenCalledTimes(1)
      expect(practicesApi.deletePractice).toHaveBeenCalledWith('p7')
      expect(toastSuccess).toHaveBeenCalledWith('Черновик удалён')
      expect(refreshMyPractices).toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith({ name: 'master-practices' })
    })

    it('a FAILED delete surfaces the real reason and never claims it is gone', async () => {
      vi.mocked(practicesApi.deletePractice).mockRejectedValue(
        new ApiResponseError(409, 'Черновик уже опубликован', 'not_draft'),
      )
      mountCached(practice({ status: 'draft' }))
      await flush()
      button('Удалить черновик')?.click()
      await flush()

      confirmDialogConfirm('Удалить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Черновик уже опубликован')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.deletePractice).mockRejectedValue(new TypeError('boom'))
      mountCached(practice({ status: 'draft' }))
      await flush()
      button('Удалить черновик')?.click()
      await flush()

      confirmDialogConfirm('Удалить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось удалить')
    })

    it('does NOT delete twice when confirm is hit twice in flight', async () => {
      // The confirmDialog.loading re-entry guard (:612).
      let resolve!: () => void
      vi.mocked(practicesApi.deletePractice).mockReturnValue(
        new Promise<void>((r) => {
          resolve = r
        }),
      )
      mountCached(practice({ status: 'draft' }))
      await flush()
      button('Удалить черновик')?.click()
      await flush()

      confirmDialogConfirm('Удалить')?.click()
      await nextTick()
      confirmDialogConfirm('Удалить')?.click()
      await nextTick()

      expect(practicesApi.deletePractice).toHaveBeenCalledTimes(1)

      resolve()
      await flush()
    })
  })

  describe('publishing a draft', () => {
    it('PATCHes status=scheduled and nothing else', async () => {
      // :565. Publish must not smuggle the form's current state into the same
      // PATCH -- a master who edited a field and hit Publish (not Save) would
      // silently ship an edit they never confirmed.
      mountCached(practice({ id: 'p7', status: 'draft' }))
      await flush()

      button('Опубликовать практику')?.click()
      await flush()

      expect(practicesApi.updatePractice).toHaveBeenCalledWith('p7', { status: 'scheduled' })
      expect(toastSuccess).toHaveBeenCalledWith('Практика опубликована!')
      expect(refreshMyPractices).toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith({ name: 'master-practices' })
    })

    it('a FAILED publish surfaces the real reason and stays put', async () => {
      vi.mocked(practicesApi.updatePractice).mockRejectedValue(
        new ApiResponseError(422, 'Дата практики в прошлом', 'past_date'),
      )
      mountCached(practice({ status: 'draft' }))
      await flush()

      button('Опубликовать практику')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Дата практики в прошлом')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('validation gates (nothing reaches the API)', () => {
    it('refuses an empty title', async () => {
      mountCached(practice())
      await flush()
      typeInto(titleField(), '')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(text()).toContain('Введите название')
    })

    it('refuses a whitespace-only title', async () => {
      // `form.title.trim()` (:491). «   » is not a name students can find.
      mountCached(practice())
      await flush()
      typeInto(titleField(), '   ')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(text()).toContain('Введите название')
    })

    it('refuses a non-https zoom link', async () => {
      // :506-509. A http:// link is the one field here students act on.
      mountCached(practice())
      await flush()
      typeInto(field('input[type="url"]'), 'http://zoom.us/j/1')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(text()).toContain('Ссылка должна начинаться с https://')
    })

    it('refuses a zero or negative seat count', async () => {
      // :499-505. A practice capped at 0 is one nobody can book.
      mountCached(practice())
      await flush()
      typeInto(field('input[type="number"]'), '0')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(text()).toContain('Введите положительное число или оставьте пустым')
    })

    it('an EMPTY seat count is allowed -- empty means uncapped, not invalid', async () => {
      // The `if (form.max_participants_raw)` guard (:499) skips the check
      // entirely when blank, and save sends null (:545).
      mountCached(practice())
      await flush()
      typeInto(field('input[type="number"]'), '')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(practicesApi.updatePractice).toHaveBeenCalledTimes(1)
      expect(sentBody().max_participants).toBeNull()
    })
  })

  describe('saving: the PATCH body', () => {
    it('ships the practice\'s OWN price back, to the cent', async () => {
      // MONEY. There is no price field on this form (the section was dropped;
      // see the template's Реш. В note) -- the price only survives an edit
      // because populateForm parks it in `form` and save reads it back
      // (:449, :548). If that round-trip ever broke, every Save on this screen
      // would silently reprice the practice, and the students who booked at the
      // old price are already paid up.
      mountCached(practice({ price_cents: 2599, is_free: false }))
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().price_cents).toBe(2599)
      expect(sentBody().is_free).toBe(false)
    })

    it('survives a price that float arithmetic would mangle (W-6)', async () => {
      // 57 cents -> '0.57' -> back to 57. parseFloat('0.57') * 100 is
      // 56.99999999999999 (currency.ts:6-12); a cent lost per save is a real
      // pricing error, and the master would never see it happen.
      mountCached(practice({ price_cents: 57, is_free: false }))
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().price_cents).toBe(57)
    })

    it('a FREE practice saves as free with a zero price, not as a paid one', async () => {
      mountCached(practice({ is_free: true, price_cents: 0 }))
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().is_free).toBe(true)
      expect(sentBody().price_cents).toBe(0)
    })

    it('round-trips scheduled_at through the practice\'s OWN timezone', async () => {
      // populateForm renders 10:00Z as 13:00 Moscow (:441-443); save converts
      // 13:00 Moscow back to 10:00Z (:523-531). Saving an untouched form must
      // therefore be a no-op on the schedule -- if the two halves used different
      // zones, every Save would walk the practice by the UTC offset and the
      // students booked into it would be told a new time.
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().scheduled_at).toBe('2026-07-22T10:00:00.000Z')
      expect(sentBody().timezone).toBe('Europe/Moscow')
    })

    it('trims the title and nulls out an emptied optional field', async () => {
      // `|| null` (:538-546) -- an empty string is not "no contraindications",
      // and the backend distinguishes them.
      mountCached(practice())
      await flush()
      typeInto(titleField(), '  Новое имя  ')
      await flush()

      const zoom = field('input[type="url"]')
      typeInto(zoom, '')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().title).toBe('Новое имя')
      expect(sentBody().zoom_link).toBeNull()
    })

    it('sends duration as a NUMBER, not the select\'s string', async () => {
      // form.duration_minutes is a string from VSelect; save coerces with
      // parseInt (:543). Shipping "60" to a backend expecting an int is a 422.
      mountCached(practice({ duration_minutes: 90 }))
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody().duration_minutes).toBe(90)
      expect(typeof sentBody().duration_minutes).toBe('number')
    })

    it('on success: reports it and invalidates the list cache', async () => {
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Сохранено')
      expect(refreshMyPractices).toHaveBeenCalled()
      // Save is not a "leave the screen" action -- unlike publish/cancel/delete.
      expect(push).not.toHaveBeenCalled()
    })

    it('a FAILED save surfaces the real reason and does NOT claim it saved', async () => {
      vi.mocked(practicesApi.updatePractice).mockRejectedValue(
        new ApiResponseError(422, 'Нельзя перенести практику с бронированиями', 'has_bookings'),
      )
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Нельзя перенести практику с бронированиями')
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.updatePractice).mockRejectedValue(new TypeError('boom'))
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка сохранения')
    })

    it('A4 V3: translates direction_not_confirmed into Russian, not the raw backend detail', async () => {
      // Mirrors CreatePracticeView's submit() catch (ПРОМТ №556, OWNER-2).
      // Before this fix, EVERY rejection on this screen -- including this
      // code -- fell through to the raw e.detail branch, showing the master
      // the backend's raw English, API-shaped message.
      vi.mocked(practicesApi.updatePractice).mockRejectedValue(
        new ApiResponseError(400, "direction 'yoga' is not among your confirmed methods", 'direction_not_confirmed'),
      )
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Это направление ещё не подтверждено в вашем профиле')
      expect(toastError).not.toHaveBeenCalledWith(
        expect.stringContaining('is not among your confirmed methods'),
      )
    })

    it('A4 V3: translates style_not_confirmed into Russian, not the raw backend detail', async () => {
      vi.mocked(practicesApi.updatePractice).mockRejectedValue(
        new ApiResponseError(400, "style 'kundalini' is not among your confirmed methods", 'style_not_confirmed'),
      )
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Этот вид практики ещё не подтверждён в вашем профиле')
    })

    it('does NOT save twice when the button is hit twice in flight', async () => {
      // The `saving` re-entry guard (:515).
      let resolve!: (v: PracticeResponse) => void
      vi.mocked(practicesApi.updatePractice).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mountCached(practice())
      await flush()

      button('Сохранить')?.click()
      await nextTick()
      button('Сохранить')?.click()
      await nextTick()

      expect(practicesApi.updatePractice).toHaveBeenCalledTimes(1)

      resolve(practice())
      await flush()
    })
  })

  describe('rescheduling through the real date sheet', () => {
    it('a picked day reaches the PATCH as an instant in the practice\'s zone', async () => {
      // The form half of Pattern C, driven through the real teleported
      // DatePickerSheet rather than by poking `form.date` -- poking it would
      // assert our own fixture and leave the sheet -> form -> save wiring untested.
      mountCached(practice())
      await flush()

      await pickDay(25)

      expect(
        host?.querySelector('.edit-practice__picker')?.textContent?.trim(),
      ).toBe('25 июля 2026')

      button('Сохранить')?.click()
      await flush()

      // 13:00 Moscow on the 25th, not 00:00 and not the runner's zone.
      expect(sentBody().scheduled_at).toBe('2026-07-25T10:00:00.000Z')
    })

    it('refuses to reschedule into the past (W-8)', async () => {
      // :min="todayDate" (:273) -> DatePickerSheet disables earlier cells
      // (DatePickerSheet.vue:203). Frozen at 2026-07-20: the 19th is yesterday.
      mountCached(practice())
      await flush()

      host?.querySelector<HTMLElement>('.edit-practice__picker')?.click()
      await flush()

      const cells = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dps__day'))
      const dayCell = (n: number) =>
        cells.find((b) => !b.classList.contains('dps__day--dim') && b.textContent?.trim() === String(n))

      expect(dayCell(19)?.disabled).toBe(true)
      // Today itself stays selectable -- `ymd < min` is strict.
      expect(dayCell(20)?.disabled).toBe(false)
      expect(dayCell(21)?.disabled).toBe(false)
    })
  })

  describe('navigation', () => {
    it('back POPS to the detail screen when there is history (the back-loop fix)', async () => {
      // :327-331. Pushing a fresh detail entry instead of popping grew the stack
      // and ping-ponged edit<->detail (operator 2026-06-24). NB: onBack reads
      // window.history.state at CLICK time, not during setup -- unlike
      // AdminWithdrawalDetailView, seeding it after mount is fine here.
      mountCached(practice({ id: 'p7' }))
      await flush()
      window.history.replaceState({ back: '/master/practices/p7' }, '')

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })

    it('back on a COLD deep-link pushes the detail route instead of dead-ending', async () => {
      // No history to pop (a fresh Mini App open on this URL): router.back()
      // would leave the master staring at nothing.
      mountCached(practice({ id: 'p7' }))
      await flush()

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-practice-detail',
        params: { id: 'p7' },
      })
      expect(back).not.toHaveBeenCalled()
    })
  })

  // NOT COVERED, deliberately -- one limit of this file's seams, stated rather
  // than faked:
  //
  // W-3's anyLoading guard is only PARTLY reachable. The header claims
  // `anyLoading = saving || transitioning || cancelling || deleting`
  // (EditPracticeView.vue:32,356-358), but `deleting` is dead state: it is
  // declared (:341), read by anyLoading (:357) and bound to the delete button's
  // :loading (:226), yet NOTHING ever sets it -- remove() raises
  // confirmDialog.loading instead (:613). So during an in-flight delete
  // anyLoading is false and Save/Publish are still :disabled="false".
  //
  // That is NOT reported as a live bug, because it is not reachable: while the
  // delete runs, VConfirmDialog's overlay is `position: fixed; inset: 0` over the
  // whole viewport (VModal.vue:108-117), so no master can reach the buttons
  // behind it. The delete button's own spinner comes from the dialog's confirm
  // button, which IS wired to confirmDialog.loading. The defect is that the code
  // no longer matches its own documented invariant -- dead state, not a hole.
  //
  // A test for it would have to poke `deleting` directly, which is the form-half
  // mocking Pattern C exists to forbid (velo-idiom Step 3). The guard's three
  // LIVE flags are each proven by the re-entry tests above.
})
