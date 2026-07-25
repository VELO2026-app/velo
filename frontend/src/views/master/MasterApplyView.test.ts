// =============================================================================
// VELO Frontend -- MasterApplyView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 628 lines. THE MASTER APPLICATION -- the other end of AdminMasterReviewView
// (№482/№483/№486): what this screen submits is exactly what an admin later
// reviews. PATTERN = a THREE-STEP WIZARD over local reactive state (`step`,
// `form`, `methods`, `experienceLabel`, `langRu`/`langEn`, `uploadedCerts`) +
// ONE mutating seam (applyMaster, @/api/masters). Real Pinia: useMasterStore
// (fetchMyProfile spied, only called on the verified/self-provision path) and
// useAuthStore (user.id, read for the localStorage key -- see below). No
// watch, no store-driven list -- confirmed by reading every import and the
// whole script end to end.
//
// CHILD WITH ITS OWN SEAM, SAME EditProfileView/AdminMasterReviewView TRAP:
// MethodTaxonomyPicker fetches its OWN taxonomy catalog via getActiveTaxonomy
// (@/api/taxonomy) on its own onMounted, independent of this screen (which
// doesn't prime any catalog cache itself -- no primeMethodTaxonomyCatalog
// import here at all, unlike AdminMasterReviewView). Mocked to REJECT, same
// justification as those precedents: the picker falls back to the identical
// hardcoded taxonomy on failure, so rejection is the real offline path, not
// a shortcut. Driven via REAL chip clicks below (direction, then style),
// never by poking `methods.value` directly.
//
// CORRECTION TO THE "localStorage side effects" FRAMING -- READ, NOT ASSUMED:
// only ONE of the two keys is actually localStorage. `MASTER_APPLIED_KEY`
// (.vue:410) is written via `sessionStorage.setItem`, and its OWN doc
// comment (constants.ts:44-49) says so explicitly ("sessionStorage marker
// set on a successful master-application submit"). `masterRejectionSeenKey`
// (.vue:420) IS `localStorage.removeItem`. Both storages cleared in
// beforeEach/afterEach so no test can leak into the next (the №482 isolation
// lesson, applied to Web Storage instead of a shared fixture object).
//
// THE WRITE-ORDER FINDING-CLASS CHECK -- MEASURED, CLEAN NEGATIVE: both
// storage writes (.vue:410, .vue:420) sit STRICTLY AFTER `await
// applyMaster(...)` resolves, inside the try block's SUCCESS branches only --
// never touched in `catch`. A failed submit therefore does NOT write
// MASTER_APPLIED_KEY and does NOT touch the rejection-seen key -- asserted
// directly below (seed a stale rejection-seen key, force a rejection, assert
// BOTH storages are exactly as they were before the click). This is the
// "UI lies about saved state" class fixed twice earlier this session
// (elsewhere) -- here it was already correct.
//
// TWO ENTIRELY DIFFERENT SUCCESS OUTCOMES, gated on `res.status`:
//   'verified' (self-provision -- an admin who switched into master mode):
//     masterStore.fetchMyProfile(true), toast "Профиль создан", push
//     master-dashboard. NEITHER storage key is touched on this path at all.
//   anything else (normal application, stays role='user'): sessionStorage
//     MASTER_APPLIED_KEY='1', localStorage rejection-seen key removed (only
//     `if (authStore.user?.id)`), toast "Заявка отправлена!", push
//     master-pending.
// Both covered below as genuinely different branches, not variations of one.
//
// THE submitting GUARD -- MEASURED, NOT ASSUMED (unlike the last three
// screens in this zone, where "guarded by X" turned out wrong twice): `submit`
// (.vue:370-371) DOES have `if (submitting.value) return` as its literal
// FIRST line, ahead of even the docsConsent validation -- confirmed by
// reading, with the screen's OWN comment (.vue:359-360, "FP-04: double-submit
// guard must come before validation -- parallel clicks both pass the consent
// check before the guard fires") explicitly naming this exact class of bug.
// Because the guard is a plain synchronous ref check inside the handler
// (not a template `:disabled` binding), it blocks a SAME-TICK double click
// correctly -- proven below, not assumed: the async function body runs
// synchronously up to its first `await`, so click #1 sets `submitting.value
// = true` before click #2's synchronous handler call even starts. CLEAN
// NEGATIVE -- the one screen this batch that got it right from the start.
// The guard is also SHARED across «Отправить» and «Пропустить» (both call
// the same `submit()`), asserted below with a cross-button same-tick click.
//
// onBack (.vue:315-321) PRESERVES DATA -- READ, NOT ASSUMED: it only ever
// decrements `step.value` (or calls `router.back()` at step 1) -- it never
// resets `form`, `methods`, `experienceLabel`, or any other field. Asserted
// directly: fill step 1, advance, go back, confirm the field still shows
// what was typed.
//
// VALIDATION ORDER (both steps re-validate and reset their OWN error fields
// at the top of each call, so re-clicking after a partial fix shows the NEXT
// failing rule, not a stale one): step 1 checks display_name BEFORE privacy
// (.vue:327,331); step 2 checks methods BEFORE experience_years BEFORE bio
// (.vue:343,347,351). Each asserted as its own rule, and the "both invalid"
// case asserted to show only the FIRST rule's error (early return).
//
// skipDocuments (.vue:370,374): the ONLY difference from a normal submit is
// whether `form.docsConsent` is enforced -- the assembled payload
// (`documents: []`, `certifications: []` always, since there is no file
// storage yet) is IDENTICAL either way. Asserted directly: same payload
// shape reaches applyMaster via both buttons.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import MasterApplyView from '@/views/master/MasterApplyView.vue'
import * as mastersApi from '@/api/masters'
import * as taxonomyApi from '@/api/taxonomy'
import { ApiResponseError } from '@/api/client'
import { useMasterStore } from '@/stores/master'
import { useAuthStore } from '@/stores/auth'
import { MASTER_APPLIED_KEY, masterRejectionSeenKey } from '@/utils/constants'
import type { MasterApplyResponse, UserResponse } from '@/api/types'

