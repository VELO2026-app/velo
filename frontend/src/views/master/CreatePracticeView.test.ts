// =============================================================================
// VELO Frontend -- CreatePracticeView Screen Tests
// =============================================================================
//
// This form is the only door a practice enters the world through, and it does
// NOT stop at "created". submit() (CreatePracticeView.vue:826-855) does two
// writes back to back:
//
//   createPractice(...)                       -- backend defaults status='draft'
//   updatePractice(created.id, {status:'scheduled'})  -- publishes it
//
// The second call is what makes the practice BOOKABLE by students (:850-855).
// So everything the form gets wrong ships straight to a live listing that people
// book against: a wrong scheduled_at moves a room full of students; a wrong
// recurrence spec fans one evening out into a series; a validation hole reaches
// the API as a 422 the master cannot read.
//
// The assertions that earn their keep are therefore: what can NEVER reach the
// API, the EXACT body that does, that publish sends what it claims and nothing
// else, and that the wall-clock the master typed is interpreted in the MASTER's
// timezone rather than the browser's.
//
// PATTERN C (hybrid). The two halves are driven through DIFFERENT seams, and
// mixing them would gut the test (SKILL.md Step 3):
//   - DATA half: «Использовать шаблон» reads useMasterStore's practices cache,
//     and the Направление options come from the taxonomy catalog. Both are
//     DEPENDENCIES, not the thing under test -> mocked wholesale behind getters
//     over a mutable object (the guards.test.ts trick, velo-idiom §5).
//   - FORM half: `form` is a local reactive() (:497-525) owned entirely by this
//     screen. It is driven by REAL DOM interaction -- typing into the field,
//     changing the <select>, tapping the real teleported DatePickerSheet, tapping
//     the real VDayPicker. Never by poking `form`, which would assert our own
//     fixture and leave the control -> form -> submit wiring untested.
//
// NO PINIA, verified rather than assumed. `useAuthStore` and `useMasterStore` are
// both module-mocked below, and NO child in this tree resolves a store of its own
// (grep `use\w*Store\(` over src/components hits only BookingPopup, DiaryComposer
// and RoleSwitchSection -- none of which this screen renders). Installing a real
// Pinia to look like PracticeDetailView.test.ts would be cargo.
//
// TIME IS PINNED (vi.setSystemTime), for three independent reasons:
//   - todayDate = todayLocalISO() feeds the date sheet's :min (W-7, :494) --
//     which day cells are disabled is otherwise a different answer every run.
//   - validate() compares the picked instant against Date.now() (:731).
//   - DatePickerSheet opens on `new Date()` when it has no model value.
// Fixtures are literals relative to the frozen instant.
//
// RUNNER-TIMEZONE ASSUMPTION, stated because it is real: the frozen instant is
// 2026-07-20T12:00:00Z, and the tests that name day 19/20/21 assume the runner's
// LOCAL calendar date at that instant is 2026-07-20. True for every zone from
// UTC-12 to UTC+11 (CI runs UTC); a runner at UTC+12 or further east would see
// 2026-07-21 and those three tests would fail LOUDLY (the day cell throws / the
// disabled flag flips) rather than silently pass. Same exposure the neighbouring
// EditPracticeView.test.ts already carries at the same instant.
//
// Everything else is runner-zone independent on purpose: the MASTER's zone is
// pinned in the mocked auth user (form.timezone = authStore.user?.timezone,
// :517), and both validate() and submit() interpret the picked wall-clock in
// THAT zone via luxon (:728-731, :814-817). Europe/Moscow is UTC+3 with no DST
// since 2014, so the arithmetic is a constant.
//
// NO NBSP NORMALISATION, deliberately. This screen renders no formatMoney and
// has no price field at all -- «Оплата» is a single hardcoded «Бесплатно» radio
// (:294-302) and submit ships a literal price_cents: 0 (:844). The one money
// assertion here is on the POST BODY's integer cents, not on rendered text, so
// the ru U+00A0 trap (velo-idiom §11) cannot bite. If «Платно» is ever restored
// to this form, this paragraph stops being true.
//
// THE TAXONOMY CATALOG IS SEAMED AT ensureTaxonomyCatalog(), not at the network:
// the real one rides a module-level cache that lives for the whole test FILE
// (utils/methodTaxonomy.ts), so letting it run would make test N's Направление
// options depend on whether test N-1 warmed it -- exactly the order dependence
// this banner would then have to declare. Mocked to null, every test gets the
// hardcoded DIRECTION_OPTIONS fallback (practiceOptions.ts:268-271).
//
// NO ORDER DEPENDENCE. Declaration order is execution order, but nothing here
// relies on it. localStorage is cleared per test (the draft autosave, :597).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CreatePracticeView from '@/views/master/CreatePracticeView.vue'
import * as practicesApi from '@/api/practices'
import * as groupsApi from '@/api/groups'
import { ApiResponseError } from '@/api/client'
import type {
  CreatePracticeRequest,
  MasterProfileResponse,
  PracticeResponse,
  UserResponse,
} from '@/api/types'

vi.mock('@/api/practices')
// P5 (ПРОМТ №594): «Для кого практика» -> «Конкретные группы» fetches the
// master's own custom groups on mount. Mocked wholesale (like practicesApi
// above) -- an unmocked call here would hit the real network in EVERY test
// in this file, not just the audience-specific ones below.
vi.mock('@/api/groups')

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
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: toastInfo }),
}))

// Both stores are DEPENDENCIES. Getters over a mutable object so tests mutate
// state instead of re-mocking (velo-idiom §5).
const masterState: {
  practices: PracticeResponse[]
  profile: MasterProfileResponse | null
  profileLoaded: boolean
} = {
  practices: [],
  profile: null,
  // ПРОМТ №556: defaults true -- masterStatusGuard (router/index.ts) already
  // awaits fetchMyProfile() before this screen mounts in the real app, so
  // "not yet loaded" is the abnormal case, not the default one. The two
  // tests that specifically exercise "profile hasn't loaded" override this.
  profileLoaded: true,
}
const fetchMyPractices = vi.fn()
const refreshMyPractices = vi.fn()
const fetchMyProfile = vi.fn()
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
    fetchMyPractices,
    refreshMyPractices,
    fetchMyProfile,
  }),
}))

const authState: { user: Partial<UserResponse> | null } = { user: null }
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

const NOW = new Date('2026-07-20T12:00:00Z')

/** The frozen day. See the RUNNER-TIMEZONE ASSUMPTION in the banner. */
const TODAY_DAY = 20

