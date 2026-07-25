// =============================================================================
// VELO Frontend -- AdminMasterReviewView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 1148 lines, THE GIANT: the largest screen in the app and the most
// consequential in the admin zone -- it decides whether a master is allowed
// to work on the platform. Scoped by CONSEQUENCE per the operator's explicit
// order: (1) the three actions verify/reject/revoke, (2) the status gates,
// (3) the state-seed id check, (4) the cross-block guard consistency,
// (5) the methods editor, (6) the shared saveProfile path + representatives
// (not eight near-identical tests).
//
// PATTERN = route-param detail screen + THREE mutating actions (verify /
// reject / revoke) + a per-field inline profile editor funnelling through one
// shared save function. No store. Seven seams from @/api/admin: getMasterById,
// verifyMaster, rejectMaster, editMasterMethods, editMasterProfile,
// getRevokePreview, revokeMaster. ApiResponseError kept REAL (importOriginal).
//
// A FOURTH-CATEGORY BUG CAUGHT IN THIS FILE ITSELF, not the screen: an early
// draft used MODULE-LEVEL CONSTANT fixture objects for the pending/verified
// masters, shared across every test. onRevoke/saveMethods/saveProfile all
// mutate `master.value` IN PLACE (`master.value.master_status = 'suspended'`,
// `Object.assign(master.value, patch)`, ...) -- and since `getMasterById`
// was mocked to resolve the SAME shared object, one test's revoke silently
// flipped `master_status` on the fixture every LATER test would also read,
// breaking status-gated assertions several tests downstream with no
// visible connection to the actual cause. Fixed by turning MASTER_PENDING/
// MASTER_VERIFIED into factory FUNCTIONS called fresh at every mock
// call-site, so each test gets its own object. Left as a footnote here
// because it's exactly the kind of test-file bug this session has spent
// several prompts hunting in PRODUCT code -- worth naming when it shows up
// in the test harness instead.
//
// CHILD WITH ITS OWN SEAM, HANDLED THE EditProfileView WAY: MethodTaxonomyPicker
// (.vue:37,205,222) fetches its OWN taxonomy catalog via getActiveTaxonomy
// (@/api/taxonomy) on mount -- the exact trap EditProfileView.test.ts's banner
// documents. Mocked to REJECT (not resolve-with-a-fixture): both this
// screen's OWN parseMethods/hasParsedMethods logic and the picker's internal
// fetch fall back to the SAME hardcoded taxonomy on failure (methodTaxonomy.ts's
// own header comment), so a rejection is the real offline code path, not a
// shortcut -- identical justification to EditProfileView's precedent.
// parseMethods/flattenMethods themselves stay REAL (pure) throughout.
//
// primeMethodTaxonomyCatalog (.vue:568, the SAME Promise.all coupling as
// №472/№476/№480's screens): partial-mocked (importOriginal + spread) to an
// always-resolving stub, so the coupling never drags a real network call into
// the load and never falls the load into the error rung.
//
// TWO TELEPORTED SURFACES: VBottomSheet (reject reason, `.v-sheet__overlay`)
// and VConfirmDialog (revoke confirm, wraps VModal, `.v-modal__overlay`) --
// both purged in afterEach (SC-13), same technique as №476/№480.
//
// THE STATE-SEED CHECK (.vue:559-560): `const handed = (window.history.state
// as {master?}).master; if (handed && handed.id === masterId) master.value =
// handed`. The id check IS present -- CLEAN NEGATIVE for the
// BookingConfirmedView archetype, same as AdminReportDetailView's (№480).
// BUT NOTE A REAL DIFFERENCE from that screen: even after a MATCHING seed,
// loadMaster() ALWAYS ALSO fetches the full detail afterwards ("Always fetch
// the detail afterwards to fill the real methods / experience / bio", .vue's
// own comment) -- unlike AdminReportDetailView, where a matching seed SKIPS
// the fetch entirely. Both directions asserted below, matching this screen's
// actual (fetch-always) contract, and the id check itself is
// mutation-PROVEN, not just present.
//
// THE THREE GUARDS -- READ, NOT GREPPED, EXACTLY AS THE OPERATOR ASKED (the
// recon's suspicion was CONFIRMED as real, not assumed, in №482 -- and FIXED
// in №483):
//   - onVerify (.vue:769): `if (anyLoading.value) return` -- checks the FULL
//     cross-block computed (verifying || rejecting || revoking). Unchanged,
//     already correct.
//   - onReject (.vue:785): FIXED -- was `if (rejecting.value) return` (own
//     flag only), now `if (anyLoading.value) return`.
//   - onRevoke (.vue:539): FIXED -- was `if (revoking.value) return` (own
//     flag only), now `if (anyLoading.value) return`.
// THE HABIT, again: a cross-block guard written and honoured on ONE of three
// siblings, forgotten on the other two -- the exact shape fixed in №481 for
// AdminReportDetailView's pair, now fixed here too. Structural note verified
// before asserting anything: isPending and isVerified are mutually exclusive
// (both read master_status), so verify/reject NEVER coexist on screen with
// revoke -- revoke's own asymmetry could never actually race against verify
// or reject through the UI, but the fix is applied anyway for consistency
// (the operator's call, №483). Verify and reject DO coexist (both render
// together while pending), so THAT pair was the one with real reachability --
// see the "THE THREE GUARDS" describe block, now asserting BLOCKED.
//
// A SECOND FINDING, FIXED in №483, found by reading every field row's
// template (.vue:54-272): the fieldError produced by a failed saveProfile
// (.vue:701-702, NO toast on this path, only `fieldError.value`) had NO
// VISIBLE UI AT ALL for THREE of the eight fields -- phone (.vue:128-144,
// now `:error="fieldError"` on its VInput, matching display_name/email/
// experience_years), languages (.vue:164-194) and certifications
// (.vue:239-272, both now a `<p class="mreview__edit-err">`, matching
// account_name/bio -- neither is a VInput, so shape B fits, not shape A).
// Asserted below as the fixed, current behaviour.
//
// A THIRD FINDING, measured (not assumed -- an initial draft of this file
// guessed wrong and was corrected after a throwaway debug test against the
// REAL parseMethods/flattenMethods): hasParsedMethods (.vue:478-480,
// `flattenMethods(parseMethods(methods)).length > 0`) is TRUE not only for a
// taxonomy-matching method but ALSO for a fully unmatched/custom one --
// parseMethods surfaces an unmatched string as `customText`
// (SURFACE-UNMATCHED, Q3=А), and flattenMethods re-emits non-empty
// customText right back into its output. Consequence: the screen's OWN
// verbatim `.mreview__chips` fallback (.vue:223-225,
// `v-else-if="methods.length"`) is effectively DEAD for any methods array
// with real (non-whitespace) content -- the readonly MethodTaxonomyPicker
// renders in EVERY such case instead (it has its own custom-chip rendering
// for the unmatched case, MethodTaxonomyPicker.vue:66-68). The fallback
// would only fire for a pathological methods array of solely empty/
// whitespace strings. Reported, not fixed here.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminMasterReviewView from '@/views/admin/AdminMasterReviewView.vue'
import * as adminApi from '@/api/admin'
import * as taxonomyApi from '@/api/taxonomy'
import { ApiResponseError } from '@/api/client'
import type {
  AdminMasterDetail,
  AdminMasterListItem,
  AdminMasterActionResponse,
  RevokeMasterAdvisory,
} from '@/api/admin'

