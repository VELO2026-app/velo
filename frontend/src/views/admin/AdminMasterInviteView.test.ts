// =============================================================================
// VELO Frontend -- AdminMasterInviteView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 151 lines. A single mutating action (inviteMaster) + a clipboard-copy
// button. No store, no ladder in the generic list/detail sense -- just a
// form-card that always renders, plus a result-card gated on `inviteLink`.
//
// FIXED in №487 -- root cause + before/after (same discipline as №468/№478/
// №481/№483): `onCreate` (.vue:66-79) was described in №486's prompt as
// "guarded by `creating`", but reading the function body showed there was NO
// `if (creating.value) return` at all -- `creating.value = true` was set
// UNCONDITIONALLY at the top, with no re-entrancy check before it:
//   BEFORE:  async function onCreate(): Promise<void> {
//              creating.value = true
//              try { ... } finally { creating.value = false }
//            }
//   AFTER:   async function onCreate(): Promise<void> {
//              if (creating.value) return
//              creating.value = true
//              try { ... } finally { creating.value = false }
//            }
// Before the fix, the ONLY thing standing between a double-click and a
// double `inviteMaster` call was VButton's OWN `:disabled="disabled ||
// loading"` binding (VButton.vue:27) reacting to `:loading="creating"`
// (.vue:35) -- a template binding, not a handler guard, and Vue's reactive
// DOM update is microtask-batched, not synchronous, so a SAME-TICK double
// click (no `await` between the two `.click()` calls) reached `onCreate`
// twice before that `disabled` attribute had painted -- this is a plain
// double-tap on ONE button, not a two-button latent race, so a human hits
// it. Consequence: two one-time invite links minted instead of one (an
// extra live invite left in the wild). Modeled on the sibling in the SAME
// BATCH that already had the guard right, AdminParticipantsView.load
// (.vue:115, `if (loading.value) return`). The `:disabled`/`:loading`
// binding is UNCHANGED -- same reasoning as №481/№483b, it is real UX
// feedback, not a redundant guard layer; the two tests below now cover BOTH
// layers on purpose, not by accident.
//
// THE LINK ONLY APPEARS AFTER A SUCCESSFUL CREATE: `<VCard v-if="inviteLink">`
// (.vue:43) -- `inviteLink` starts `''` (falsy) and is only ever assigned
// inside the try block's success path (.vue:70), never touched in catch.
// Asserted directly: absent before create, absent after a FAILED create,
// present only after success.
//
// THE CLIPBOARD TRAP (operator-flagged, confirmed real): `onCopy` (.vue:
// 81-88) calls `navigator.clipboard.writeText`, which happy-dom does not
// implement by default -- calling it unstubbed throws
// "navigator.clipboard is undefined", which would make the REJECTION branch
// impossible to reach honestly (a thrown-because-missing-API error is not
// the same test as a genuine write failure). Stubbed via
// `Object.defineProperty(navigator, 'clipboard', {configurable: true,
// writable: true, value: {writeText}})` in `beforeEach` (same technique as
// this repo's existing MasterPromocodesView.test.ts precedent), with
// `writeText` a fresh `vi.fn()` per test so both the resolve AND reject
// paths are independently controllable -- and explicitly deleted in
// `afterEach` to restore happy-dom's undefined-clipboard baseline for any
// test file that runs after this one.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminMasterInviteView from '@/views/admin/AdminMasterInviteView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { InviteMasterResponse } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function inviteResponse(overrides: Partial<InviteMasterResponse> = {}): InviteMasterResponse {
  return {
    invite_link: 'https://t.me/velo_bot?start=invite_abc123',
    issued_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let writeText: ReturnType<typeof vi.fn>

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminMasterInviteView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function buttonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function createBtn(): HTMLButtonElement {
  const b = buttonByText('Создать ссылку')
  if (!b) throw new Error('«Создать ссылку» did not render')
  return b
}
function copyBtn(): HTMLButtonElement | undefined {
  return buttonByText('Скопировать')
}
function linkText(): string {
  return host?.querySelector('.invite__link')?.textContent?.trim() ?? ''
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.inviteMaster).mockReset().mockResolvedValue(inviteResponse())

  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()

  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: { writeText },
  })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  delete (navigator as unknown as { clipboard?: unknown }).clipboard
  vi.clearAllMocks()
})

