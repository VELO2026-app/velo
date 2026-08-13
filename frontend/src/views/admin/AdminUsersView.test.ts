// =============================================================================
// VELO Frontend -- AdminUsersView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 327 lines. PATTERN = list-with-full-ladder + client-side pagination
// ("Показать ещё") + client-side search + a MUTATING action (make-master)
// behind a confirm dialog. NO store, confirmed by reading every import.
// Seams mocked: @/api/admin's getUsersList and makeMaster. ApiResponseError
// kept REAL (importOriginal) for realistic error-path tests. Router mocked
// for `back` only (this screen never pushes anywhere else).
//
// TELEPORT TRAP (SC-13), HANDLED: VConfirmDialog wraps VModal, which
// Teleports its overlay to document.body inside a Transition. A CLOSED
// overlay can survive app.unmount() (Vue awaits a transitionend happy-dom
// never fires) and poison the next test's document.body queries -- afterEach
// below purges `.v-modal__overlay` explicitly, same as EditProfileView.test.ts's
// precedent (its own banner has the full writeup).
//
// TWO GUARDS ON THIS SCREEN LOOKED LIKE THEY MIGHT BE THE STEPNEXT-STYLE DEAD
// CODE FROM №474 (a real button's native `disabled` blocking the click before
// the internal `if` guard could ever matter) -- CHECKED, NOT ASSUMED, and
// BOTH ARE ACTUALLY REACHABLE, unlike stepNext:
//   - doMakeMaster's reentrancy guard (`!confirm.target || confirm.loading`,
//     .vue:201): the confirm VButton's `disabled` prop IS wired to
//     `confirm.loading` (VConfirmDialog.vue:29, via its own `loading` prop),
//     so a SEPARATE, later click after the DOM has caught up would indeed be
//     blocked at the native level. But Vue's reactive-state write
//     (`confirm.loading = true`, synchronous, before doMakeMaster's first
//     await) and the DOM re-render that applies the `disabled` ATTRIBUTE
//     (scheduled on Vue's own microtask queue) are NOT the same instant --
//     firing a second `.click()` in the SAME synchronous burst, with no
//     `await` between the two calls (the identical no-tick idiom already
//     used for NotificationsView's per-key guard and LanguageTimezoneView's
//     saving guard), reaches the handler a second time before the disabled
//     attribute has been painted. The internal guard is what stops THAT.
//   - closeConfirm's guard (`if (confirm.loading) return`, .vue:195): same
//     reasoning, same no-tick technique -- click Confirm then immediately
//     (no await) click Cancel; Cancel's own `disabled` (VConfirmDialog.vue:24,
//     `:disabled="loading"`) hasn't been painted yet either.
// Both mutation-verified below (guard removed -> test goes red) BEFORE
// trusting the green baseline, per the honesty rule from №474 (a green
// mutation run gets investigated, not assumed to be a proof).
//
// No Cyrillic money on this screen. Fixtures/expected Cyrillic strings below
// were still typed via the Write tool, never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminUsersView from '@/views/admin/AdminUsersView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { UserResponse, AdminMasterActionResponse } from '@/api/admin'

vi.mock('@/api/admin')

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

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'u_1',
    telegram_id: 100,
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
    role_switch: null,
    ...overrides,
  }
}

const U_USER = user({
  id: 'u_user',
  first_name: 'Анна',
  last_name: 'Пользователева',
  telegram_id: 111,
  role: 'user',
})
const U_MASTER = user({
  id: 'u_master',
  first_name: 'Борис',
  last_name: 'Мастеров',
  telegram_id: 222,
  role: 'master',
})
const U_ADMIN = user({
  id: 'u_admin',
  first_name: 'Вера',
  last_name: 'Админова',
  telegram_id: 333,
  role: 'admin',
})
const U_NONAME = user({
  id: 'u_noname',
  first_name: null,
  last_name: null,
  telegram_id: null,
  role: 'user',
})