vi.mock('@/api/masters')
vi.mock('@/api/taxonomy')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: toastInfo }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function applyResponse(overrides: Partial<MasterApplyResponse> = {}): MasterApplyResponse {
  return {
    user_id: 'user_1',
    status: 'pending',
    created_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Анна',
    last_name: 'Иванова',
    avatar_url: null,
    timezone: 'Europe/Moscow',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: false,
    phone: null,
    bio: null,
    email: null,
    notifications: {
      push: true,
      practice_reminders: true,
      master_messages: true,
      support_messages: true,
    },
    master_notifications: null,
    role_switch: null,
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
  app = createApp(MasterApplyView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

function inputWrapByLabel(label: string): HTMLElement {
  const wrap = Array.from(host?.querySelectorAll<HTMLElement>('.v-input') ?? []).find(
    (w) => w.querySelector('.v-input__float-label')?.textContent?.trim() === label,
  )
  if (!wrap) throw new Error(`no input labelled «${label}»`)
  return wrap
}
function inputByLabel(label: string): HTMLInputElement {
  const el = inputWrapByLabel(label).querySelector<HTMLInputElement>('.v-input__field')
  if (!el) throw new Error(`no <input> under «${label}»`)
  return el
}
function inputErrorText(label: string): string {
  return inputWrapByLabel(label).querySelector('.v-input__error')?.textContent?.trim() ?? ''
}

function bioField(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!el) throw new Error('bio textarea not rendered')
  return el
}
function bioErrorText(): string {
  return host?.querySelector('.v-textarea__error')?.textContent?.trim() ?? ''
}

function selectField(): HTMLSelectElement {
  const el = host?.querySelector<HTMLSelectElement>('select.v-select__field')
  if (!el) throw new Error('experience select not rendered')
  return el
}
function chooseExperience(value: string): void {
  const el = selectField()
  el.value = value
  el.dispatchEvent(new Event('change'))
}
function selectErrorText(): string {
  return host?.querySelector('.v-select__error')?.textContent?.trim() ?? ''
}

function checkboxByLabel(labelSubstr: string): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-checkbox') ?? []).find(
    (c) => c.querySelector('.v-checkbox__label')?.textContent?.includes(labelSubstr),
  )
  if (!btn) throw new Error(`no checkbox with label containing «${labelSubstr}»`)
  return btn
}