const DRAFT_KEY = 'velo:create-practice-draft:u1'

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
    scheduled_at: '2026-07-22T10:00:00Z',
    duration_minutes: 60,
    timezone: 'Europe/Moscow',
    max_participants: 10,
    current_participants: 3,
    zoom_link: 'https://zoom.us/j/1',
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
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
  app = createApp(CreatePracticeView)
  app.mount(host)
  return host
}

// The mount kicks off ensureTaxonomyCatalog().then(...) -- one await plus the
// re-render. The DEEPEST chain in the file is submit(): await createPractice ->
// await updatePractice -> the fire-and-forget refreshMyPractices().catch()
// continuation -> the finally's submitting=false -> the paint. Four awaits plus
// the paint = five; six leaves margin. (velo-idiom §3: count YOUR chain, do not
// copy a number. This one is counted -- it matches EditPracticeView's six by
// arithmetic, not by copying.)
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

function inputByPlaceholder(placeholder: string): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`) ?? null
}

function textareaByPlaceholder(placeholder: string): HTMLTextAreaElement | null {
  return host?.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${placeholder}"]`) ?? null
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!el) throw new Error('field not rendered')
  el.value = value
  el.dispatchEvent(new Event('input'))
}

// The four VSelects are identified by their own placeholder <option> (VSelect.vue:23)
// rather than by index: the «Вид практики» select appears and disappears with the
// chosen direction (:97), so an index would silently shift under the test.
function selectByPlaceholder(placeholder: string): HTMLSelectElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLSelectElement>('select.v-select__field') ?? []).find(
    (s) => s.options[0]?.textContent?.trim() === placeholder,
  )
}

function choose(el: HTMLSelectElement | undefined, value: string): void {
  if (!el) throw new Error('select not rendered')
  el.value = value
  if (el.value !== value) throw new Error(`option "${value}" is not offered`)
  el.dispatchEvent(new Event('change'))
}

/** The Дата / Время trigger fields (:125-160). The «Дата окончания» trigger
 *  reuses .create-practice__picker, so it is excluded by its own modifier. */
function pickerTriggers(): HTMLElement[] {
  return Array.from(
    host?.querySelectorAll<HTMLElement>(
      '.create-practice__picker:not(.create-practice__end-control)',
    ) ?? [],
  )
}

// -- Teleported sheets (VBottomSheet.vue:18-20) live on document.body, NOT under
//    host (SC-07). Every body query below is scoped to the LIVE overlay, because
//    a CLOSED one is still parked here: VBottomSheet wraps it in a <Transition>
//    whose leave awaits a transitionend happy-dom never fires, so it sits on
//    document.body carrying `v-sheet-leave-active` (SC-13). A bare
//    `document.body.querySelector('.v-sheet__save')` would find that CORPSE first
//    in document order -- and this file opens two or three sheets inside a SINGLE
//    test (date, then time, then the series end-date), so the usual "purge in
//    afterEach" is necessary but NOT sufficient here.
function liveSheet(): Element | null {
  return document.body.querySelector('.v-sheet__overlay:not(.v-sheet-leave-active)')
}

function sheetSave(): HTMLButtonElement | null {
  return liveSheet()?.querySelector<HTMLButtonElement>('.v-sheet__save') ?? null
}

function dayCells(): HTMLButtonElement[] {
  return Array.from(liveSheet()?.querySelectorAll<HTMLButtonElement>('.dps__day') ?? [])
}

/** A day cell of the VIEWED month (adjacent-month cells are .dps__day--dim). */
function dayCell(n: number): HTMLButtonElement | undefined {
  return dayCells().find(
    (b) => !b.classList.contains('dps__day--dim') && b.textContent?.trim() === String(n),
  )
}

async function tapDayAndSave(day: number): Promise<void> {
  const cell = dayCell(day)
  if (!cell) throw new Error(`day ${day} is not in the open month`)
  if (cell.disabled) throw new Error(`day ${day} is disabled by :min`)
  cell.click()
  await flush()
  sheetSave()?.click()
  await flush()
}

/** Drive the REAL teleported DatePickerSheet behind «Дата». */
async function pickDate(day: number): Promise<void> {
  pickerTriggers()[0]?.click()
  await flush()
  await tapDayAndSave(day)
}

/** Drive the REAL teleported DatePickerSheet behind «Завершить -> Выбрать дату». */
async function pickEndDate(day: number): Promise<void> {
  host?.querySelector<HTMLElement>('.create-practice__end-control.create-practice__picker')?.click()
  await flush()
  await tapDayAndSave(day)
}

/**
 * Drive the REAL teleported TimePickerSheet -- and take its DEFAULT, 12:00.
 *
 * The wheels cannot be moved from a test, and this is a harness limit, not a
 * shortcut: VWheel only emits on a real `scroll` event, debounced 140ms
 * (VWheel.vue:78-89). Tapping an item calls el.scrollTo(), which happy-dom does
 * not follow with a scroll event, and the 140ms debounce needs a macrotask that
 * a nextTick loop never grants. So TimePickerSheet's own initFromModel default
 * of 12:00 (TimePickerSheet.vue:58-71) is the only value reachable through the
 * real sheet -- and it IS the real sheet: the tap, the save button, and the
 * update:modelValue -> form.time wiring are all genuinely exercised.
 */
async function pickDefaultTime(): Promise<void> {
  pickerTriggers()[1]?.click()
  await flush()
  sheetSave()?.click()
  await flush()
}

/** The smallest form validate() will pass: 25 July 2026, 12:00 Moscow. */
async function fillMinimalForm(): Promise<void> {
  typeInto(inputByPlaceholder('Название'), 'Утренняя практика')
  choose(selectByPlaceholder('Направление практики'), 'yoga')
  await flush()
  choose(selectByPlaceholder('Уровень сложности'), 'beginner')
  choose(selectByPlaceholder('Длительность'), '60')
  await flush()
  await pickDate(25)
  await pickDefaultTime()
}

function submitForm(): void {
  const btn = button('Создать практику')
  if (!btn) throw new Error('submit button not rendered')
  btn.click()
}

