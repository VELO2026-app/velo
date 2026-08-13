// =============================================================================
// VELO Frontend -- EditProfileView Screen Tests (probekit-screen-test v1.9)
// =============================================================================
//
// 663 lines, largest untested user screen, ranked by value not size: 5 stores
// worth of data, a real edit ladder, and a balance DISPLAYED in the
// delete-account modal.
//
// PATTERN C (hybrid + local FORM), and genuinely three layers this time, not
// two -- classified by reading every import, not guessing:
//   - STORE HALF: authStore.user (.vue:234, real useAuthStore) and
//     masterStore.profile (.vue:232,247,256, real useMasterStore, master
//     role only). Both real stores; their API seams (@/api/users' updateMe,
//     @/api/masters' getMyMasterProfile) are mocked.
//   - DIRECT-CALL HALF: submitMethodChangeRequest / updateMasterLanguages
//     (.vue:218,290,336) called straight from the screen, bypassing any
//     store action -- a THIRD seam, @/api/masters again (same module as
//     getMyMasterProfile, so one vi.mock covers all three, but they are
//     driven and asserted as the three independent behaviours they are).
//   - LOCAL-FORM HALF: `form` (reactive: firstName/lastName/bio/email,
//     .vue:371-376), `selectedMethods`/`selectedLanguages` (refs seeded by a
//     `watch(..., {immediate:true})` off the store data, .vue:265-272,
//     307-314), and the whole delete-modal state (showDeleteModal/
//     delConsent/delConfirmText). Driven by real DOM interaction (type into
//     the input, click the chip, click the checkbox), never by reaching into
//     the refs directly -- mocking this half instead of driving it through
//     the DOM would assert the test's own fixture, not the screen (skill's
//     Pattern C warning).
//   A FOURTH module needs mocking for a reason neither the operator's recon
//   nor the light recon named: the real (unstubbed, per velo-idiom §2) child
//   MethodTaxonomyPicker fetches its OWN taxonomy catalog on mount
//   (MethodTaxonomyPicker.vue:117,181, @/api/taxonomy's getActiveTaxonomy) --
//   completely independent of this screen's own primeMethodTaxonomyCatalog()
//   call (.vue:357), which hits the SAME function. Mocked to REJECT rather
//   than given a matching catalog fixture: both call sites already fall back
//   to the identical hardcoded DIRECTION_OPTIONS/STYLE_OPTIONS_BY_DIRECTION
//   on a failed fetch (methodTaxonomy.ts's own header comment: "the catalog's
//   seed is byte-identical to those consts, so this is safe today"), so a
//   rejection is the SAME real code path in production (offline) and removes
//   any risk of a hand-built catalog fixture silently drifting from the
//   hardcoded list the picker's chips actually render by label.
//
// A REAL FINDING, not fixed here (see the report): the file's own header
// comment (.vue:13-14,19,28) documents a Phone field with detailed
// validation rules -- and NOTHING in the template, the `form` reactive
// object, or onSave's body-building references phone at all. Grepped
// case-insensitively: every "phone" in this file is inside a comment. Either
// a real product gap (backend UserResponse/UserUpdate both carry `phone`,
// checked in api/generated.ts) or intentionally removed and never
// documented as such -- flagged, not touched (out of scope for a test task).
//
// MONEY (NBSP, velo-idiom §11): formattedBalance (.vue:459) is the ONLY
// money on this screen, shown in the delete modal when a master has a
// forfeitable balance. Asserted through norm() with the ESCAPES from the
// skill ( / / ), and the fixture/expected string were typed
// directly into this file via the Write tool -- never through a shell
// heredoc, which eats the NBSP before the test ever sees it (the trap has
// already bitten four agents per the skill's own history).
//
// THE DELETE IS A STUB (operator rule, .vue:448-451,498-501): the real
// delete-forever + forfeit-balance endpoint does not exist yet.
// onConfirmDelete only toasts; it calls no API, pushes no route. Every delete
// test below asserts exactly that -- the stub toast fires and NOTHING else
// does -- so the day Zod ships the real endpoint and this screen is wired to
// it, these tests turn red as the changelog, per the operator's instruction.
//
// TELEPORTED MODAL (SC-13, the expensive one): VModal wraps its overlay in a
// Transition (VModal.vue:20-21), teleported to document.body. A closed
// overlay survives app.unmount() (Vue awaits a transitionend happy-dom never
// fires) and would poison the NEXT test's document.body.querySelector. The
// afterEach purge below is NOT the defensive-precedent copy this repo's other
// dashboard tests carry "just in case" -- this screen genuinely opens
// VModal, so it is load-bearing. Queried via document.body, never host
// (SC-07) -- host.querySelector would silently find nothing and read as
// "modal didn't open".
//
// v-if throughout (grepped this file, MethodTaxonomyPicker.vue, VModal.vue,
// VCheckbox.vue): zero v-show, so SC-14 does not apply.
//
// TRAP SURFACES CHECKED: window.location / navigator.clipboard /
// history.state / IntersectionObserver / ResizeObserver -- grepped, zero
// hits, none of those seams needed. scrollIntoView (used by
// revealConfirmField, .vue:478, and useKeyboardFieldScroll's onFieldFocus)
// is present in this repo's happy-dom as a real no-op function (probed
// directly: typeof === 'function', calling it does not throw) -- no stub
// needed, and onFieldFocus is never triggered here (no test focuses a
// field), so its window.visualViewport / setTimeout path never runs.
//
// No order dependence: every test mounts its own app + fresh Pinia.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import EditProfileView from '@/views/user/EditProfileView.vue'
import * as mastersApi from '@/api/masters'
import * as usersApi from '@/api/users'
import * as taxonomyApi from '@/api/taxonomy'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import type { MasterProfileResponse, MethodChangeRequest, UserResponse } from '@/api/types'