function chipByText(t: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-chip') ?? []).find(
    (c) => c.textContent?.trim() === t,
  )
}

function fieldErrorText(substr: string): string | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.apply-view__field-error') ?? [])
    .map((e) => e.textContent?.trim())
    .find((t) => t?.includes(substr))
}

function buttonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function nextBtn(): HTMLButtonElement {
  const b = buttonByText('Далее')
  if (!b) throw new Error('«Далее» did not render')
  return b
}
function submitBtn(): HTMLButtonElement {
  const b = buttonByText('Отправить')
  if (!b) throw new Error('«Отправить» did not render')
  return b
}
function skipBtn(): HTMLButtonElement {
  const b = buttonByText('Пропустить')
  if (!b) throw new Error('«Пропустить» did not render')
  return b
}
function headerBackBtn(): HTMLButtonElement {
  const b = host?.querySelector<HTMLButtonElement>('.v-back')
  if (!b) throw new Error('header back button did not render')
  return b
}
function uploadButtonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.apply-view__upload') ?? []).find(
    (b) => b.querySelector('.apply-view__upload-text')?.textContent?.trim() === t,
  )
}
function stepTitle(): string {
  return host?.querySelector('.apply-view__step-title')?.textContent?.trim() ?? ''
}

/** Drives step 1 through the real DOM (name + privacy) and advances. */
async function fillStep1(name = 'Анна Иванова'): Promise<void> {
  setValue(inputByLabel('Имя'), name)
  await flush()
  checkboxByLabel('Условия использования').click()
  await flush()
  nextBtn().click()
  await flush()
}