describe('AdminMasterInviteView', () => {
  // ===========================================================================
  describe('onCreate (.vue:66-78) -- the link only appears after success', () => {
    it('no result card before any create', async () => {
      mount()
      await flush()

      expect(host?.querySelector('.invite__link')).toBeNull()
    })

    it('success: fills inviteLink, result card renders with the exact link', async () => {
      mount()
      await flush()

      createBtn().click()
      await flush()

      expect(linkText()).toBe('https://t.me/velo_bot?start=invite_abc123')
    })

    it('failure (generic Error): toasts the fallback, NO result card', async () => {
      vi.mocked(adminApi.inviteMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      createBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось создать ссылку')
      expect(host?.querySelector('.invite__link')).toBeNull()
    })

    it('failure (bot_url_not_configured): toasts a human message, NOT the raw backend detail', async () => {
      // ПРОМТ №523: the raw detail ("telegram_bot_url is not configured") is a
      // server misconfiguration string, not something an admin can act on --
      // this code now gets its own human Russian message (BookingPopup.vue's
      // e.code hand-branch pattern). 503 status and the code itself are
      // test-pinned server-side and unchanged here.
      vi.mocked(adminApi.inviteMaster).mockRejectedValue(
        new ApiResponseError(503, 'telegram_bot_url is not configured', 'bot_url_not_configured'),
      )
      mount()
      await flush()

      createBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith(
        'Ссылки для приглашений временно недоступны. Сообщите в поддержку.',
      )
    })

    it('failure (ApiResponseError, unrecognized code): falls back to the real backend detail', async () => {
      vi.mocked(adminApi.inviteMaster).mockRejectedValue(
        new ApiResponseError(500, 'Что-то пошло не так', 'internal_error'),
      )
      mount()
      await flush()

      createBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Что-то пошло не так')
    })

    it('re-generating replaces the result card in place with a NEW link', async () => {
      mount()
      await flush()
      createBtn().click()
      await flush()
      expect(linkText()).toBe('https://t.me/velo_bot?start=invite_abc123')

      vi.mocked(adminApi.inviteMaster).mockResolvedValueOnce(
        inviteResponse({ invite_link: 'https://t.me/velo_bot?start=invite_xyz789' }),
      )
      createBtn().click()
      await flush()

      expect(linkText()).toBe('https://t.me/velo_bot?start=invite_xyz789')
    })

    it('while creating, VButton shows its own :loading state (spinner + real disabled attribute)', async () => {
      let resolveCreate!: (v: InviteMasterResponse) => void
      vi.mocked(adminApi.inviteMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve
          }),
      )
      mount()
      await flush()

      createBtn().click()
      await flush() // let :loading="creating" paint

      expect(createBtn().disabled).toBe(true)
      expect(createBtn().classList.contains('v-btn--loading')).toBe(true)

      resolveCreate(inviteResponse())
      await flush()
      expect(createBtn().disabled).toBe(false)
    })

    it('REALISTIC interaction: once :disabled has painted, a second click on the real <button> is a no-op', async () => {
      let resolveCreate!: (v: InviteMasterResponse) => void
      vi.mocked(adminApi.inviteMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve
          }),
      )
      mount()
      await flush()

      createBtn().click()
      await flush() // disabled attribute paints
      createBtn().click() // a real click on a disabled <button> does not fire

      expect(adminApi.inviteMaster).toHaveBeenCalledTimes(1)
      resolveCreate(inviteResponse())
      await flush()
    })

    it('FIXED: a same-tick double click is now blocked at the handler layer -- inviteMaster is called ONCE', async () => {
      let resolveCreate!: (v: InviteMasterResponse) => void
      vi.mocked(adminApi.inviteMaster).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve
          }),
      )
      mount()
      await flush()

      const btn = createBtn()
      btn.click()
      btn.click() // no await -- the disabled attribute has not painted yet
      await flush()

      expect(adminApi.inviteMaster).toHaveBeenCalledTimes(1)
      resolveCreate(inviteResponse())
      await flush()
    })
  })

  // ===========================================================================
  describe('onCopy (.vue:81-88) -- the clipboard trap, both branches (see banner)', () => {
    it('success: writes the exact inviteLink, toasts success', async () => {
      mount()
      await flush()
      createBtn().click()
      await flush()

      copyBtn()?.click()
      await flush()

      expect(writeText).toHaveBeenCalledWith('https://t.me/velo_bot?start=invite_abc123')
      expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
    })

    it('a clipboard rejection surfaces as an error, not a false success', async () => {
      writeText.mockRejectedValue(new Error('denied'))
      mount()
      await flush()
      createBtn().click()
      await flush()

      copyBtn()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось скопировать')
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })
})