vi.mock('@/api/masters')
vi.mock('@/api/users')
// Rejected -- both this screen's primeMethodTaxonomyCatalog() and the child
// MethodTaxonomyPicker's own fetch fall back to the SAME hardcoded taxonomy
// on failure (see banner). Real offline code path, not a shortcut.
vi.mock('@/api/taxonomy')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Аня',
    last_name: 'Иванова',
    avatar_url: null,
    timezone: 'UTC',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: false,
    phone: null,
    bio: 'Люблю практики',
    email: 'anya@example.com',
    master_notifications: null,
    role_switch: null,
    ...overrides,
  }
}

function methodChangeRequest(overrides: Partial<MethodChangeRequest> = {}): MethodChangeRequest {
  return {
    status: 'pending',
    proposed_methods: ['Медитация', 'Йога'],
    submitted_at: '2026-07-01T00:00:00Z',
    decided_at: null,
    decided_by: null,
    reject_reason: null,
    ...overrides,
  }
}

function masterProfile(overrides: Partial<MasterProfileResponse> = {}): MasterProfileResponse {
  return {
    user_id: 'user_1',
    status: 'verified',
    display_name: 'Аня',
    bio: null,
    methods: ['Медитация'],
    languages: ['Русский'],
    experience_years: 3,
    frozen_cents: 0,
    available_cents: 0,
    min_withdrawal_cents: 1000,
    withdrawal_fee_cents: 0,
    payout: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    rejection_reason: null,
    method_change_request: null,
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
  app = createApp(EditProfileView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3). For a master, onMounted fires
// Promise.all([fetchMyProfile(), primeMethodTaxonomyCatalog()]) (2 parallel
// chains, ~2 deep each) AND the child MethodTaxonomyPicker mounts its OWN
// getActiveTaxonomy() fetch independently (another ~2). None awaited by the
// caller. Generous, matching MasterDashboardView's precedent for a similarly
// multi-seam screen (10) -- over-counting is harmless, under fails loudly.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[   ]/g, ' ')
}
function text(): string {
  return norm(host?.textContent)
}

function inputByLabel(label: string): HTMLInputElement {
  const wrap = Array.from(host?.querySelectorAll<HTMLElement>('.v-input') ?? []).find(
    (w) => w.querySelector('.v-input__label')?.textContent?.trim() === label,
  )
  const el = wrap?.querySelector<HTMLInputElement>('input')
  if (!el) throw new Error(`no VInput labelled «${label}»`)
  return el
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function bioField(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!el) throw new Error('bio textarea did not render')
  return el
}
function bioErrorText(): string {
  return norm(host?.querySelector('.v-textarea__error')?.textContent).trim()
}
function emailErrorText(): string {
  return norm(host?.querySelector('.edit-profile__field-error')?.textContent).trim()
}
function buttonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function saveBtn(): HTMLButtonElement {
  const b = buttonByText('Сохранить')
  if (!b) throw new Error('Save button did not render')
  return b
}
function deleteOpenBtn(): HTMLButtonElement {
  const b = host?.querySelector<HTMLButtonElement>('.edit-profile__delete')
  if (!b) throw new Error('Delete-account button did not render')
  return b
}

// Modal is teleported to document.body (SC-07) -- never query `host` for it.
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
// SC-13b: a closed VModal is NOT removed -- Vue parks it at
// `v-modal-leave-active` awaiting a transitionend happy-dom never fires, so
// `modalOverlay()` keeps finding it after close. `toBeNull()` on it never
// passes; this is the honest "did it close" check instead.
function modalIsOpen(): boolean {
  const el = modalOverlay()
  return !!el && !el.classList.contains('v-modal-leave-active')
}
function modalText(): string {
  return norm(modalOverlay()?.textContent)
}
function modalButtonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(modalOverlay()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function consentCheckbox(): HTMLButtonElement | undefined {
  return modalOverlay()?.querySelector<HTMLButtonElement>('.v-checkbox') ?? undefined
}
function confirmTextInput(): HTMLInputElement | undefined {
  const wrap = modalOverlay()?.querySelector('.edit-profile__del-confirm-hint')?.parentElement
  return wrap?.querySelector<HTMLInputElement>('input') ?? undefined
}

// Methods/languages chips live in different containers -- scoped so a method
// direction named the same as nothing here never collides with a language.
function methodChip(labelText: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.mtp__chips .v-chip') ?? []).find(
    (c) => c.textContent?.trim() === labelText,
  )
}
function languageChip(labelText: string): HTMLButtonElement | undefined {
  return Array.from(
    host?.querySelectorAll<HTMLButtonElement>('.edit-profile__methods-chips .v-chip') ?? [],
  ).find((c) => c.textContent?.trim() === labelText)
}
function methodsSubmitBtn(): HTMLButtonElement | undefined {
  return buttonByText('Отправить на проверку')
}
function languagesSaveBtn(): HTMLButtonElement | undefined {
  return buttonByText('Сохранить языки')
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(usersApi.updateMe)
    .mockReset()
    .mockImplementation(async (body) => user(body as Partial<UserResponse>))
  vi.mocked(mastersApi.getMyMasterProfile).mockReset().mockResolvedValue(masterProfile())
  vi.mocked(mastersApi.submitMethodChangeRequest).mockReset().mockResolvedValue(masterProfile())
  vi.mocked(mastersApi.updateMasterLanguages).mockReset().mockResolvedValue(masterProfile())
  vi.mocked(taxonomyApi.getActiveTaxonomy)
    .mockReset()
    .mockRejectedValue(new Error('offline in test'))

  useAuthStore().user = user()

  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13 -- load-bearing here, not defensive copy-paste. See banner.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('EditProfileView', () => {
  // ===========================================================================
  describe('plain user (no master sections)', () => {
    it('does not render the methods or languages blocks', async () => {
      mount()
      await flush()

      expect(text()).not.toContain('Методы')
      expect(text()).not.toContain('Языки практик')
      expect(mastersApi.getMyMasterProfile).not.toHaveBeenCalled()
    })

    it('the delete modal has no balance section (masterStore.profile is null)', async () => {
      mount()
      await flush()

      deleteOpenBtn().click()
      await flush()

      expect(modalText()).not.toContain('На вашем балансе')
      // No balance -> the confirm field is visible immediately (showConfirmField
      // = !hasBalance), not gated behind a consent checkbox.
      expect(consentCheckbox()).toBeUndefined()
      expect(confirmTextInput()).toBeDefined()
    })
  })

  // ===========================================================================
  describe('profile fields: prefilled from the real user, saved as a partial diff', () => {
    it('prefills Имя/Фамилия/E-mail/О себе from authStore.user', async () => {
      mount()
      await flush()

      expect(inputByLabel('Имя').value).toBe('Аня')
      expect(inputByLabel('Фамилия').value).toBe('Иванова')
      expect(inputByLabel('E-mail').value).toBe('anya@example.com')
      expect(bioField().value).toBe('Люблю практики')
    })

    it('no changes: toasts "Нет изменений" and calls no API', async () => {
      mount()
      await flush()

      saveBtn().click()
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Нет изменений')
      expect(usersApi.updateMe).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
    })

    it('changing ONE field sends a body with ONLY that field, and navigates back on success', async () => {
      mount()
      await flush()

      setValue(inputByLabel('Имя'), 'Мария')
      await flush()
      saveBtn().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({ first_name: 'Мария' })
      expect(toastInfo).toHaveBeenCalledWith('Профиль сохранён')
      expect(back).toHaveBeenCalledTimes(1)
    })

    it('changing bio to empty sends an empty string (clears it), not omitted', async () => {
      mount()
      await flush()

      setValue(bioField(), '')
      await flush()
      saveBtn().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({ bio: '' })
    })

    it('a trimmed-empty first name is NOT sent (backend rejects empty via min_length)', async () => {
      mount()
      await flush()

      setValue(inputByLabel('Имя'), '   ')
      await flush()
      saveBtn().click()
      await flush()

      // first_name never enters the body; last_name/bio/email are unchanged
      // too, so this is the "no changes" path.
      expect(usersApi.updateMe).not.toHaveBeenCalled()
      expect(toastInfo).toHaveBeenCalledWith('Нет изменений')
    })

    it('save error: ApiResponseError surfaces the REAL backend detail, does not navigate', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(
        new ApiResponseError(422, 'Имя слишком длинное', 'validation_error'),
      )
      mount()
      await flush()

      setValue(inputByLabel('Имя'), 'Мария')
      await flush()
      saveBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Имя слишком длинное')
      expect(back).not.toHaveBeenCalled()
    })

    it('save error: a non-ApiResponseError toasts the fallback, not a raw exception (SC-05)', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      setValue(inputByLabel('Имя'), 'Мария')
      await flush()
      saveBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить профиль')
      expect(back).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('email validation', () => {
    it('an invalid email blocks Save with a toast and an inline message; valid clears it', async () => {
      mount()
      await flush()

      setValue(inputByLabel('E-mail'), 'not-an-email')
      await flush()

      expect(emailErrorText()).toBe('Введите корректный e-mail')

      saveBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Проверьте правильность заполнения полей')
      expect(usersApi.updateMe).not.toHaveBeenCalled()

      // Both directions -- fixing it clears the error AND unblocks save.
      setValue(inputByLabel('E-mail'), 'valid@example.com')
      await flush()
      expect(emailErrorText()).toBe('')

      toastError.mockClear()
      saveBtn().click()
      await flush()
      expect(usersApi.updateMe).toHaveBeenCalledWith({ email: 'valid@example.com' })
    })

    it('an empty email is explicitly allowed (clears the field), not an error', async () => {
      mount()
      await flush()

      setValue(inputByLabel('E-mail'), '')
      await flush()

      expect(emailErrorText()).toBe('')
    })
  })

  // ===========================================================================
  describe('bio validation', () => {
    it('over 2000 chars blocks Save with an inline error; at the boundary it does not', async () => {
      mount()
      await flush()

      setValue(bioField(), 'a'.repeat(2001))
      await flush()
      expect(bioErrorText()).toBe('Не более 2000 символов')

      saveBtn().click()
      await flush()
      expect(toastError).toHaveBeenCalledWith('Проверьте правильность заполнения полей')
      expect(usersApi.updateMe).not.toHaveBeenCalled()

      setValue(bioField(), 'a'.repeat(2000))
      await flush()
      expect(bioErrorText()).toBe('')
    })
  })

  // ===========================================================================
  describe('change photo (stub)', () => {
    it('toasts the stub message and calls nothing', async () => {
      mount()
      await flush()

      buttonByText('Изменить фото')?.click()
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Опция временно недоступна')
    })
  })

  // ===========================================================================
  describe('master: methods block', () => {
    it('pending: shows the readonly picker + badge, NO submit button, and does not treat it as editable', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ method_change_request: methodChangeRequest() }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      expect(text()).toContain('Ожидает подтверждения')
      expect(methodsSubmitBtn()).toBeUndefined()
    })

    it('rejected: shows the reject reason and the editable picker (not readonly)', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({
          method_change_request: methodChangeRequest({
            status: 'rejected',
            reject_reason: 'Недостаточно опыта',
          }),
        }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      expect(text()).toContain('Прошлый запрос отклонён: Недостаточно опыта')
      expect(methodsSubmitBtn()).toBeDefined()
    })

    it('editable: submit is disabled until the selection actually changes, then submits the flat set and refetches', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ methods: ['Медитация'], method_change_request: null }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      expect(methodsSubmitBtn()?.disabled).toBe(true)

      // Real DOM interaction with the REAL (unstubbed) child picker -- adds a
      // second direction. Falls back to the hardcoded DIRECTION_OPTIONS
      // (getActiveTaxonomy mocked to reject, see banner), so 'Йога' is a real
      // chip.
      methodChip('Йога')?.click()
      await flush()

      expect(methodsSubmitBtn()?.disabled).toBe(false)

      methodsSubmitBtn()?.click()
      await flush()

      expect(mastersApi.submitMethodChangeRequest).toHaveBeenCalledWith(['Медитация', 'Йога'])
      expect(toastInfo).toHaveBeenCalledWith('Запрос на смену методов отправлен на проверку')
      // .vue:292 -- refetch so the pending badge appears on the fresh profile.
      expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(2)
    })

    it('submit error: ApiResponseError surfaces the real detail; generic error falls back (SC-05)', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ methods: ['Медитация'], method_change_request: null }),
      )
      vi.mocked(mastersApi.submitMethodChangeRequest).mockRejectedValue(
        new ApiResponseError(409, 'Запрос уже отправлен', 'request_pending'),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      methodChip('Йога')?.click()
      await flush()
      methodsSubmitBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Запрос уже отправлен')
    })
  })

  // ===========================================================================
  describe('master: languages block', () => {
    it('save is disabled until changed, then sends the toggled set and refetches', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ languages: ['Русский'] }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      expect(languagesSaveBtn()?.disabled).toBe(true)

      languageChip('English')?.click()
      await flush()
      expect(languagesSaveBtn()?.disabled).toBe(false)

      languagesSaveBtn()?.click()
      await flush()

      expect(mastersApi.updateMasterLanguages).toHaveBeenCalledWith(['Русский', 'English'])
      expect(toastInfo).toHaveBeenCalledWith('Языки сохранены')
      expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(2)
    })

    it('clearing to an empty set is allowed (unlike methods) and still enables Save', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ languages: ['Русский'] }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      languageChip('Русский')?.click()
      await flush()

      expect(languagesSaveBtn()?.disabled).toBe(false)
    })
  })

  // ===========================================================================
  describe('delete account modal -- WITH a forfeitable balance (master)', () => {
    it('shows the REAL formatted balance (NBSP-safe) and gates the confirm field behind consent', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ available_cents: 152350 }), // -> 1 523,50 EUR
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      deleteOpenBtn().click()
      await flush()

      expect(modalText()).toContain('На вашем балансе')
      expect(modalText()).toContain('1 523,50')
      // Confirm field is NOT shown yet -- showConfirmField requires consent
      // when hasBalance is true.
      expect(confirmTextInput()).toBeUndefined()

      consentCheckbox()?.click()
      await flush()

      expect(confirmTextInput()).toBeDefined()
    })

    it('canDelete requires BOTH consent and the typed word -- neither alone unlocks it', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ available_cents: 5000 }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      deleteOpenBtn().click()
      await flush()

      // Word without consent: field isn't even rendered yet, so nothing to type.
      expect(modalButtonByText('Удалить навсегда')?.disabled).toBe(true)

      consentCheckbox()?.click()
      await flush()
      // Consent alone, no word yet.
      expect(modalButtonByText('Удалить навсегда')?.disabled).toBe(true)

      setValue(confirmTextInput()!, 'удалить') // lower-case accepted (C7)
      await flush()
      expect(modalButtonByText('Удалить навсегда')?.disabled).toBe(false)
    })

    it('"Сначала вывести средства" closes the modal and routes to master-finance', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ available_cents: 5000 }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      deleteOpenBtn().click()
      await flush()
      modalButtonByText('Сначала вывести средства')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-finance' })
      expect(modalIsOpen()).toBe(false)
    })
  })

  // ===========================================================================
  describe('delete account modal -- the confirm action is a STUB (operator rule)', () => {
    it('confirming calls no API and navigates nowhere -- only the stub toast fires', async () => {
      mount()
      await flush()

      deleteOpenBtn().click()
      await flush()
      setValue(confirmTextInput()!, 'УДАЛИТЬ')
      await flush()

      const confirmBtn = modalButtonByText('Удалить навсегда')
      expect(confirmBtn?.disabled).toBe(false)
      confirmBtn?.click()
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Удаление аккаунта пока недоступно, добавим позже')
      // Pinned: no delete endpoint exists anywhere in @/api/masters or
      // @/api/users, no navigation happens. The day a real delete call is
      // wired in, this assertion is what goes red.
      expect(push).not.toHaveBeenCalled()
      expect(usersApi.updateMe).not.toHaveBeenCalled()
    })

    it('cancel resets consent and the typed word -- reopening starts clean', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        masterProfile({ available_cents: 5000 }),
      )
      useAuthStore().user = user({ role: 'master' })
      mount()
      await flush()

      deleteOpenBtn().click()
      await flush()
      consentCheckbox()?.click()
      await flush()
      setValue(confirmTextInput()!, 'УДАЛИТЬ')
      await flush()
      modalButtonByText('Отмена')?.click()
      await flush()

      expect(modalIsOpen()).toBe(false)

      deleteOpenBtn().click()
      await flush()

      expect(consentCheckbox()?.getAttribute('aria-checked')).toBe('false')
      expect(confirmTextInput()).toBeUndefined() // gated behind consent again
    })
  })
})