/** Drives step 2 through the real DOM (a method chip pair, experience, bio) and advances. */
async function fillStep2(): Promise<void> {
  chipByText('Медитация')?.click()
  await flush()
  chipByText('Медитация молчания')?.click()
  await flush()
  chooseExperience('2') // "1-3 года"
  await flush()
  setValue(bioField(), 'Практикую 5 лет, веду группы для начинающих.')
  await flush()
  nextBtn().click()
  await flush()
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(mastersApi.applyMaster).mockReset().mockResolvedValue(applyResponse())
  vi.mocked(taxonomyApi.getActiveTaxonomy).mockReset().mockRejectedValue(new Error('offline'))

  useAuthStore().user = user()
  vi.spyOn(useMasterStore(), 'fetchMyProfile').mockResolvedValue(undefined)

  sessionStorage.clear()
  localStorage.clear()

  back.mockReset()
  push.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('MasterApplyView', () => {
  // ===========================================================================
  describe('step 1 validation (goToStep2, .vue:324-336)', () => {
    it('empty display_name blocks advance, shows its own error', async () => {
      mount()
      await flush()

      nextBtn().click()
      await flush()

      expect(inputErrorText('Имя')).toBe('Пожалуйста, введите имя')
      expect(stepTitle()).toBe('Шаг 1: Профиль')
    })

    it('whitespace-only display_name is ALSO rejected (trim check)', async () => {
      mount()
      await flush()

      setValue(inputByLabel('Имя'), '   ')
      await flush()
      nextBtn().click()
      await flush()

      expect(inputErrorText('Имя')).toBe('Пожалуйста, введите имя')
    })

    it('display_name filled but privacy NOT accepted: blocks with the privacy error', async () => {
      mount()
      await flush()

      setValue(inputByLabel('Имя'), 'Анна Иванова')
      await flush()
      nextBtn().click()
      await flush()

      expect(fieldErrorText('Необходимо принять условия')).toBeDefined()
      expect(stepTitle()).toBe('Шаг 1: Профиль')
    })

    it('VALIDATION ORDER: both invalid at once shows ONLY the display_name error (early return)', async () => {
      mount()
      await flush()

      nextBtn().click() // empty name AND unchecked privacy
      await flush()

      expect(inputErrorText('Имя')).toBe('Пожалуйста, введите имя')
      expect(fieldErrorText('Необходимо принять условия')).toBeUndefined()
    })

    it('re-clicking after fixing the name surfaces the NEXT rule (privacy), not a stale name error', async () => {
      mount()
      await flush()

      nextBtn().click()
      await flush()
      expect(inputErrorText('Имя')).toBe('Пожалуйста, введите имя')

      setValue(inputByLabel('Имя'), 'Анна Иванова')
      await flush()
      nextBtn().click()
      await flush()

      expect(inputErrorText('Имя')).toBe('') // cleared
      expect(fieldErrorText('Необходимо принять условия')).toBeDefined()
    })

    it('valid step 1 advances to step 2', async () => {
      mount()
      await flush()

      await fillStep1()

      expect(stepTitle()).toBe('Шаг 2: Опыт')
    })
  })

  // ===========================================================================
  describe('step 2 validation (goToStep3, .vue:339-356)', () => {
    it('no methods selected: blocks with its own error', async () => {
      mount()
      await flush()
      await fillStep1()

      nextBtn().click()
      await flush()

      expect(fieldErrorText('Выберите хотя бы одно направление')).toBeDefined()
      expect(stepTitle()).toBe('Шаг 2: Опыт')
    })

    it('methods chosen but no experience: blocks with the experience error', async () => {
      mount()
      await flush()
      await fillStep1()

      chipByText('Медитация')?.click()
      await flush()
      chipByText('Медитация молчания')?.click()
      await flush()
      nextBtn().click()
      await flush()

      expect(selectErrorText()).toBe('Выберите опыт преподавания')
    })

    it('methods + experience but empty bio: blocks with the bio error (trim check too)', async () => {
      mount()
      await flush()
      await fillStep1()

      chipByText('Медитация')?.click()
      await flush()
      chipByText('Медитация молчания')?.click()
      await flush()
      chooseExperience('2')
      await flush()
      setValue(bioField(), '   ')
      await flush()
      nextBtn().click()
      await flush()

      expect(bioErrorText()).toBe('Пожалуйста, расскажите о себе')
    })

    it('valid step 2 advances to step 3', async () => {
      mount()
      await flush()
      await fillStep1()
      await fillStep2()

      expect(stepTitle()).toBe('Шаг 3: Документы')
    })
  })

  // ===========================================================================
  describe('onBack (.vue:315-321) -- preserves data (measured, not assumed)', () => {
    it('going back from step 2 to step 1 keeps the already-entered name', async () => {
      mount()
      await flush()
      await fillStep1('Борис Кузнецов')
      expect(stepTitle()).toBe('Шаг 2: Опыт')

      headerBackBtn().click()
      await flush()

      expect(stepTitle()).toBe('Шаг 1: Профиль')
      expect(inputByLabel('Имя').value).toBe('Борис Кузнецов')
    })

    it('at step 1, back calls router.back() instead of decrementing (there is no step 0)', async () => {
      mount()
      await flush()

      headerBackBtn().click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(stepTitle()).toBe('Шаг 1: Профиль')
    })

    it('going back from step 3 to step 2 keeps the already-selected method chip active', async () => {
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      expect(stepTitle()).toBe('Шаг 3: Документы')

      headerBackBtn().click()
      await flush()

      expect(stepTitle()).toBe('Шаг 2: Опыт')
      expect(chipByText('Медитация')?.getAttribute('aria-pressed')).not.toBe('false')
      expect(bioField().value).toBe('Практикую 5 лет, веду группы для начинающих.') // bio also preserved
    })
  })

  // ===========================================================================
  // ПРОМТ №565 (T23-2): .apply-view__content (.vue:40) is ONE persistent
  // scrolling container reused across all 3 steps -- the v-if/v-else-if chain
  // only swaps its CHILDREN. A watch(step, ...) (.vue:249-256) resets its
  // scrollTop to 0 on every transition. happy-dom has no real layout/overflow
  // engine -- .scrollTop here is a plain writable numeric property, not a
  // simulation of an actual scrollable viewport, so this proves the WATCHER
  // fires on every direction, not that a real browser visually scrolls to
  // the top (that half is unverifiable by this harness -- see the report).
  describe('scroll reset on step transition (ПРОМТ №565, T23-2)', () => {
    function contentEl(): HTMLElement {
      const el = host?.querySelector<HTMLElement>('.apply-view__content')
      if (!el) throw new Error('.apply-view__content did not render')
      return el
    }

    it('1 -> 2 (goToStep2): scrollTop resets to 0', async () => {
      mount()
      await flush()
      contentEl().scrollTop = 240

      await fillStep1()

      expect(stepTitle()).toBe('Шаг 2: Опыт')
      expect(contentEl().scrollTop).toBe(0)
    })

    it('2 -> 3 (goToStep3, the reported case): scrollTop resets to 0', async () => {
      mount()
      await flush()
      await fillStep1()
      contentEl().scrollTop = 180

      await fillStep2()

      expect(stepTitle()).toBe('Шаг 3: Документы')
      expect(contentEl().scrollTop).toBe(0)
    })

    it('2 -> 1 (onBack): scrollTop resets to 0', async () => {
      mount()
      await flush()
      await fillStep1()
      contentEl().scrollTop = 150

      headerBackBtn().click()
      await flush()

      expect(stepTitle()).toBe('Шаг 1: Профиль')
      expect(contentEl().scrollTop).toBe(0)
    })

    it('3 -> 2 (onBack): scrollTop resets to 0', async () => {
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      contentEl().scrollTop = 300

      headerBackBtn().click()
      await flush()

      expect(stepTitle()).toBe('Шаг 2: Опыт')
      expect(contentEl().scrollTop).toBe(0)
    })
  })

  // ===========================================================================
  describe('submit payload shape (.vue:381-395)', () => {
    it('assembles the exact payload: methods, default language (Русский only), mapped experience_years, trimmed bio, empty certifications/documents', async () => {
      mount()
      await flush()
      await fillStep1('Анна Иванова')
      await fillStep2()

      checkboxByLabel('обработку загруженных документов').click()
      await flush()
      submitBtn().click()
      await flush()

      expect(mastersApi.applyMaster).toHaveBeenCalledWith({
        profile: { display_name: 'Анна Иванова', email: null, phone: null },
        experience: {
          methods: ['Медитация — Медитация молчания'],
          languages: ['Русский'],
          experience_years: 2,
          bio: 'Практикую 5 лет, веду группы для начинающих.',
          certifications: [],
        },
        documents: [],
      })
    })

    it('email/phone are trimmed and sent when filled', async () => {
      mount()
      await flush()
      setValue(inputByLabel('Имя'), 'Анна Иванова')
      await flush()
      setValue(inputByLabel('E-mail'), '  anna@example.com  ')
      await flush()
      setValue(inputByLabel('Телефон'), '  +79991234567  ')
      await flush()
      checkboxByLabel('Условия использования').click()
      await flush()
      nextBtn().click()
      await flush()
      await fillStep2()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()
      submitBtn().click()
      await flush()

      const call = vi.mocked(mastersApi.applyMaster).mock.calls[0]![0]
      expect(call.profile.email).toBe('anna@example.com')
      expect(call.profile.phone).toBe('+79991234567')
    })

    it('toggling English ON alongside the default Русский sends BOTH languages', async () => {
      mount()
      await flush()
      await fillStep1()
      chipByText('Медитация')?.click()
      await flush()
      chipByText('Медитация молчания')?.click()
      await flush()
      chooseExperience('2')
      await flush()
      setValue(bioField(), 'Бэкграунд.')
      await flush()
      checkboxByLabel('English').click()
      await flush()
      nextBtn().click()
      await flush()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()
      submitBtn().click()
      await flush()

      const call = vi.mocked(mastersApi.applyMaster).mock.calls[0]![0]
      expect(call.experience.languages).toEqual(['Русский', 'English'])
    })

    it('unchecking the default Русский (both off) sends an EMPTY languages list -- an edge case, not a validation rule', async () => {
      mount()
      await flush()
      await fillStep1()
      chipByText('Медитация')?.click()
      await flush()
      chipByText('Медитация молчания')?.click()
      await flush()
      chooseExperience('2')
      await flush()
      setValue(bioField(), 'Бэкграунд.')
      await flush()
      checkboxByLabel('Русский').click() // turn OFF the default
      await flush()
      nextBtn().click()
      await flush()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()
      submitBtn().click()
      await flush()

      const call = vi.mocked(mastersApi.applyMaster).mock.calls[0]![0]
      expect(call.experience.languages).toEqual([])
    })

    it('a different EXPERIENCE_OPTIONS pick maps to its own integer, proving the mapping is read per-option, not hardcoded', async () => {
      mount()
      await flush()
      await fillStep1()
      chipByText('Медитация')?.click()
      await flush()
      chipByText('Медитация молчания')?.click()
      await flush()
      chooseExperience('7') // "5-10 лет"
      await flush()
      setValue(bioField(), 'Бэкграунд.')
      await flush()
      nextBtn().click()
      await flush()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()
      submitBtn().click()
      await flush()

      const call = vi.mocked(mastersApi.applyMaster).mock.calls[0]![0]
      expect(call.experience.experience_years).toBe(7)
    })
  })

  // ===========================================================================
  describe('skipDocuments (.vue:370,374, «Пропустить») -- payload identical, only the consent gate differs', () => {
    it('normal submit WITHOUT docsConsent checked: blocked, no api call', async () => {
      mount()
      await flush()
      await fillStep1()
      await fillStep2()

      submitBtn().click()
      await flush()

      expect(fieldErrorText('Необходимо дать согласие')).toBeDefined()
      expect(mastersApi.applyMaster).not.toHaveBeenCalled()
    })

    it('«Пропустить» bypasses the docsConsent gate entirely -- same payload shape as a normal submit', async () => {
      mount()
      await flush()
      await fillStep1()
      await fillStep2()

      skipBtn().click() // docsConsent still false
      await flush()

      expect(mastersApi.applyMaster).toHaveBeenCalledWith(
        expect.objectContaining({ documents: [] }),
      )
      expect(mastersApi.applyMaster).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================================================
  describe('submit success -- TWO different outcomes by res.status (see banner)', () => {
    it('normal application (status="pending"): sessionStorage MASTER_APPLIED_KEY set, stale rejection-seen key removed, toast + push to master-pending', async () => {
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1')
      vi.mocked(mastersApi.applyMaster).mockResolvedValue(applyResponse({ status: 'pending' }))
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      skipBtn().click()
      await flush()

      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBe('1')
      expect(localStorage.getItem(masterRejectionSeenKey('user_1'))).toBeNull()
      expect(toastSuccess).toHaveBeenCalledWith('Заявка отправлена!')
      expect(push).toHaveBeenCalledWith({ name: 'master-pending' })
      expect(useMasterStore().fetchMyProfile).not.toHaveBeenCalled()
    })

    it('self-provision (status="verified"): fetchMyProfile(true), toast + push to master-dashboard, NEITHER storage key touched', async () => {
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1') // pre-existing, must survive
      vi.mocked(mastersApi.applyMaster).mockResolvedValue(applyResponse({ status: 'verified' }))
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      skipBtn().click()
      await flush()

      expect(useMasterStore().fetchMyProfile).toHaveBeenCalledWith(true)
      expect(toastSuccess).toHaveBeenCalledWith('Профиль создан')
      expect(push).toHaveBeenCalledWith({ name: 'master-dashboard' })
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBeNull()
      expect(localStorage.getItem(masterRejectionSeenKey('user_1'))).toBe('1') // untouched
    })

    it('authStore.user = null: the normal-path storage write for MASTER_APPLIED_KEY still happens; the localStorage removal is safely skipped (no crash)', async () => {
      useAuthStore().user = null
      vi.mocked(mastersApi.applyMaster).mockResolvedValue(applyResponse({ status: 'pending' }))
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      skipBtn().click()
      await flush()

      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBe('1')
      expect(push).toHaveBeenCalledWith({ name: 'master-pending' })
    })
  })

  // ===========================================================================
  describe('submit failure -- the write-order finding-class check (see banner)', () => {
    it('failure (generic Error): fallback toast, NEITHER storage write happens, no navigation -- the user is NOT left believing they applied', async () => {
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1')
      vi.mocked(mastersApi.applyMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      skipBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отправить заявку')
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBeNull()
      expect(localStorage.getItem(masterRejectionSeenKey('user_1'))).toBe('1') // untouched, not removed
      expect(push).not.toHaveBeenCalled()
      expect(stepTitle()).toBe('Шаг 3: Документы') // still here, not navigated away
    })

    it('failure (ApiResponseError): toasts the real backend detail', async () => {
      vi.mocked(mastersApi.applyMaster).mockRejectedValue(
        new ApiResponseError(409, 'Заявка уже подана', 'already_applied'),
      )
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      skipBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Заявка уже подана')
    })
  })

  // ===========================================================================
  describe('the submitting guard (.vue:371) -- handler-level, confirmed present (see banner)', () => {
    it('a same-tick double click on «Отправить» reaches applyMaster ONCE', async () => {
      let resolveApply!: (v: MasterApplyResponse) => void
      vi.mocked(mastersApi.applyMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApply = resolve
          }),
      )
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()

      const btn = submitBtn()
      btn.click()
      btn.click() // no await -- synchronous guard, not a DOM :disabled race
      await flush()

      expect(mastersApi.applyMaster).toHaveBeenCalledTimes(1)
      resolveApply(applyResponse())
      await flush()
    })

    it('CROSS-BUTTON: clicking «Отправить» then «Пропустить» in the same tick still reaches applyMaster ONCE -- the guard is shared', async () => {
      let resolveApply!: (v: MasterApplyResponse) => void
      vi.mocked(mastersApi.applyMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApply = resolve
          }),
      )
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()

      submitBtn().click()
      skipBtn().click() // no await -- same tick, different button, SAME submit()
      await flush()

      expect(mastersApi.applyMaster).toHaveBeenCalledTimes(1)
      resolveApply(applyResponse())
      await flush()
    })

    it('REALISTIC interaction: once :loading has painted, a second real click on the disabled button is a no-op', async () => {
      let resolveApply!: (v: MasterApplyResponse) => void
      vi.mocked(mastersApi.applyMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApply = resolve
          }),
      )
      mount()
      await flush()
      await fillStep1()
      await fillStep2()
      checkboxByLabel('обработку загруженных документов').click()
      await flush()

      submitBtn().click()
      await flush() // let :loading="submitting" paint
      expect(submitBtn().disabled).toBe(true)
      submitBtn().click()

      expect(mastersApi.applyMaster).toHaveBeenCalledTimes(1)
      resolveApply(applyResponse())
      await flush()
    })
  })

  // ===========================================================================
  describe('onUpload (.vue:310-312) -- an honest stub, shared by all three upload buttons', () => {
    it('clicking the passport upload toasts the stub; uploadedCerts stays empty, no api call', async () => {
      mount()
      await flush()
      await fillStep1()
      await fillStep2()

      uploadButtonByText('Загрузить документ')?.click()
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Загрузка файлов пока недоступна')
      expect(host?.querySelectorAll('.apply-view__filechip')).toHaveLength(0)
      expect(mastersApi.applyMaster).not.toHaveBeenCalled()
    })
  })
})