/** The body the screen actually POSTed. */
function sentBody(): CreatePracticeRequest {
  const call = vi.mocked(practicesApi.createPractice).mock.calls[0]
  if (!call) throw new Error('createPractice was never called')
  return call[0]
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  localStorage.clear()
  masterState.practices = []
  // Seeded with every direction/style this file's tests actually pick
  // (T21-6, ПРОМТ №546) -- the confirmed-methods filter is real from here
  // down, not bypassed by the fail-open (no-profile) path. The two tests
  // that specifically exercise "profile hasn't loaded" / "profile narrows
  // to fewer directions" override this per-test.
  masterState.profile = {
    methods: ['Йога', 'Йога — Хатха-йога', 'Дыхательные практики', 'Круги', 'Круги — Женский круг'],
  } as MasterProfileResponse
  masterState.profileLoaded = true
  authState.user = { id: 'u1', timezone: 'Europe/Moscow' } as Partial<UserResponse>
  fetchMyProfile.mockReset().mockResolvedValue(undefined)
  vi.mocked(ensureTaxonomyCatalog).mockReset().mockResolvedValue(null)
  // ПРОМТ №559: status:'draft' -- matches the REAL backend (create_practice
  // always creates as draft; only the follow-up publish PATCH makes it
  // 'scheduled'). Left at the shared factory's default 'scheduled' this
  // would silently defeat the new guard that skips a redundant re-publish
  // PATCH when createPractice already returns an ALREADY-scheduled practice
  // (the duplicate-submission path) -- every test below expects the normal
  // create-then-publish two-call sequence unless it overrides this.
  vi.mocked(practicesApi.createPractice)
    .mockReset()
    .mockResolvedValue(practice({ id: 'p_new', status: 'draft' }))
  vi.mocked(practicesApi.updatePractice)
    .mockReset()
    .mockResolvedValue(practice({ id: 'p_new', status: 'scheduled' }))
  fetchMyPractices.mockReset().mockResolvedValue(undefined)
  refreshMyPractices.mockReset().mockResolvedValue(undefined)
  vi.mocked(groupsApi.getGroups).mockReset().mockResolvedValue({ items: [] })
  push.mockReset()
  back.mockReset()
  replace.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastInfo.mockReset()
  window.history.replaceState({}, '')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // MANDATORY (SC-13). A CLOSED teleported overlay survives app.unmount():
  // VBottomSheet wraps it in a <Transition> (VBottomSheet.vue:19-20), and when
  // `open` flips to false Vue holds the leaving element pending a transitionend
  // that happy-dom never fires. It stays parked directly on document.body,
  // outliving the app that owns its handlers. The next test then finds the DEAD
  // sheet first in document order, clicks it, and nothing happens -- the
  // signature is that the FIRST sheet test in the file passes and every later one
  // fails while the screen is perfectly healthy. This screen parks three sheets
  // (date, end-date, time), all .v-sheet__overlay.
  document.body
    .querySelectorAll('.v-sheet__overlay, .v-modal__overlay')
    .forEach((el) => el.remove())

  localStorage.clear()
  window.history.replaceState({}, '')
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('CreatePracticeView', () => {
  describe('the form renders before anything has loaded', () => {
    it('offers the whole form immediately -- there is no data to wait for', async () => {
      // Unlike its sibling EditPracticeView there is no record to fetch, so this
      // screen has no loading/error/empty ladder at all: an in-flight (or
      // outright failing) template list must never gate the form, because the
      // master can compose a practice without ever having made one.
      vi.mocked(ensureTaxonomyCatalog).mockReturnValue(new Promise(() => {}))
      fetchMyPractices.mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(inputByPlaceholder('Название')).not.toBeNull()
      expect(button('Создать практику')).toBeDefined()
      expect(selectByPlaceholder('Направление практики')).toBeDefined()
    })

    it('offers NOTHING (not the full catalog) while the master profile has not loaded yet (ПРОМТ №556, OWNER-2 fix)', async () => {
      // REVERSED by ПРОМТ №556: this used to assert a fail-OPEN fallback to
      // the full catalog while the profile was unloaded -- exactly the gap
      // that let a form present a direction/style the master was never
      // confirmed for. An unknown confirmed-set must never read as
      // "everything is allowed"; masterStatusGuard (router/index.ts) already
      // awaits fetchMyProfile() before this screen mounts in the real app, so
      // this is a defensive state, not the normal one.
      masterState.profile = null
      masterState.profileLoaded = false
      mount()
      await flush()

      const opts = Array.from(selectByPlaceholder('Направление практики')?.options ?? []).map((o) =>
        o.textContent?.trim(),
      )
      // Only the placeholder option itself remains -- no real direction.
      expect(opts).not.toContain('Йога')
      expect(opts).not.toContain('Медитация')
      expect(opts).toHaveLength(1)
    })

    it("narrows to the master's own confirmed methods once the profile has loaded (T21-6, ПРОМТ №546)", async () => {
      // Same cold catalog as above (ensureTaxonomyCatalog mocked to null) --
      // the filter is driven by MasterProfileResponse.methods, resolved via
      // parseMethods against the hardcoded DIRECTION_OPTIONS fallback, not by
      // the taxonomy catalog. A master confirmed for "Йога" only must never
      // be offered "Медитация" from the create-practice picker (T21-6): that
      // would let them create a practice in a direction they were never
      // verified for.
      masterState.profile = { methods: ['Йога'] } as MasterProfileResponse
      mount()
      await flush()

      const opts = Array.from(selectByPlaceholder('Направление практики')?.options ?? []).map((o) =>
        o.textContent?.trim(),
      )
      expect(opts).toContain('Йога')
      expect(opts).not.toContain('Медитация')
    })

    it('«Вид практики» appears only for a direction that HAS styles', async () => {
      // :97 -- catalogStylesForDirection returns [] for breathwork et al. A
      // permanently empty style select would read as a broken required field.
      mount()
      await flush()

      expect(selectByPlaceholder('Вид практики')).toBeUndefined()

      choose(selectByPlaceholder('Направление практики'), 'yoga')
      await flush()
      expect(
        Array.from(selectByPlaceholder('Вид практики')?.options ?? []).map((o) =>
          o.textContent?.trim(),
        ),
      ).toContain('Хатха-йога')

      choose(selectByPlaceholder('Направление практики'), 'breathwork')
      await flush()
      expect(selectByPlaceholder('Вид практики')).toBeUndefined()
    })

    it('changing direction drops a style that belonged to the OLD direction', async () => {
      // onDirectionChange (:562-564). Without the reset, switching Йога -> Круги
      // would POST style='hatha' under direction='circles'.
      mount()
      await flush()
      choose(selectByPlaceholder('Направление практики'), 'yoga')
      await flush()
      choose(selectByPlaceholder('Вид практики'), 'hatha')
      await flush()
      expect(selectByPlaceholder('Вид практики')?.value).toBe('hatha')

      choose(selectByPlaceholder('Направление практики'), 'circles')
      await flush()

      expect(selectByPlaceholder('Вид практики')?.value).toBe('')
    })
  })

  describe('validation gates: what can NEVER reach the API', () => {
    it('an empty form names every missing field and POSTs nothing', async () => {
      mount()
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(text()).toContain('Введите название')
      expect(text()).toContain('Выберите направление')
      expect(text()).toContain('Выберите сложность')
      expect(text()).toContain('Выберите дату')
      expect(text()).toContain('Выберите время')
      expect(text()).toContain('Выберите длительность')
    })

    it('refuses a whitespace-only title', async () => {
      // `form.title.trim()` (:704). «   » is not a name a student can find.
      mount()
      await flush()
      await fillMinimalForm()
      typeInto(inputByPlaceholder('Название'), '   ')
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Введите название')
    })

    it('refuses a zero seat count', async () => {
      // :740-746. A practice capped at 0 is one nobody can book.
      mount()
      await flush()
      await fillMinimalForm()
      typeInto(inputByPlaceholder('Максимум мест'), '0')
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Введите положительное число или оставьте пустым')
    })

    it('an EMPTY seat count is allowed -- empty means unlimited, not invalid', async () => {
      // The `if (form.max_participants_raw)` guard (:740) skips the check when
      // blank, and submit sends null (:840).
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).toHaveBeenCalledTimes(1)
      expect(sentBody().max_participants).toBeNull()
    })

    it("refuses a wall-clock that has already passed in the MASTER's timezone", async () => {
      // :727-735. Frozen at 12:00Z = 15:00 Moscow, so 12:00 Moscow TODAY is three
      // hours gone. The backend rejects a past scheduled_at with a 422 the master
      // cannot read; this gate is the only thing that explains it to them.
      mount()
      await flush()
      typeInto(inputByPlaceholder('Название'), 'Опоздавшая')
      choose(selectByPlaceholder('Направление практики'), 'yoga')
      await flush()
      choose(selectByPlaceholder('Уровень сложности'), 'beginner')
      choose(selectByPlaceholder('Длительность'), '60')
      await flush()
      await pickDate(TODAY_DAY)
      await pickDefaultTime()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Дата должна быть в будущем')
    })

    it('the date sheet disables yesterday and leaves today selectable (W-7)', async () => {
      // :min="todayDate" (:361) -> DatePickerSheet.vue:203 disables earlier days.
      // `ymd < min` is strict, so today itself must stay pickable -- a master
      // scheduling for this evening is the normal case.
      mount()
      await flush()

      pickerTriggers()[0]?.click()
      await flush()

      expect(dayCell(TODAY_DAY - 1)?.disabled).toBe(true)
      expect(dayCell(TODAY_DAY)?.disabled).toBe(false)
      expect(dayCell(TODAY_DAY + 1)?.disabled).toBe(false)
    })
  })

  describe('the POST body', () => {
    it('ships exactly what the master filled in -- every field, to the value', async () => {
      // :826-848. This is the whole contract in one assertion: anything wrong
      // here is live and bookable within the same tick, because :855 publishes it.
      mount()
      await flush()
      await fillMinimalForm()
      choose(selectByPlaceholder('Вид практики'), 'hatha')
      typeInto(inputByPlaceholder('Максимум мест'), '12')
      typeInto(textareaByPlaceholder('Расскажите подробее о вашей практике'), 'Описание')
      typeInto(textareaByPlaceholder('Противопоказания'), 'Травмы спины')
      typeInto(textareaByPlaceholder('Что подготовить'), 'Коврик')
      typeInto(inputByPlaceholder('Запасная ссылка на Zoom'), 'https://zoom.us/j/7')
      await flush()

      submitForm()
      await flush()

      expect(sentBody()).toEqual({
        practice_type: 'live',
        direction: 'yoga',
        difficulty: 'beginner',
        style: 'hatha',
        title: 'Утренняя практика',
        description: 'Описание',
        what_to_prepare: 'Коврик',
        contraindications: 'Травмы спины',
        // 12:00 Moscow on 25 July 2026 == 09:00Z. NOT the runner's zone.
        scheduled_at: '2026-07-25T09:00:00.000Z',
        duration_minutes: 60,
        timezone: 'Europe/Moscow',
        max_participants: 12,
        zoom_link: 'https://zoom.us/j/7',
        is_free: true,
        price_cents: 0,
        currency: 'eur',
        recurrence: null,
        // P5 (ПРОМТ №594): untouched «Для кого практика» -> the default.
        audience_kind: 'public',
        group_ids: [],
      })
    })

    it('carries the price to the cent -- a zero, because the form has no price', async () => {
      // MONEY. «Платно» was removed (:294-302, operator 2026-06-18 Q2=А): the
      // «Оплата» section is a single hardcoded «Бесплатно» radio bound to a
      // literal 'free' with NO handler, and submit ships is_free: form.is_free
      // (initialised true, :519) with price_cents: 0 and currency 'eur' (:843-845).
      // Nothing on this screen can move any of the three. The practice is
      // published and bookable one line later, so a non-zero price leaking in
      // here would start charging students against a form that never offered a
      // price field. Pinning the literal is the only thing that would notice.
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(sentBody().is_free).toBe(true)
      expect(sentBody().price_cents).toBe(0)
      expect(sentBody().currency).toBe('eur')
      expect(text()).toContain('Бесплатно')
    })

    it("interprets the typed wall-clock in the MASTER's zone, not the browser's", async () => {
      // :814-817. THE timezone round-trip. The master types 12:00; what is stored
      // is an instant, and every student later sees it rendered in their own zone.
      // A screen that read the browser's zone would schedule a Tokyo master's
      // practice at the wrong moment for everyone who books it -- and the master
      // would never see the error, because their own screen would render it back
      // in the same wrong zone.
      authState.user = { id: 'u1', timezone: 'Asia/Tokyo' } as Partial<UserResponse>
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      // 12:00 Tokyo (UTC+9, no DST) on 25 July 2026 == 03:00Z.
      expect(sentBody().scheduled_at).toBe('2026-07-25T03:00:00.000Z')
      expect(sentBody().timezone).toBe('Asia/Tokyo')
    })

    it('falls back to Europe/Moscow when the master has no zone on file', async () => {
      // :517. `?? 'Europe/Moscow'` -- a practice with no timezone is not
      // creatable (the backend field is required), so the default is load-bearing.
      authState.user = { id: 'u1' } as Partial<UserResponse>
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(sentBody().timezone).toBe('Europe/Moscow')
      expect(sentBody().scheduled_at).toBe('2026-07-25T09:00:00.000Z')
    })

    it("sends duration as a NUMBER, not the select's string", async () => {
      // parseInt (:838). Shipping "90" to a backend expecting an int is a 422.
      mount()
      await flush()
      await fillMinimalForm()
      choose(selectByPlaceholder('Длительность'), '90')
      await flush()

      submitForm()
      await flush()

      expect(sentBody().duration_minutes).toBe(90)
      expect(typeof sentBody().duration_minutes).toBe('number')
    })

    it('trims the title and nulls out every blank optional field', async () => {
      // `.trim() || null` (:831-842) -- an empty string is not "no
      // contraindications", and the backend distinguishes them.
      mount()
      await flush()
      await fillMinimalForm()
      typeInto(inputByPlaceholder('Название'), '  Вечерняя йога  ')
      await flush()

      submitForm()
      await flush()

      expect(sentBody().title).toBe('Вечерняя йога')
      expect(sentBody().style).toBeNull()
      expect(sentBody().description).toBeNull()
      expect(sentBody().what_to_prepare).toBeNull()
      expect(sentBody().contraindications).toBeNull()
      expect(sentBody().zoom_link).toBeNull()
    })
  })

  describe('recurrence: one evening or a whole series', () => {
    function makeRecurring(): void {
      const box = host?.querySelector<HTMLButtonElement>('button[role="checkbox"]')
      if (!box) throw new Error('«Сделать регулярной» not rendered')
      box.click()
    }

    function radio(label: string): HTMLButtonElement | undefined {
      return Array.from(
        host?.querySelectorAll<HTMLButtonElement>('button[role="radio"]') ?? [],
      ).find((b) => b.textContent?.includes(label))
    }

    function day(label: string): HTMLButtonElement | undefined {
      return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-day-picker__day') ?? []).find(
        (b) => b.textContent?.trim() === label,
      )
    }

    it('a NON-recurring practice is a one-off: live, and no spec at all', async () => {
      // :829,847. practice_type is DERIVED from the toggle -- there is no
      // practice_type field on the form.
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(sentBody().practice_type).toBe('live')
      expect(sentBody().recurrence).toBeNull()
      expect(host?.querySelector('.v-day-picker')).toBeNull()
    })

    it('the toggle alone flips the practice to a series', async () => {
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ПН')?.click()
      await flush()

      submitForm()
      await flush()

      expect(sentBody().practice_type).toBe('series')
    })

    it('a weekly series maps weekday CODES to ISO ints, in Mon->Sun order', async () => {
      // WEEKDAY_ISO (:774-782). VDayPicker speaks 'mon'..'sun'; RecurrenceSpec.days
      // wants 1..7. A wrong mapping schedules the whole course on the wrong days,
      // and every occurrence is bookable the moment :855 publishes it. Clicked
      // Sunday-first on purpose: buildRecurrence must not preserve click order.
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ВС')?.click()
      await flush()
      day('ПН')?.click()
      await flush()

      submitForm()
      await flush()

      expect(sentBody().recurrence).toEqual({ period: 'weekly', end: 'never', days: [1, 7] })
    })

    it('«Каждый день» sends NO days -- and never asks for them', async () => {
      // :210 hides the picker for daily, :791-793 omits the key, and :749 skips
      // the check. All three have to agree or a daily series is either
      // unsubmittable or carries a meaningless day list.
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      radio('Каждый день')?.click()
      await flush()

      expect(host?.querySelector('.v-day-picker')).toBeNull()

      submitForm()
      await flush()

      expect(sentBody().recurrence).toEqual({ period: 'daily', end: 'never' })
    })

    it('a weekly series with NO weekday chosen never reaches the API', async () => {
      // :749-752. An empty day list is a spec the series engine cannot expand.
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Выберите хотя бы один день недели')
    })

    it('«Раз в две недели» ships biweekly, not weekly', async () => {
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      radio('Раз в две недели')?.click()
      await flush()
      day('СР')?.click()
      await flush()

      submitForm()
      await flush()

      expect(sentBody().recurrence).toEqual({ period: 'biweekly', end: 'never', days: [3] })
    })

    it('«Выбрать дату» without a date never reaches the API', async () => {
      // :755-758. until_date with a null date is a 422 with no field feedback.
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ПН')?.click()
      radio('Выбрать дату')?.click()
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Выберите дату окончания')
    })

    it('an end date picked through the real sheet reaches the spec', async () => {
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ПН')?.click()
      radio('Выбрать дату')?.click()
      await flush()
      await pickEndDate(31)

      submitForm()
      await flush()

      expect(sentBody().recurrence).toEqual({
        period: 'weekly',
        end: 'until_date',
        days: [1],
        until_date: '2026-07-31',
      })
    })

    it('the end-date sheet cannot be set BEFORE the start date', async () => {
      // :min="form.date || todayDate" (:369). An until_date earlier than the
      // start would describe a series with no occurrences.
      mount()
      await flush()
      await fillMinimalForm() // start = 25 July
      makeRecurring()
      await flush()
      day('ПН')?.click()
      radio('Выбрать дату')?.click()
      await flush()

      host
        ?.querySelector<HTMLElement>('.create-practice__end-control.create-practice__picker')
        ?.click()
      await flush()

      expect(dayCell(24)?.disabled).toBe(true)
      expect(dayCell(25)?.disabled).toBe(false)
    })

    it('«После числа повторений» without a count never reaches the API', async () => {
      // :761-768. The input starts empty (NP-11, :511) and HTML `min` does not
      // block submit, so a cleared count would POST '' -> 422 with no feedback.
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ПН')?.click()
      radio('После числа повторений')?.click()
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Укажите число повторений (не меньше 1)')
    })

    it('a count of 0 never reaches the API', async () => {
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ПН')?.click()
      radio('После числа повторений')?.click()
      await flush()
      typeInto(host?.querySelector<HTMLInputElement>('.create-practice__count-input') ?? null, '0')
      await flush()

      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Укажите число повторений (не меньше 1)')
    })

    it('a typed count ships as a NUMBER on the spec', async () => {
      // v-model.number (:247). A string count is a 422.
      mount()
      await flush()
      await fillMinimalForm()
      makeRecurring()
      await flush()
      day('ПН')?.click()
      radio('После числа повторений')?.click()
      await flush()
      typeInto(host?.querySelector<HTMLInputElement>('.create-practice__count-input') ?? null, '4')
      await flush()

      submitForm()
      await flush()

      expect(sentBody().recurrence).toEqual({
        period: 'weekly',
        end: 'after_count',
        days: [1],
        count: 4,
      })
      expect(typeof (sentBody().recurrence?.count ?? null)).toBe('number')
    })
  })

  describe('publishing: create then make it bookable', () => {
    it('publishes the CREATED id with status=scheduled and nothing else', async () => {
      // :855. The practice the backend just returned as a 'draft' is patched
      // live in the same breath -- this PATCH is what students can book against.
      // Patching the wrong id would publish someone else's draft; smuggling form
      // fields into the same PATCH would ship an edit nobody asked for.
      vi.mocked(practicesApi.createPractice).mockResolvedValue(
        practice({ id: 'p_created', status: 'draft' }),
      )
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(practicesApi.updatePractice).toHaveBeenCalledTimes(1)
      expect(practicesApi.updatePractice).toHaveBeenCalledWith('p_created', {
        status: 'scheduled',
      })
    })

    it("ПРОМТ №559 / A4 V6 (ПРОМТ №572): a dedup-returned ALREADY-scheduled practice skips the publish PATCH AND is honestly presented as the master's existing practice, not a new one", async () => {
      // The backend's own duplicate-submission check (create_practice)
      // returns the master's EARLIER submission unchanged, status='scheduled'
      // already, when this looks like a retry within its short window --
      // and, since A4 V6, marks the response deduplicated=true. Before V6
      // this branch was reached via the status==='scheduled' heuristic
      // alone and showed "Практика создана!" like a real success -- the
      // exact defect V6 closes. A second PATCH .../status=scheduled would
      // ALSO 400 ("Cannot transition from scheduled to scheduled") for no
      // reason, so that part of the original fix still holds.
      vi.mocked(practicesApi.createPractice).mockResolvedValue(
        practice({ id: 'p_existing', status: 'scheduled', deduplicated: true }),
      )
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(toastInfo).toHaveBeenCalledWith(
        'Вы уже создавали эту практику — открываем существующую',
      )
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith({
        name: 'master-practice-detail',
        params: { id: 'p_existing' },
      })
    })

    it('A4 V6: a GENUINELY new practice (deduplicated=false/absent) still gets the normal success flow', async () => {
      // The discriminator: without deduplicated=true, status='scheduled' on
      // its own must NOT be read as "existing" -- a series root that
      // legitimately publishes straight to scheduled must still say
      // "Практика создана!" and land on the list, not the detail screen.
      vi.mocked(practicesApi.createPractice).mockResolvedValue(
        practice({ id: 'p_new', status: 'scheduled', deduplicated: false }),
      )
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(toastSuccess).toHaveBeenCalledWith('Практика создана!')
      expect(toastInfo).not.toHaveBeenCalledWith(
        'Вы уже создавали эту практику — открываем существующую',
      )
      expect(replace).toHaveBeenCalledWith({ name: 'master-practices' })
    })

    it('on success: reports it, invalidates the list cache and REPLACES the route', async () => {
      // replace(), not push() (:869) -- «назад» must return to the origin, not
      // back onto a filled form that would create a duplicate on a second submit.
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Практика создана!')
      expect(replace).toHaveBeenCalledWith({ name: 'master-practices' })
      expect(push).not.toHaveBeenCalled()
      expect(refreshMyPractices).toHaveBeenCalled()
    })

    it('a failing list refresh does NOT turn a successful create into an error (G1)', async () => {
      // :873. The refresh is fire-and-forget and swallowed on purpose: the
      // practice is already created AND published, so surfacing the refresh's
      // failure would strand the master on a form telling them it failed.
      refreshMyPractices.mockRejectedValue(new Error('network'))
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Практика создана!')
      expect(toastError).not.toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith({ name: 'master-practices' })
    })

    it('a FAILED create surfaces the real backend detail and never claims success', async () => {
      vi.mocked(practicesApi.createPractice).mockRejectedValue(
        new ApiResponseError(422, 'Дата практики в прошлом', 'past_date'),
      )
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Дата практики в прошлом')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(practicesApi.updatePractice).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.createPractice).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось создать практику')
      expect(replace).not.toHaveBeenCalled()
    })

    it('a create that succeeds but FAILS to publish leaves the master on the form', async () => {
      // The two writes share one try/catch (:810-878), so a failed publish is
      // reported with the CREATE's message -- «Не удалось создать практику» --
      // even though the POST succeeded and a draft now exists server-side. This
      // pins the behaviour as it is, and deliberately does NOT assert it is
      // right: see the NOT COVERED note at the foot of this file.
      vi.mocked(practicesApi.updatePractice).mockRejectedValue(
        new ApiResponseError(409, 'Нельзя опубликовать', 'bad_state'),
      )
      mount()
      await flush()
      await fillMinimalForm()
      // Stand in for the debounced autosave, which never fires inside a test
      // (see NOT COVERED #2) -- without seeding, the survival assertion below
      // would pass against a key that was never written, proving nothing.
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Утренняя практика' }))

      submitForm()
      await flush()

      expect(practicesApi.createPractice).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Нельзя опубликовать')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      // clearDraft() runs only AFTER a successful publish (:859-860), so the
      // draft survives -- the master's work is not thrown away on a half-failure.
      expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull()
    })

    it('does NOT create twice when the button is hit twice in flight (FP-04)', async () => {
      // :806. The guard sits BEFORE validate() on purpose: parallel clicks would
      // both pass validate() before a post-validate guard could fire, and the
      // result is two live, bookable practices for one intent.
      let resolve!: (v: PracticeResponse) => void
      vi.mocked(practicesApi.createPractice).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await nextTick()
      submitForm()
      await nextTick()

      expect(practicesApi.createPractice).toHaveBeenCalledTimes(1)

      resolve(practice({ id: 'p_new' }))
      await flush()
    })
  })

  describe('«Использовать шаблон»', () => {
    it("offers the master's own practices, newest-created first", async () => {
      // :546-548 sorts by created_at DESC because the backend list order is not
      // guaranteed (operator Q2=А).
      masterState.practices = [
        practice({ id: 'a', title: 'Старая', created_at: '2026-01-01T00:00:00Z' }),
        practice({ id: 'b', title: 'Новая', created_at: '2026-06-01T00:00:00Z' }),
      ]
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      const titles = Array.from(host?.querySelectorAll('.use-template__card-title') ?? []).map(
        (e) => e.textContent?.trim(),
      )
      expect(titles).toEqual(['Новая', 'Старая'])
    })

    it('T23-3 (ПРОМТ №565): a published series offers ONE entry, not one per generated occurrence', async () => {
      // The owner's exact report: "Свист" for three separate July dates --
      // one root (parent_practice_id=null) + two generated children sharing
      // that root's id as their own parent_practice_id. Grouped by
      // parent_practice_id ?? id (.vue), the root wins over its children.
      masterState.practices = [
        practice({
          id: 'root_1',
          title: 'Свист',
          created_at: '2026-07-01T00:00:00Z',
          scheduled_at: '2026-07-23T10:00:00Z',
        }),
        practice({
          id: 'child_1',
          title: 'Свист',
          parent_practice_id: 'root_1',
          created_at: '2026-07-01T00:00:00Z',
          scheduled_at: '2026-07-24T10:00:00Z',
        }),
        practice({
          id: 'child_2',
          title: 'Свист',
          parent_practice_id: 'root_1',
          created_at: '2026-07-01T00:00:00Z',
          scheduled_at: '2026-07-25T10:00:00Z',
        }),
        // An unrelated, genuinely separate practice must still show its own
        // entry -- the dedup groups by series, not by title/master.
        practice({ id: 'other', title: 'Другая практика', created_at: '2026-06-01T00:00:00Z' }),
      ]
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      const titles = Array.from(host?.querySelectorAll('.use-template__card-title') ?? []).map(
        (e) => e.textContent?.trim(),
      )
      expect(titles).toEqual(['Свист', 'Другая практика'])
    })

    it('T23-3: with the root not (yet) loaded, ONE child still represents the whole series (graceful fallback, not a crash or a second entry)', async () => {
      masterState.practices = [
        practice({
          id: 'child_1',
          title: 'Свист',
          parent_practice_id: 'root_1',
          created_at: '2026-07-01T00:00:00Z',
        }),
        practice({
          id: 'child_2',
          title: 'Свист',
          parent_practice_id: 'root_1',
          created_at: '2026-07-01T00:00:00Z',
        }),
      ]
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      const titles = Array.from(host?.querySelectorAll('.use-template__card-title') ?? []).map(
        (e) => e.textContent?.trim(),
      )
      expect(titles).toEqual(['Свист'])
    })

    it('a master with no practices gets a hint, not an empty box', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      expect(text()).toContain('Данных пока нет')
    })

    it('picking a template prefills the form but NEVER the date or time', async () => {
      // :572-590. A template must not schedule a practice in the past (Q1=А):
      // date/time stay empty and required, so the master must choose them afresh.
      masterState.practices = [
        practice({
          id: 'a',
          title: 'Шаблон',
          direction: 'yoga',
          style: 'hatha',
          difficulty: 'medium',
          duration_minutes: 90,
          max_participants: 8,
          description: 'Из шаблона',
          what_to_prepare: 'Плед',
          contraindications: 'Нет',
        }),
      ]
      mount()
      await flush()
      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__card')?.click()
      await flush()

      expect(inputByPlaceholder('Название')?.value).toBe('Шаблон')
      expect(selectByPlaceholder('Направление практики')?.value).toBe('yoga')
      expect(selectByPlaceholder('Вид практики')?.value).toBe('hatha')
      expect(selectByPlaceholder('Уровень сложности')?.value).toBe('medium')
      expect(selectByPlaceholder('Длительность')?.value).toBe('90')
      expect(inputByPlaceholder('Максимум мест')?.value).toBe('8')
      expect(textareaByPlaceholder('Расскажите подробее о вашей практике')?.value).toBe(
        'Из шаблона',
      )
      expect(textareaByPlaceholder('Противопоказания')?.value).toBe('Нет')
      expect(textareaByPlaceholder('Что подготовить')?.value).toBe('Плед')

      // The triggers still show their placeholders (:133, :155).
      expect(pickerTriggers()[0]?.textContent?.trim()).toBe('Дата')
      expect(pickerTriggers()[1]?.textContent?.trim()).toBe('Время')
    })

    it('an UNCAPPED template prefills an empty seats field, not «null» or 0', async () => {
      // `p.max_participants != null ? String(...) : ''` (:582). Rendering null as
      // "0" would cap an open practice the moment the master submits.
      masterState.practices = [practice({ id: 'a', max_participants: null })]
      mount()
      await flush()
      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__card')?.click()
      await flush()

      expect(inputByPlaceholder('Максимум мест')?.value).toBe('')
    })

    it('the block collapses itself after a pick', async () => {
      masterState.practices = [practice({ id: 'a' })]
      mount()
      await flush()
      host?.querySelector<HTMLElement>('.use-template__head')?.click()
      await flush()

      host?.querySelector<HTMLElement>('.use-template__card')?.click()
      await flush()

      expect(host?.querySelector('.use-template__card')).toBeNull()
      expect(host?.querySelector('.use-template__head')?.getAttribute('aria-expanded')).toBe(
        'false',
      )
    })
  })

  describe('the draft banner (B2)', () => {
    function seedDraft(value: unknown, key = DRAFT_KEY): void {
      localStorage.setItem(key, JSON.stringify(value))
    }

    it('a stored draft is offered, NOT silently auto-filled', async () => {
      // :678-693 + the template comment at :39-40. Auto-filling would put words
      // in a master's mouth: the practice they submit must be the one they meant.
      seedDraft({ title: 'Черновик', direction: 'yoga', difficulty: 'medium' })
      mount()
      await flush()

      expect(text()).toContain('Продолжить черновик?')
      expect(inputByPlaceholder('Название')?.value).toBe('')
      expect(selectByPlaceholder('Направление практики')?.value).toBe('')
    })

    it('«Восстановить» fills the form from the stored draft', async () => {
      seedDraft({ title: 'Черновик', direction: 'yoga', difficulty: 'medium' })
      mount()
      await flush()

      button('Восстановить')?.click()
      await flush()

      expect(inputByPlaceholder('Название')?.value).toBe('Черновик')
      expect(selectByPlaceholder('Направление практики')?.value).toBe('yoga')
      expect(selectByPlaceholder('Уровень сложности')?.value).toBe('medium')
      expect(text()).not.toContain('Продолжить черновик?')
    })

    it('«Начать заново» drops the draft from storage and leaves the form empty', async () => {
      seedDraft({ title: 'Черновик' })
      mount()
      await flush()

      button('Начать заново')?.click()
      await flush()

      expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
      expect(text()).not.toContain('Продолжить черновик?')
      expect(inputByPlaceholder('Название')?.value).toBe('')
    })

    it('a draft of nothing but defaults does not nag -- and is swept up', async () => {
      // isMeaningfulDraft (:603-621). A bare open of the form must not greet the
      // master with «Продолжить черновик?» next visit.
      seedDraft({ title: '   ', direction: '', is_recurring: false })
      mount()
      await flush()

      expect(text()).not.toContain('Продолжить черновик?')
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    })

    it('a malformed draft is dropped, not thrown', async () => {
      // :689-692. A JSON.parse throw during onMounted would take the whole form
      // down over a corrupted string the master cannot see or clear.
      localStorage.setItem(DRAFT_KEY, '{not json')
      mount()
      await flush()

      expect(text()).not.toContain('Продолжить черновик?')
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
      expect(button('Создать практику')).toBeDefined()
    })

    it("one master's draft is never offered to another", async () => {
      // DRAFT_KEY is scoped per user id (:597). A shared key would leak one
      // master's unfinished practice into another master's form.
      seedDraft({ title: 'Чужой черновик' }, 'velo:create-practice-draft:u2')
      mount()
      await flush()

      expect(text()).not.toContain('Продолжить черновик?')
    })

    it('a fulfilled draft is dropped on a successful create', async () => {
      // :859-860. Left behind, it would greet the master with «Продолжить
      // черновик?» on the very next create -- offering to restore the practice
      // they just published.
      seedDraft({ title: 'Черновик' })
      mount()
      await flush()
      button('Начать заново')?.click()
      await flush()
      await fillMinimalForm()
      // Prove the key is back (the autosave watch is debounced 500ms and does not
      // fire here), so its absence below is the submit's doing and not a vacuum.
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: 'Утренняя практика' }))

      submitForm()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Практика создана!')
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    })
  })

  describe('navigation', () => {
    it('back POPS to the real origin when there is history', async () => {
      // :428-431. Create opens from BOTH the dashboard CTA and Практики's «+»;
      // pushing a fixed route would send half the masters somewhere they did not
      // come from (operator 2026-06-23). NB: onBack reads window.history.state at
      // CLICK time, not during setup -- unlike AdminWithdrawalDetailView, seeding
      // it after mount is correct here.
      mount()
      await flush()
      window.history.replaceState({ back: '/master/dashboard' }, '')

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })

    it('back on a COLD deep-link pushes the list instead of dead-ending', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-practices' })
      expect(back).not.toHaveBeenCalled()
    })
  })

  describe('«Для кого практика» (P5, ПРОМТ №594)', () => {
    it('defaults to public with no group_ids when left untouched', async () => {
      mount()
      await flush()
      await fillMinimalForm()

      submitForm()
      await flush()

      expect(sentBody().audience_kind).toBe('public')
      expect(sentBody().group_ids).toEqual([])
    })

    it('«Все ученики» sends audience_kind=students', async () => {
      mount()
      await flush()
      await fillMinimalForm()

      button('Все ученики')?.click()
      await flush()
      submitForm()
      await flush()

      expect(sentBody().audience_kind).toBe('students')
      expect(sentBody().group_ids).toEqual([])
    })

    it('the group multi-select renders ONLY for «Конкретные группы»', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [
          { id: 'g1', kind: 'custom', name: 'VIP', members_count: 3 },
          { id: 'g2', kind: 'custom', name: 'Утро', members_count: 1 },
        ],
      })
      mount()
      await flush()

      expect(text()).not.toContain('VIP')

      button('Конкретные группы')?.click()
      await flush()
      expect(text()).toContain('VIP')
      expect(text()).toContain('Утро')

      button('Публичная')?.click()
      await flush()
      expect(text()).not.toContain('VIP')
    })

    it('picking a group chip sends its id in group_ids', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [{ id: 'g1', kind: 'custom', name: 'VIP', members_count: 3 }],
      })
      mount()
      await flush()
      await fillMinimalForm()

      button('Конкретные группы')?.click()
      await flush()
      const chip = Array.from(host?.querySelectorAll<HTMLElement>('.v-chip') ?? []).find((c) =>
        c.textContent?.includes('VIP'),
      )
      chip?.click()
      await flush()
      submitForm()
      await flush()

      expect(sentBody().audience_kind).toBe('groups')
      expect(sentBody().group_ids).toEqual(['g1'])
    })

    it('«Конкретные группы» with nothing picked blocks submit with a field error', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [{ id: 'g1', kind: 'custom', name: 'VIP', members_count: 3 }],
      })
      mount()
      await flush()
      await fillMinimalForm()

      button('Конкретные группы')?.click()
      await flush()
      submitForm()
      await flush()

      expect(practicesApi.createPractice).not.toHaveBeenCalled()
      expect(text()).toContain('Выберите хотя бы одну группу')
    })
  })

  // ==========================================================================
  // NOT COVERED, deliberately -- the limits of this file's seams, stated rather
  // than faked.
  //
  // 1. ANY TIME OTHER THAN 12:00. VWheel emits only from a real `scroll` event
  //    behind a 140ms debounce (VWheel.vue:78-89); happy-dom fires no scroll for
  //    el.scrollTo() and the debounce needs a macrotask no nextTick loop grants.
  //    So the TimePickerSheet's own 12:00 default is the only value reachable
  //    through the real sheet. Poking form.time instead would mock the FORM half
  //    of Pattern C, which is the one thing Step 3 forbids. The sheet->form->POST
  //    wiring IS exercised at 12:00; only the wheel's own scroll-to-value
  //    behaviour is out of reach, and that belongs to a VWheel unit test, not to
  //    this screen.
  //
  // 2. THE DEBOUNCED AUTOSAVE WATCH (:631-658). scheduleSave() writes localStorage
  //    on a 500ms setTimeout. vi.setSystemTime pins Date without installing fake
  //    timers, so the timer never fires inside a test, and installing fake timers
  //    file-wide would change what every other test here is measuring. The draft
  //    tests above therefore seed localStorage directly -- the same storage
  //    boundary the screen reads -- and cover the whole READ side (offer, restore,
  //    discard, per-user scoping, malformed, cleared-on-success). The WRITE side's
  //    500ms debounce is unproven here.
  //
  // 3. THE «create succeeded, publish failed» MESSAGE. The test above pins what
  //    the screen does; it does NOT assert that what it does is right. Both writes
  //    share one try/catch (:810-878), so a failed PATCH is reported as «Не
  //    удалось создать практику» while a draft DOES exist server-side, and a
  //    master who retries makes a second one. Whether that should be a distinct
  //    message, a retry of the PATCH alone, or a rollback is a product decision,
  //    not a defect this file may invent an assertion for. Flagged, not fixed.
  // ==========================================================================
})