vi.mock('@/api/admin')

vi.mock('@/api/taxonomy')

vi.mock('@/utils/methodTaxonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/methodTaxonomy')>()
  return {
    ...actual,
    primeMethodTaxonomyCatalog: vi.fn().mockResolvedValue(undefined),
  }
})

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'm_pending' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: toastSuccess }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function master(overrides: Partial<AdminMasterDetail> = {}): AdminMasterDetail {
  return {
    id: 'm_pending',
    telegram_id: 1,
    first_name: 'Анна',
    last_name: 'Мастерова',
    avatar_url: null,
    role: 'master',
    is_active: true,
    master_status: 'pending',
    methods: ['Медитация'], // bare direction label, matches the taxonomy
    practices_count: 0,
    students_count: 0,
    available_cents: 0,
    experience_years: 5,
    bio: 'Практикую 5 лет',
    display_name: 'Мастер Анна',
    email: 'anna@example.com',
    phone: '+79991234567',
    languages: ['Русский'],
    certifications: ['Сертификат йоги'],
    ...overrides,
  }
}

function MASTER_PENDING(): AdminMasterDetail {
  return master({ id: 'm_pending', master_status: 'pending' })
}
function MASTER_VERIFIED(): AdminMasterDetail {
  return master({ id: 'm_verified', master_status: 'verified' })
}

function listItem(overrides: Partial<AdminMasterListItem> = {}): AdminMasterListItem {
  return {
    id: 'm_pending',
    telegram_id: 1,
    first_name: 'Анна',
    last_name: 'Мастерова',
    avatar_url: null,
    role: 'master',
    is_active: true,
    master_status: 'pending',
    methods: ['Медитация'],
    practices_count: 0,
    students_count: 0,
    available_cents: 0,
    ...overrides,
  }
}