function paginated(items: UserResponse[], total?: number) {
  return { items, total: total ?? items.length, limit: 100, offset: 0 }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminUsersView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.ucard') ?? [])
}
function cardByName(name: string): HTMLElement | undefined {
  return cards().find((c) => c.querySelector('.ucard__name')?.textContent?.trim() === name)
}
function makeMasterBtn(card: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === 'Сделать мастером',
  )
}
function moreBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Показать ещё',
  )
}
function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}
function searchInput(): HTMLInputElement {
  const el = host?.querySelector<HTMLInputElement>('.v-input__field')
  if (!el) throw new Error('search input did not render')
  return el
}
function setValue(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

// Modal is teleported to document.body (SC-07) -- never query `host` for it.
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
function modalIsOpen(): boolean {
  const el = modalOverlay()
  return !!el && !el.classList.contains('v-modal-leave-active')
}
function modalText(): string {
  return modalOverlay()?.textContent ?? ''
}
function modalButtonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(modalOverlay()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getUsersList)
    .mockReset()
    .mockResolvedValue(paginated([U_USER, U_MASTER, U_ADMIN], 3))
  vi.mocked(adminApi.makeMaster).mockReset()

  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13 -- load-bearing (this screen genuinely opens VConfirmDialog).
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('AdminUsersView', () => {
  // ===========================================================================
  describe('ladder + recovery', () => {
    it('shows the loading spinner while the fetch is in flight, then content', async () => {
      let resolveList!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getUsersList)
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
      expect(cards()).toHaveLength(0)

      resolveList(paginated([U_USER], 1))
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('success: renders one card per user', async () => {
      mount()
      await flush()

      expect(cards()).toHaveLength(3)
    })

    it('empty list: shows "Пользователей пока нет"', async () => {
      vi.mocked(adminApi.getUsersList).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.admin-users__empty')?.textContent).toBe('Пользователей пока нет')
    })

    it('failure (generic error): shows the error rung and toasts the fallback message', async () => {
      vi.mocked(adminApi.getUsersList).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить пользователей',
      )
      expect(cards()).toHaveLength(0)
      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки пользователей')
    })

    it('failure (ApiResponseError): the toast carries the real backend detail', async () => {
      vi.mocked(adminApi.getUsersList).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Сервер недоступен')
    })

    it('"Повторить" calls load(true) and recovers from error to content', async () => {
      vi.mocked(adminApi.getUsersList).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty__title')).not.toBeNull()

      vi.mocked(adminApi.getUsersList).mockResolvedValue(paginated([U_USER], 1))
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(cards()).toHaveLength(1)
      expect(adminApi.getUsersList).toHaveBeenLastCalledWith(undefined, 100, 0)
    })
  })

  // ===========================================================================
  describe('THE ROLE SAFETY GATE (crown jewel, .vue:57)', () => {
    it('"Сделать мастером" renders ONLY on the role=user card, never master or admin', async () => {
      mount()
      await flush()

      expect(makeMasterBtn(cardByName('Анна Пользователева')!)).toBeDefined()
      expect(makeMasterBtn(cardByName('Борис Мастеров')!)).toBeUndefined()
      expect(makeMasterBtn(cardByName('Вера Админова')!)).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('confirm flow', () => {
    it("askMakeMaster opens the dialog with the user's name in the message", async () => {
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()

      expect(modalIsOpen()).toBe(true)
      expect(modalText()).toContain('Анна Пользователева')
    })

    it('success: makeMaster called with the id, toast.success, dialog closes, list re-fetches', async () => {
      vi.mocked(adminApi.makeMaster).mockResolvedValue({ user_id: 'u_user', status: 'ok' })
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()
      modalButtonByText('Назначить')?.click()
      await flush()

      expect(adminApi.makeMaster).toHaveBeenCalledWith('u_user')
      expect(toastSuccess).toHaveBeenCalledWith('Пользователь назначен мастером')
      expect(modalIsOpen()).toBe(false)
      // Re-fetch from scratch (offset 0) -- the LAST call, after the initial mount fetch.
      expect(adminApi.getUsersList).toHaveBeenLastCalledWith(undefined, 100, 0)
      expect(adminApi.getUsersList).toHaveBeenCalledTimes(2)
    })

    it('failure (ApiResponseError): toasts the real detail, dialog STAYS OPEN (deliberate, not fixed here)', async () => {
      vi.mocked(adminApi.makeMaster).mockRejectedValue(
        new ApiResponseError(409, 'Пользователь уже мастер', 'already_master'),
      )
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()
      modalButtonByText('Назначить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Пользователь уже мастер')
      // .vue:209-211 never resets confirm.open on the catch path -- asserted
      // as the real, intentional behaviour, not an oversight.
      expect(modalIsOpen()).toBe(true)
    })

    it('failure (non-ApiResponseError): falls back to the generic message, dialog still stays open', async () => {
      vi.mocked(adminApi.makeMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()
      modalButtonByText('Назначить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось назначить мастером')
      expect(modalIsOpen()).toBe(true)
    })

    it('a plain cancel (not loading) closes the dialog', async () => {
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()
      modalButtonByText('Отмена')?.click()
      await flush()

      expect(modalIsOpen()).toBe(false)
      expect(adminApi.makeMaster).not.toHaveBeenCalled()
    })

    it('closeConfirm guard: a cancel fired in the same tick as confirm (before loading paints) is ignored', async () => {
      let resolveMake!: (v: AdminMasterActionResponse) => void
      vi.mocked(adminApi.makeMaster)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveMake = resolve
            }),
        )
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()

      // No await between these two -- confirm.loading is already true
      // reactively, but the Cancel button's `disabled` attribute has not been
      // painted yet (Vue's DOM patch is scheduled, not synchronous).
      modalButtonByText('Назначить')?.click()
      modalButtonByText('Отмена')?.click()
      await flush()

      expect(modalIsOpen()).toBe(true) // the guard held -- still open, request still in flight

      resolveMake({ user_id: 'u_user', status: 'ok' })
      await flush()

      expect(modalIsOpen()).toBe(false) // resolves normally afterwards
    })

    it('doMakeMaster reentrancy guard: a second confirm click in the same tick makes no second API call', async () => {
      let resolveMake!: (v: AdminMasterActionResponse) => void
      vi.mocked(adminApi.makeMaster)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveMake = resolve
            }),
        )
      mount()
      await flush()

      makeMasterBtn(cardByName('Анна Пользователева')!)?.click()
      await flush()

      const confirmBtn = modalButtonByText('Назначить')!
      // No await between the two clicks -- same no-tick idiom as above.
      confirmBtn.click()
      confirmBtn.click()
      await flush()

      expect(adminApi.makeMaster).toHaveBeenCalledTimes(1)

      resolveMake({ user_id: 'u_user', status: 'ok' })
      await flush()
    })
  })

  // ===========================================================================
  describe('pagination (.vue:153-178)', () => {
    it('"Показать ещё" appends rows (does not replace) and requests offset = current length', async () => {
      vi.mocked(adminApi.getUsersList).mockResolvedValueOnce(paginated([U_USER], 3))
      mount()
      await flush()
      expect(cards()).toHaveLength(1)
      expect(moreBtn()).toBeDefined() // hasMore: 1 < 3

      vi.mocked(adminApi.getUsersList).mockResolvedValueOnce(paginated([U_MASTER, U_ADMIN], 3))
      moreBtn()?.click()
      await flush()

      expect(adminApi.getUsersList).toHaveBeenLastCalledWith(undefined, 100, 1)
      expect(cards()).toHaveLength(3) // accumulated, not replaced
      expect(cardByName('Анна Пользователева')).toBeDefined() // page 1 survived
    })

    it('hasMore is false once every user has been fetched: no "Показать ещё"', async () => {
      vi.mocked(adminApi.getUsersList).mockResolvedValue(paginated([U_USER, U_MASTER], 2))
      mount()
      await flush()

      expect(moreBtn()).toBeUndefined()
    })

    it('loadingMore reentrancy: a second "Показать ещё" click mid-flight makes no second call', async () => {
      vi.mocked(adminApi.getUsersList).mockResolvedValueOnce(paginated([U_USER], 3))
      mount()
      await flush()

      let resolvePage2!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getUsersList)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolvePage2 = resolve
            }),
        )
      const btn = moreBtn()!
      btn.click()
      btn.click() // same tick -- loadingMore is already true reactively
      await flush()

      expect(adminApi.getUsersList).toHaveBeenCalledTimes(1)

      resolvePage2(paginated([U_MASTER, U_ADMIN], 3))
      await flush()
    })
  })

  // ===========================================================================
  describe('client-side search (.vue:127-135)', () => {
    it('matches by (case-insensitive) name', async () => {
      mount()
      await flush()

      setValue(searchInput(), 'борис')
      await flush()

      expect(cards()).toHaveLength(1)
      expect(cardByName('Борис Мастеров')).toBeDefined()
    })

    it('matches by telegram id substring', async () => {
      mount()
      await flush()

      setValue(searchInput(), '333')
      await flush()

      expect(cards()).toHaveLength(1)
      expect(cardByName('Вера Админова')).toBeDefined()
    })

    it('a no-match query shows the empty rung with "Никого не найдено" (not the no-query text)', async () => {
      mount()
      await flush()

      setValue(searchInput(), 'zzz-no-such-user')
      await flush()

      expect(host?.querySelector('.admin-users__empty')?.textContent).toBe('Никого не найдено')
    })
  })

  // ===========================================================================
  describe('row rendering', () => {
    it('nameOf: first+last joined; "Без имени" when both are empty', async () => {
      vi.mocked(adminApi.getUsersList).mockResolvedValue(paginated([U_USER, U_NONAME], 2))
      mount()
      await flush()

      expect(cardByName('Анна Пользователева')).toBeDefined()
      expect(cardByName('Без имени')).toBeDefined()
    })

    it('telegram_id null renders "ID: —"', async () => {
      vi.mocked(adminApi.getUsersList).mockResolvedValue(paginated([U_NONAME], 1))
      mount()
      await flush()

      const card = cardByName('Без имени')!
      expect(card.querySelector('.ucard__tg')?.textContent).toBe('ID: —')
    })

    it('role label + badge variant: admin/master/user', async () => {
      mount()
      await flush()

      const adminBadge = cardByName('Вера Админова')!.querySelector('.v-badge')
      expect(adminBadge?.textContent?.trim()).toBe('Админ')
      expect(adminBadge?.classList.contains('v-badge--warning')).toBe(true)

      const masterBadge = cardByName('Борис Мастеров')!.querySelector('.v-badge')
      expect(masterBadge?.textContent?.trim()).toBe('Мастер')
      expect(masterBadge?.classList.contains('v-badge--success')).toBe(true)

      const userBadge = cardByName('Анна Пользователева')!.querySelector('.v-badge')
      expect(userBadge?.textContent?.trim()).toBe('Пользователь')
      expect(userBadge?.classList.contains('v-badge--info')).toBe(true)
    })
  })
})