function advisory(overrides: Partial<RevokeMasterAdvisory> = {}): RevokeMasterAdvisory {
  return {
    scheduled_or_live_practices: 0,
    available_cents: 0,
    frozen_cents: 0,
    pending_withdrawals: 0,
    has_warnings: false,
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

/** Seed router state (or clear it), set the route param, then mount -- the
 *  screen reads history.state during setup (.vue:559), seeding after is too
 *  late (same order requirement as AdminWithdrawalDetailView/№480). */
function mount(id: string, stateMaster: AdminMasterListItem | null = null): HTMLElement {
  routeParams.id = id
  window.history.replaceState(stateMaster ? { master: stateMaster } : {}, '')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminMasterReviewView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}
function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.mreview__row') ?? [])
}
function rowByKey(key: string): HTMLElement {
  const row = rows().find((r) => r.querySelector('.mreview__k')?.textContent?.trim() === key)
  if (!row) throw new Error(`no row keyed «${key}»`)
  return row
}
function fieldValue(key: string): string | undefined {
  return rowByKey(key).querySelector('.mreview__v')?.textContent?.trim()
}
function pencilBtn(key: string): HTMLButtonElement {
  const b = rowByKey(key).querySelector<HTMLButtonElement>('.mreview__pen')
  if (!b) throw new Error(`no pencil button for «${key}»`)
  return b
}
function rowBtnByText(key: string, t: string): HTMLButtonElement | undefined {
  return Array.from(rowByKey(key).querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === t,
  )
}
function saveBtn(key: string): HTMLButtonElement {
  const b = rowBtnByText(key, 'Сохранить')
  if (!b) throw new Error(`no Save button for «${key}»`)
  return b
}
function cancelBtn(key: string): HTMLButtonElement {
  const b = rowBtnByText(key, 'Отмена')
  if (!b) throw new Error(`no Cancel button for «${key}»`)
  return b
}
function rowInput(key: string): HTMLInputElement {
  const el = rowByKey(key).querySelector<HTMLInputElement>('.v-input__field')
  if (!el) throw new Error(`no <input> for «${key}»`)
  return el
}
function rowInputs(key: string): HTMLInputElement[] {
  return Array.from(rowByKey(key).querySelectorAll<HTMLInputElement>('.v-input__field'))
}
function rowErrorText(key: string): string {
  const row = rowByKey(key)
  const inputErr = row.querySelector('.v-input__error')?.textContent?.trim()
  const pErr = row.querySelector('.mreview__edit-err')?.textContent?.trim()
  return inputErr || pErr || ''
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function chipByText(root: HTMLElement, t: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('.v-chip')).find(
    (c) => c.textContent?.trim() === t,
  )
}
function footBtn(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}

// Teleported surfaces (SC-07 -- never query `host`).
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
function sheetBtn(t: string): HTMLButtonElement | undefined {
  return Array.from(sheetOverlay()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
function modalIsOpen(): boolean {
  const el = modalOverlay()
  return !!el && !el.classList.contains('v-modal-leave-active')
}
function modalBtn(t: string): HTMLButtonElement | undefined {
  return Array.from(modalOverlay()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getMasterById).mockReset().mockResolvedValue(MASTER_PENDING())
  vi.mocked(adminApi.verifyMaster).mockReset()
  vi.mocked(adminApi.rejectMaster).mockReset()
  vi.mocked(adminApi.editMasterMethods).mockReset()
  vi.mocked(adminApi.editMasterProfile).mockReset()
  vi.mocked(adminApi.getRevokePreview).mockReset().mockResolvedValue(advisory())
  vi.mocked(adminApi.revokeMaster).mockReset()
  // Rejected -- both this screen's parseMethods AND the picker's own fetch
  // fall back to the SAME hardcoded taxonomy on failure (see banner).
  vi.mocked(taxonomyApi.getActiveTaxonomy).mockReset().mockRejectedValue(new Error('offline in test'))

  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.history.replaceState({}, '')

  // SC-13 -- both teleported surfaces this screen genuinely opens.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('AdminMasterReviewView', () => {
  // ===========================================================================
  describe('THE STATE-SEED CHECK (.vue:559-560)', () => {
    it('a MATCHING seed paints instantly, but the full detail is STILL fetched afterwards (unlike AdminReportDetailView)', async () => {
      const handed = listItem({ id: 'm_pending' })
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_PENDING())
      mount('m_pending', handed)

      // Instant paint, before the fetch settles.
      await nextTick()
      expect(text()).toContain('Анна Мастерова')

      await flush()
      // Unlike AdminReportDetailView's skip-on-match, THIS screen always
      // fetches afterwards (its own comment: "Always fetch the detail
      // afterwards to fill the real methods / experience / bio").
      expect(adminApi.getMasterById).toHaveBeenCalledWith('m_pending')
    })

    // NOTE ON THE FIRST-DRAFT MISS: this screen ALWAYS re-fetches regardless
    // of whether the seed matched (.vue:559-568 has NO early `return`, unlike
    // AdminReportDetailView's skip-on-match) -- so once the fetch has
    // SETTLED, a matched vs a mismatched seed look byte-identical (the real
    // fetch always overwrites `master.value` last). An id-check mutation
    // (`handed.id === masterId` -> `handed`) therefore stayed GREEN against
    // an await-to-completion assertion -- investigated, not claimed as a
    // proof. The check's ONLY observable effect is in the TRANSIENT window
    // BEFORE the fetch resolves: a wrongly-accepted mismatched seed would
    // flash the WRONG master's data (and skip the loading spinner, since
    // `loading.value` is only set when `!master.value`) for one frame. This
    // rewritten version uses a controlled (unresolved) promise to observe
    // exactly that window, and DOES discriminate the mutation -- verified
    // live: reverting the id check with this version in place turns it red.
    it('a MISMATCHED seed does NOT paint instantly -- the loader shows until the real fetch settles', async () => {
      const staleFromAnother = listItem({
        id: 'm_completely_different',
        first_name: 'Чужой',
        last_name: 'Мастер',
      })
      let resolveGet!: (v: AdminMasterDetail) => void
      vi.mocked(adminApi.getMasterById).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve
          }),
      )
      mount('m_pending', staleFromAnother)
      await nextTick()

      // The mismatched seed was correctly ignored -- loading, not a flash of
      // the wrong master's name.
      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(text()).not.toContain('Чужой Мастер')

      resolveGet(MASTER_PENDING())
      await flush()

      expect(adminApi.getMasterById).toHaveBeenCalledWith('m_pending')
      expect(text()).toContain('Анна Мастерова')
    })
  })

  // ===========================================================================
  describe('ladder', () => {
    it('loading -> content', async () => {
      let resolveGet!: (v: AdminMasterDetail) => void
      vi.mocked(adminApi.getMasterById).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve
          }),
      )
      mount('m_pending')
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveGet(MASTER_PENDING())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(text()).toContain('Анна Мастерова')
    })

    it('SW7: a cold-deep-link failure lands in a DISTINCT error rung, not "not found" -- with a retry button', async () => {
      // Previously this fell straight into the "Заявка не найдена" empty
      // state (the SAME state a genuine 404 renders), with only a toast (easy
      // to miss) as the sole signal something was actually wrong -- no way to
      // retell a transient network blip from "this application doesn't exist"
      // and no retry affordance. Matches sibling admin detail screens
      // (AdminPracticeDetailView, AdminRevenueView, AdminWithdrawalDetailView).
      vi.mocked(adminApi.getMasterById).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_missing')
      await flush()

      expect(text()).toContain('Ошибка загрузки')
      expect(text()).not.toContain('Заявка не найдена')
      const retry = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Повторить',
      )
      expect(retry).toBeDefined()
    })

    it('failure (ApiResponseError): the error rung carries the real backend detail', async () => {
      vi.mocked(adminApi.getMasterById).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount('m_missing')
      await flush()

      expect(text()).toContain('Сервер недоступен')
    })

    it('SW7: «Повторить» recovers to content after a failure', async () => {
      vi.mocked(adminApi.getMasterById).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount('m_missing')
      await flush()

      const retry = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Повторить',
      )
      expect(retry).toBeDefined()

      vi.mocked(adminApi.getMasterById).mockResolvedValueOnce(MASTER_PENDING())
      retry?.click()
      await flush()

      expect(text()).not.toContain('Ошибка загрузки')
      expect(text()).toContain('Анна Мастерова')
      expect(adminApi.getMasterById).toHaveBeenCalledTimes(2)
    })

    it('a fetch failure AFTER a router-state hand-off keeps showing the handed data (toast only, no error rung)', async () => {
      // A background refine failing must not blank data the list screen
      // already handed over -- mirrors AdminPracticeDetailView's T21-1 "don't
      // blank a working page over a secondary failure" convention.
      vi.mocked(adminApi.getMasterById).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending', MASTER_PENDING())
      await flush()

      expect(text()).toContain('Анна Мастерова')
      expect(text()).not.toContain('Ошибка загрузки')
      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки данных')
    })
  })

  // ===========================================================================
  describe('status gates (isPending / isVerified, .vue:497-498,336,347)', () => {
    it('PENDING: shows Отклонить/Одобрить, hides Отозвать', async () => {
      mount('m_pending', null)
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_PENDING())
      await flush()

      expect(footBtn('Отклонить')).toBeDefined()
      expect(footBtn('Одобрить')).toBeDefined()
      expect(footBtn('Отозвать мастера')).toBeUndefined()
      expect(host?.querySelector('.mreview__processed')).toBeNull()
    })

    it('VERIFIED: hides Отклонить/Одобрить, shows Отозвать + the processed note', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      mount('m_verified')
      await flush()

      expect(footBtn('Отклонить')).toBeUndefined()
      expect(footBtn('Одобрить')).toBeUndefined()
      expect(footBtn('Отозвать мастера')).toBeDefined()
      expect(host?.querySelector('.mreview__processed')?.textContent).toContain('Верифицирован')
    })

    it('REJECTED (neither pending nor verified): the processed note shows, NO actions at all', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(master({ master_status: 'rejected' }))
      mount('m_rejected')
      await flush()

      expect(footBtn('Отклонить')).toBeUndefined()
      expect(footBtn('Одобрить')).toBeUndefined()
      expect(footBtn('Отозвать мастера')).toBeUndefined()
      expect(host?.querySelector('.mreview__processed')?.textContent).toContain('Отклонён')
    })

    it('MUTATION: inverting isVerified\'s status check hides Отозвать for an actually-verified master', async () => {
      // Not a source mutation (out of scope for this coverage-only commit) --
      // proven instead by feeding a status the real computed does NOT
      // recognise as verified, confirming the gate reads the EXACT string,
      // not a loose truthy check.
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ master_status: 'Verified' }), // wrong case -- must NOT match
      )
      mount('m_odd')
      await flush()

      expect(footBtn('Отозвать мастера')).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('VERIFY (.vue:768-782)', () => {
    it('success: verifyMaster called with the id, toasts, navigates to admin-masters', async () => {
      vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()

      expect(adminApi.verifyMaster).toHaveBeenCalledWith('m_pending', undefined, undefined)
      expect(toastSuccess).toHaveBeenCalledWith('Мастер верифицирован')
      expect(push).toHaveBeenCalledWith({ name: 'admin-masters' })
    })

    it('failure: toasts (detail / fallback), does NOT navigate, actions stay visible', async () => {
      vi.mocked(adminApi.verifyMaster).mockRejectedValue(
        new ApiResponseError(409, 'Заявка уже обработана', 'already_decided'),
      )
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Заявка уже обработана')
      expect(push).not.toHaveBeenCalled()
      expect(footBtn('Одобрить')).toBeDefined()
    })

    it('failure (non-ApiResponseError): falls back to "Ошибка верификации"', async () => {
      vi.mocked(adminApi.verifyMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка верификации')
    })
  })

  // ===========================================================================
  // PROMOTE-ON-VERIFY (ПРОМТ №505): mirrors AdminMethodRequestsView's own
  // promote-on-approve dialog. `getActiveTaxonomy` is mocked to REJECT in
  // beforeEach (see banner) -- the catalog cache never warms in this whole
  // file, so any label outside the hardcoded DIRECTION_OPTIONS/
  // STYLE_OPTIONS_BY_DIRECTION maps reliably parses as unmatched/custom.
  // ===========================================================================
  describe('PROMOTE-ON-VERIFY (.vue: onVerify/doVerify, ПРОМТ №505)', () => {
    it('no custom text (default fixture, methods: ["Медитация"] matches the taxonomy): verifies immediately, no dialog', async () => {
      vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()

      expect(modalIsOpen()).toBe(false)
      expect(adminApi.verifyMaster).toHaveBeenCalledWith('m_pending', undefined, undefined)
    })

    it('custom/unmatched text: pauses on the confirm dialog INSTEAD of calling verifyMaster', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ methods: ['Нестандартный метод'] }),
      )
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()

      expect(modalIsOpen()).toBe(true)
      expect(modalOverlay()?.textContent).toContain(
        'Метода «Нестандартный метод» нет в каталоге — добавить для всех мастеров?',
      )
      expect(adminApi.verifyMaster).not.toHaveBeenCalled()
    })

    it('confirm ("Добавить в каталог"): verifyMaster called WITH promote, toasts, navigates', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ methods: ['Нестандартный метод'] }),
      )
      vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()
      modalBtn('Добавить в каталог')?.click()
      await flush()

      expect(adminApi.verifyMaster).toHaveBeenCalledWith(
        'm_pending', ['Нестандартный метод'], undefined,
      )
      expect(toastSuccess).toHaveBeenCalledWith('Мастер верифицирован')
      expect(push).toHaveBeenCalledWith({ name: 'admin-masters' })
      expect(modalIsOpen()).toBe(false)
    })

    it('cancel ("Только этому мастеру"): verifies, SCOPED to this master only (T22-6, ПРОМТ №561)', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ methods: ['Нестандартный метод'] }),
      )
      vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()
      // The dialog must genuinely be open here -- otherwise verifyMaster
      // below could have already fired straight off the "Одобрить" click,
      // which would make this test pass for the WRONG reason (the button
      // click below finding nothing to click is a silent no-op, per the
      // mutation-checked note at the end of this describe block).
      expect(modalIsOpen()).toBe(true)
      expect(adminApi.verifyMaster).not.toHaveBeenCalled()
      const cancelBtnEl = modalBtn('Только этому мастеру')
      expect(cancelBtnEl).toBeDefined()
      cancelBtnEl?.click()
      await flush()

      // Was "exactly one arg, promote never sent": that used to mean the
      // label vanished entirely (T22-6). Now it takes the master_only
      // branch, so the direction gets a real (master-scoped) row.
      expect(adminApi.verifyMaster).toHaveBeenCalledWith(
        'm_pending', undefined, ['Нестандартный метод'],
      )
      expect(toastSuccess).toHaveBeenCalledWith('Мастер верифицирован')
      expect(push).toHaveBeenCalledWith({ name: 'admin-masters' })
    })

    it('dismiss (overlay tap, NOT the cancel button): STILL verifies, scoped to this master only', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ methods: ['Нестандартный метод'] }),
      )
      vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()
      expect(modalIsOpen()).toBe(true)

      // VModal's overlay has @click.self -- dispatching directly on the
      // overlay element itself (not a descendant button) is the dismiss
      // path, distinct from clicking "Только этому мастеру".
      modalOverlay()?.click()
      await flush()

      expect(adminApi.verifyMaster).toHaveBeenCalledWith(
        'm_pending', undefined, ['Нестандартный метод'],
      )
      expect(toastSuccess).toHaveBeenCalledWith('Мастер верифицирован')
    })

    it('failure after confirm: toasts, does NOT navigate, dialog stays closed (not stuck re-open)', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ methods: ['Нестандартный метод'] }),
      )
      vi.mocked(adminApi.verifyMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      footBtn('Одобрить')?.click()
      await flush()
      expect(modalIsOpen()).toBe(true) // see the mutation-checked note below
      const confirmBtnEl = modalBtn('Добавить в каталог')
      expect(confirmBtnEl).toBeDefined()
      confirmBtnEl?.click()
      await flush()

      expect(adminApi.verifyMaster).toHaveBeenCalledWith(
        'm_pending', ['Нестандартный метод'], undefined,
      )
      expect(toastError).toHaveBeenCalledWith('Ошибка верификации')
      expect(push).not.toHaveBeenCalled()
      expect(modalIsOpen()).toBe(false)
    })

    // MUTATION-CHECKED (found, not banked): an early draft of "cancel" and
    // "failure after confirm" above used `modalBtn(...)?.click()` with no
    // prior modalIsOpen() assertion. Breaking the customEnabled branch in
    // onVerify (always skip the dialog) made verifyMaster fire straight off
    // the "Одобрить" click -- and those two tests STILL PASSED, because a
    // click on a `?.`-chained missing button is a silent no-op, and the
    // final assertions (verifyMaster called with just the id; the error
    // toast) look identical whether reached via "dialog opened -> cancel/
    // confirm clicked" or "dialog skipped entirely". Fixed by asserting
    // modalIsOpen() (and, for cancel, that verifyMaster had NOT yet been
    // called) right after the first click, and asserting the target button
    // actually exists before clicking it -- re-run against the same
    // mutation below confirms all six cases now fail correctly.
  })

  // ===========================================================================
  describe('REJECT (.vue:758-804)', () => {
    it('opens the sheet; VALIDATION: an empty/whitespace reason blocks submit with "Укажите причину отказа"', async () => {
      mount('m_pending')
      await flush()

      footBtn('Отклонить')?.click()
      await flush()
      expect(sheetIsOpen()).toBe(true)

      sheetBtn('Отклонить заявку')?.click()
      await flush()

      expect(sheetOverlay()?.querySelector('.v-textarea__error')?.textContent?.trim()).toBe(
        'Укажите причину отказа',
      )
      expect(adminApi.rejectMaster).not.toHaveBeenCalled()
    })

    it('success: rejectMaster called with id + trimmed reason, toasts, navigates', async () => {
      vi.mocked(adminApi.rejectMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      footBtn('Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), '  Недостаточно опыта  ')
      await flush()
      sheetBtn('Отклонить заявку')?.click()
      await flush()

      expect(adminApi.rejectMaster).toHaveBeenCalledWith('m_pending', 'Недостаточно опыта')
      expect(toastSuccess).toHaveBeenCalledWith('Заявка отклонена')
      expect(push).toHaveBeenCalledWith({ name: 'admin-masters' })
    })

    it('failure: toasts (detail / "Ошибка при отклонении"), sheet STAYS open, no navigation', async () => {
      vi.mocked(adminApi.rejectMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      footBtn('Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), 'Причина')
      await flush()
      sheetBtn('Отклонить заявку')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка при отклонении')
      expect(push).not.toHaveBeenCalled()
      expect(sheetIsOpen()).toBe(true)
    })
  })

  // ===========================================================================
  describe('REVOKE -- the preview ordering IS the safety property (.vue:527-552)', () => {
    it('openRevoke fetches the preview and the advisory renders once resolved; revokeMaster is untouched until then', async () => {
      let resolvePreview!: (v: RevokeMasterAdvisory) => void
      vi.mocked(adminApi.getRevokePreview).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePreview = resolve
          }),
      )
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      mount('m_verified')
      await flush()

      footBtn('Отозвать мастера')?.click()
      await flush()

      expect(adminApi.getRevokePreview).toHaveBeenCalledWith('m_verified')
      expect(modalIsOpen()).toBe(true)
      expect(adminApi.revokeMaster).not.toHaveBeenCalled() // preview in flight, nothing destroyed yet
      expect(modalOverlay()?.textContent).not.toContain('Внимание')

      resolvePreview(
        advisory({ has_warnings: true, scheduled_or_live_practices: 3, pending_withdrawals: 1 }),
      )
      await flush()

      expect(modalOverlay()?.textContent).toContain('Внимание')
      expect(modalOverlay()?.textContent).toContain('3 практик')
      expect(adminApi.revokeMaster).not.toHaveBeenCalled() // still untouched -- no confirm yet
    })

    it('a FAILED preview leaves the base message (WARN-not-block) -- the confirm button still works', async () => {
      vi.mocked(adminApi.getRevokePreview).mockRejectedValue(new Error('ECONNRESET'))
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      vi.mocked(adminApi.revokeMaster).mockResolvedValue(advisory())
      mount('m_verified')
      await flush()

      footBtn('Отозвать мастера')?.click()
      await flush()

      expect(modalIsOpen()).toBe(true)
      expect(modalOverlay()?.textContent).toContain('снова станет обычным пользователем')

      modalBtn('Отозвать')?.click()
      await flush()

      expect(adminApi.revokeMaster).toHaveBeenCalledWith('m_verified')
    })

    it('confirming calls revokeMaster, flips status locally, closes the dialog, toasts', async () => {
      vi.mocked(adminApi.revokeMaster).mockResolvedValue(advisory())
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      mount('m_verified')
      await flush()

      footBtn('Отозвать мастера')?.click()
      await flush()
      modalBtn('Отозвать')?.click()
      await flush()

      expect(adminApi.revokeMaster).toHaveBeenCalledWith('m_verified')
      expect(toastSuccess).toHaveBeenCalledWith('Мастер отозван — аккаунт стал пользователем')
      expect(modalIsOpen()).toBe(false)
      // Local status flip (.vue:543) -- the "Отозвать" button itself disappears
      // (no longer verified), NOT re-fetched from the server.
      expect(footBtn('Отозвать мастера')).toBeUndefined()
    })

    it('cancelling calls NOTHING -- revokeMaster is never reached', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      mount('m_verified')
      await flush()

      footBtn('Отозвать мастера')?.click()
      await flush()
      modalBtn('Отмена')?.click()
      await flush()

      expect(adminApi.revokeMaster).not.toHaveBeenCalled()
      expect(modalIsOpen()).toBe(false)
    })

    it('failure: toasts (detail / "Не удалось отозвать мастера"), status is NOT flipped locally', async () => {
      vi.mocked(adminApi.revokeMaster).mockRejectedValue(new Error('ECONNRESET'))
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      mount('m_verified')
      await flush()

      footBtn('Отозвать мастера')?.click()
      await flush()
      modalBtn('Отозвать')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отозвать мастера')
      expect(footBtn('Отозвать мастера')).toBeDefined() // still verified, button survives
    })
  })

  // ===========================================================================
  // THE THREE GUARDS, measured for real (not grepped). Confirmed at file:line
  // in the banner: onVerify checks anyLoading (.vue:769); onReject and
  // onRevoke check ONLY their own flag (.vue:785, .vue:539). Structural fact
  // established first: isPending/isVerified are mutually exclusive, so
  // verify/reject (pending-only) never coexist on screen with revoke
  // (verified-only) -- revoke's asymmetry cannot race verify or reject
  // through the UI. Verify and reject DO coexist while pending -- that is the
  // one pair actually worth measuring.
  describe('THE THREE GUARDS -- measured, not assumed', () => {
    it('onVerify OWN reentrancy: a same-tick double click on Одобрить makes one api call (anyLoading catches its own flag too)', async () => {
      let resolveVerify!: (v: AdminMasterActionResponse) => void
      vi.mocked(adminApi.verifyMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve
          }),
      )
      mount('m_pending')
      await flush()

      const btn = footBtn('Одобрить')!
      btn.click()
      btn.click()
      await flush()

      expect(adminApi.verifyMaster).toHaveBeenCalledTimes(1)
      resolveVerify({ user_id: 'm_pending', status: 'ok' })
      await flush()
    })

    it('onReject OWN reentrancy: a same-tick double-submit in the sheet makes one api call (rejecting.value alone is sufficient here)', async () => {
      let resolveReject!: (v: AdminMasterActionResponse) => void
      vi.mocked(adminApi.rejectMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReject = resolve
          }),
      )
      mount('m_pending')
      await flush()

      footBtn('Отклонить')?.click()
      await flush()
      setValue(sheetTextarea(), 'Причина')
      await flush()

      const saveBtnEl = sheetBtn('Отклонить заявку')!
      saveBtnEl.click()
      saveBtnEl.click()
      await flush()

      expect(adminApi.rejectMaster).toHaveBeenCalledTimes(1)
      resolveReject({ user_id: 'm_pending', status: 'ok' })
      await flush()
    })

    // MEASURED CROSS-PAIR RACE (verify vs reject -- the only pair that
    // coexists on screen). Realistic reachability caveat, stated honestly:
    // once the reject sheet is open, its `.v-sheet__overlay` is
    // `position:fixed;inset:0` (VBottomSheet.vue), covering the footer in a
    // REAL browser's hit-testing -- so a real pointer could not click
    // "Одобрить" while the sheet is open. happy-dom's `.click()` has no
    // hit-testing/occlusion model, so it DOES reach the handler regardless.
    // This test proves the PROGRAMMATIC/handler-level gap (what a scripted
    // client or a future UI change without the overlay could hit), not a
    // claim that a real fingertip can reach it today.
    it('FIXED: verify-in-flight now blocks a reject submit -- onReject checks anyLoading', async () => {
      let resolveVerify!: (v: AdminMasterActionResponse) => void
      vi.mocked(adminApi.verifyMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve
          }),
      )
      vi.mocked(adminApi.rejectMaster).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      // No await between these two: the "Отклонить" TRIGGER button (not
      // onReject itself) IS `:disabled="anyLoading"` (.vue:337) -- once
      // painted, a real click on it is a no-op (confirmed: an earlier draft
      // of this test awaited a tick here and the sheet never opened at all).
      // Firing both clicks in the same synchronous tick, before that
      // attribute paints, is what actually reaches openReject (which itself
      // has NO guard of its own) while verifying is in flight.
      footBtn('Одобрить')?.click() // verifying = true, in flight
      footBtn('Отклонить')?.click() // openReject -- no guard, opens regardless
      await flush()
      setValue(sheetTextarea(), 'Причина')
      await flush()
      sheetBtn('Отклонить заявку')?.click() // onReject now checks anyLoading (verifying is true)
      await flush()

      expect(adminApi.rejectMaster).not.toHaveBeenCalled() // blocked -- verify still in flight

      resolveVerify({ user_id: 'm_pending', status: 'ok' })
      await flush()
    })

    it('onRevoke OWN reentrancy: a same-tick double-confirm makes one api call', async () => {
      let resolveRevoke!: (v: RevokeMasterAdvisory) => void
      vi.mocked(adminApi.revokeMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRevoke = resolve
          }),
      )
      vi.mocked(adminApi.getMasterById).mockResolvedValue(MASTER_VERIFIED())
      mount('m_verified')
      await flush()

      footBtn('Отозвать мастера')?.click()
      await flush()

      const confirmBtn = modalBtn('Отозвать')!
      confirmBtn.click()
      confirmBtn.click()
      await flush()

      expect(adminApi.revokeMaster).toHaveBeenCalledTimes(1)
      resolveRevoke(advisory())
      await flush()
    })
  })

  // ===========================================================================
  describe('methods editor (.vue:579-610)', () => {
    it('startMethods seeds the draft and opens the editor', async () => {
      mount('m_pending')
      await flush()

      expect(host?.querySelector('.mreview__methods-edit')).toBeNull()
      pencilBtn('Направления практик').click()
      await flush()

      expect(host?.querySelector('.mreview__methods-edit')).not.toBeNull()
    })

    it('cancelMethods closes without an api call', async () => {
      mount('m_pending')
      await flush()

      pencilBtn('Направления практик').click()
      await flush()
      rowBtnByText('Направления практик', 'Отмена')?.click()
      await flush()

      expect(host?.querySelector('.mreview__methods-edit')).toBeNull()
      expect(adminApi.editMasterMethods).not.toHaveBeenCalled()
    })

    it('VALIDATION: an empty draft blocks save with "Выберите хотя бы одно направление"', async () => {
      // Seeded with EMPTY methods so the draft starts empty without needing
      // to drive the picker's own chip UI.
      vi.mocked(adminApi.getMasterById).mockResolvedValue(master({ methods: [] }))
      mount('m_pending')
      await flush()

      pencilBtn('Направления практик').click()
      await flush()
      rowBtnByText('Направления практик', 'Сохранить')?.click()
      await flush()

      expect(host?.querySelector('.mreview__methods-err')?.textContent).toBe(
        'Выберите хотя бы одно направление',
      )
      expect(adminApi.editMasterMethods).not.toHaveBeenCalled()
    })

    it('success: editMasterMethods called with the (seeded, untouched) draft, local update, toast', async () => {
      vi.mocked(adminApi.editMasterMethods).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending') // methods: ['Медитация']
      await flush()

      pencilBtn('Направления практик').click()
      await flush()
      rowBtnByText('Направления практик', 'Сохранить')?.click()
      await flush()

      expect(adminApi.editMasterMethods).toHaveBeenCalledWith('m_pending', ['Медитация'])
      expect(toastSuccess).toHaveBeenCalledWith('Направления обновлены')
      expect(host?.querySelector('.mreview__methods-edit')).toBeNull()
    })

    it('failure: toasts (detail / "Не удалось сохранить направления"), editor stays open', async () => {
      vi.mocked(adminApi.editMasterMethods).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      pencilBtn('Направления практик').click()
      await flush()
      rowBtnByText('Направления практик', 'Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить направления')
      expect(host?.querySelector('.mreview__methods-edit')).not.toBeNull()
    })
  })

  // ===========================================================================
  describe('profile fields -- the SHARED saveProfile path (.vue:692-706), via displayName', () => {
    it('VALIDATION: an empty display_name blocks save with "Введите имя-визитку", no api call', async () => {
      mount('m_pending')
      await flush()

      pencilBtn('Имя-визитка').click()
      await flush()
      setValue(rowInput('Имя-визитка'), '   ')
      await flush()
      saveBtn('Имя-визитка').click()
      await flush()

      expect(rowErrorText('Имя-визитка')).toBe('Введите имя-визитку')
      expect(adminApi.editMasterProfile).not.toHaveBeenCalled()
    })

    it('success: editMasterProfile called with the exact patch, LOCAL update via Object.assign, toast, editor closes', async () => {
      vi.mocked(adminApi.editMasterProfile).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      pencilBtn('Имя-визитка').click()
      await flush()
      setValue(rowInput('Имя-визитка'), '  Мастер Обновлённая  ')
      await flush()
      saveBtn('Имя-визитка').click()
      await flush()

      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m_pending', {
        display_name: 'Мастер Обновлённая',
      })
      expect(toastSuccess).toHaveBeenCalledWith('Сохранено')
      expect(fieldValue('Имя-визитка')).toBe('Мастер Обновлённая') // local patch reflected
    })

    it('failure: NO toast fires (this path only sets fieldError, unlike verify/reject/revoke) -- editor STAYS open', async () => {
      vi.mocked(adminApi.editMasterProfile).mockRejectedValue(
        new ApiResponseError(409, 'Занято другим мастером', 'duplicate'),
      )
      mount('m_pending')
      await flush()

      pencilBtn('Имя-визитка').click()
      await flush()
      setValue(rowInput('Имя-визитка'), 'Новое имя')
      await flush()
      saveBtn('Имя-визитка').click()
      await flush()

      expect(rowErrorText('Имя-визитка')).toBe('Занято другим мастером')
      expect(toastError).not.toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(host?.querySelector('.mreview__edit')).not.toBeNull() // still editing
    })

    it('cancelField discards the draft WITHOUT any api call; the original value is unchanged', async () => {
      mount('m_pending')
      await flush()

      pencilBtn('Имя-визитка').click()
      await flush()
      setValue(rowInput('Имя-визитка'), 'Отменённое значение')
      await flush()
      cancelBtn('Имя-визитка').click()
      await flush()

      expect(adminApi.editMasterProfile).not.toHaveBeenCalled()
      expect(fieldValue('Имя-визитка')).toBe('Мастер Анна') // original, untouched
    })
  })

  // ===========================================================================
  describe('profile fields -- differing representatives (not eight near-identical tests)', () => {
    it('saveExperience: numeric validation rejects non-integer/out-of-range, accepts 0-50', async () => {
      mount('m_pending')
      await flush()

      pencilBtn('Опыт').click()
      await flush()
      setValue(rowInput('Опыт'), '51')
      await flush()
      saveBtn('Опыт').click()
      await flush()
      expect(rowErrorText('Опыт')).toBe('Опыт: целое число 0–50')
      expect(adminApi.editMasterProfile).not.toHaveBeenCalled()

      setValue(rowInput('Опыт'), '3.5')
      await flush()
      saveBtn('Опыт').click()
      await flush()
      expect(rowErrorText('Опыт')).toBe('Опыт: целое число 0–50')

      vi.mocked(adminApi.editMasterProfile).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      setValue(rowInput('Опыт'), '12')
      await flush()
      saveBtn('Опыт').click()
      await flush()
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m_pending', { experience_years: 12 })
    })

    it('saveAccountName: sends BOTH first_name and last_name in one patch', async () => {
      vi.mocked(adminApi.editMasterProfile).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending')
      await flush()

      pencilBtn('Имя аккаунта').click()
      await flush()
      const [first, last] = rowInputs('Имя аккаунта')
      setValue(first!, 'Борис')
      setValue(last!, 'Петров')
      await flush()
      saveBtn('Имя аккаунта').click()
      await flush()

      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m_pending', {
        first_name: 'Борис',
        last_name: 'Петров',
      })
    })

    it('saveLanguages (list-valued, toggleDraft): toggling a chip sends the full updated list', async () => {
      vi.mocked(adminApi.editMasterProfile).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending') // languages: ['Русский']
      await flush()

      pencilBtn('Язык практик').click()
      await flush()
      chipByText(rowByKey('Язык практик'), 'English')?.click() // add
      await flush()
      saveBtn('Язык практик').click()
      await flush()

      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m_pending', {
        languages: ['Русский', 'English'],
      })
    })

    it('saveCertifications (list-valued, addCert + remove): add via Enter, remove via chip click', async () => {
      vi.mocked(adminApi.editMasterProfile).mockResolvedValue({ user_id: 'm_pending', status: 'ok' })
      mount('m_pending') // certifications: ['Сертификат йоги']
      await flush()

      pencilBtn('Сертификаты').click()
      await flush()

      const row = rowByKey('Сертификаты')
      const input = row.querySelector<HTMLInputElement>('.v-input__field')!
      setValue(input, 'Новый сертификат')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()

      // Remove the original by clicking its chip.
      chipByText(row, 'Сертификат йоги ✕')?.click()
      await flush()

      saveBtn('Сертификаты').click()
      await flush()

      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m_pending', {
        certifications: ['Новый сертификат'],
      })
    })
  })

  // ===========================================================================
  describe('FIXED: THREE fields now surface an error on a failed save (see banner)', () => {
    it('phone: a failed save shows the error text (shape A -- VInput :error, same as display_name/email/experience_years)', async () => {
      vi.mocked(adminApi.editMasterProfile).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      pencilBtn('Телефон').click()
      await flush()
      setValue(rowInput('Телефон'), '+70001112233')
      await flush()
      saveBtn('Телефон').click()
      await flush()

      expect(rowErrorText('Телефон')).toBe('Не удалось сохранить')
      expect(host?.querySelector('.mreview__edit')).not.toBeNull() // still stuck in edit mode
    })

    it('languages: a failed save shows the error text (shape B -- <p class="mreview__edit-err">, same as account_name/bio)', async () => {
      vi.mocked(adminApi.editMasterProfile).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      pencilBtn('Язык практик').click()
      await flush()
      chipByText(rowByKey('Язык практик'), 'English')?.click()
      await flush()
      saveBtn('Язык практик').click()
      await flush()

      expect(rowErrorText('Язык практик')).toBe('Не удалось сохранить')
    })

    it('certifications: a failed save shows the error text (shape B -- <p class="mreview__edit-err">, same as account_name/bio)', async () => {
      vi.mocked(adminApi.editMasterProfile).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      pencilBtn('Сертификаты').click()
      await flush()
      saveBtn('Сертификаты').click()
      await flush()

      expect(rowErrorText('Сертификаты')).toBe('Не удалось сохранить')
    })

    it('CONTRAST: bio DOES show the error paragraph on failure (the same fieldError, different row template)', async () => {
      vi.mocked(adminApi.editMasterProfile).mockRejectedValue(new Error('ECONNRESET'))
      mount('m_pending')
      await flush()

      pencilBtn('О себе').click()
      await flush()
      saveBtn('О себе').click()
      await flush()

      expect(rowErrorText('О себе')).toBe('Не удалось сохранить')
    })
  })

  // ===========================================================================
  describe('display fallbacks + hasParsedMethods (.vue:463-492)', () => {
    it('PLACEHOLDER "—" for empty display_name/email/phone/bio', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ display_name: null, email: null, phone: null, bio: null }),
      )
      mount('m_pending')
      await flush()

      expect(fieldValue('Имя-визитка')).toBe('—')
      expect(fieldValue('Email')).toBe('—')
      expect(fieldValue('Телефон')).toBe('—')
      expect(fieldValue('О себе')).toBe('—')
    })

    it('hasParsedMethods=true for a taxonomy-matching method: renders the readonly picker, not verbatim chips', async () => {
      mount('m_pending') // methods: ['Медитация'] -- matches the bare direction
      await flush()

      const row = rowByKey('Направления практик')
      // The readonly MethodTaxonomyPicker renders its own chip structure;
      // verbatim-fallback chips use `.mreview__chips` directly under `.mreview__v`.
      expect(row.querySelector('.mreview__v > .mreview__chips')).toBeNull()
    })

    // CORRECTED FROM AN INITIAL WRONG ASSUMPTION, measured directly (a
    // throwaway debug test against the REAL parseMethods/flattenMethods):
    // parseMethods surfaces an unmatched string as `customText`
    // (SURFACE-UNMATCHED, Q3=А), and flattenMethods RE-EMITS non-empty
    // customText -- so `hasParsedMethods` (.vue:478-480,
    // `flattenMethods(parseMethods(methods)).length > 0`) is TRUE even for a
    // FULLY unmatched/custom method, not just a taxonomy-matching one. A
    // REAL FINDING falls out of this: the screen's OWN verbatim
    // `.mreview__chips` fallback (.vue:223-225, `v-else-if="methods.length"`)
    // is therefore effectively DEAD for any methods array with real
    // (non-whitespace) content -- reachable only for a pathological array of
    // solely empty/whitespace strings (parseMethods discards those before
    // either counter sees them). Reported, not fixed here.
    it('an unmatched/custom method: hasParsedMethods is STILL true -- the readonly picker renders it via its OWN custom chip, not the screen\'s verbatim fallback', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ methods: ['Совершенно кастомный метод'] }),
      )
      mount('m_pending')
      await flush()

      const row = rowByKey('Направления практик')
      // The screen's OWN fallback never renders...
      expect(row.querySelector('.mreview__v > .mreview__chips')).toBeNull()
      // ...because the readonly MethodTaxonomyPicker renders instead, and
      // shows the custom text via ITS OWN chip (MethodTaxonomyPicker.vue:66-68).
      expect(text()).toContain('Совершенно кастомный метод')
    })

    it('empty methods: "—", no chips at all', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(master({ methods: [] }))
      mount('m_pending')
      await flush()

      expect(fieldValue('Направления практик')).toBe('—')
    })

    it('languageOptions = the fixed set + any custom language the master already has', async () => {
      vi.mocked(adminApi.getMasterById).mockResolvedValue(
        master({ languages: ['Deutsch'] }), // not in the fixed LANGUAGES set
      )
      mount('m_pending')
      await flush()

      pencilBtn('Язык практик').click()
      await flush()

      const row = rowByKey('Язык практик')
      expect(chipByText(row, 'Русский')).toBeDefined() // fixed set
      expect(chipByText(row, 'English')).toBeDefined() // fixed set
      expect(chipByText(row, 'Deutsch')).toBeDefined() // custom, preserved
    })
  })

  // ===========================================================================
  describe('documents/history stub (always empty -- honest skeleton)', () => {
    it('documents: always "Документы не приложены" (the ref is never populated anywhere in the script)', async () => {
      mount('m_pending')
      await flush()

      expect(text()).toContain('Документы не приложены')
    })

    it('history: opening the accordion shows "Заявка подаётся впервые" (the ref is never populated)', async () => {
      mount('m_pending')
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-accordion__header')?.click()
      await flush()

      expect(text()).toContain('Заявка подаётся впервые')
    })
  })
})
