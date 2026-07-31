// =============================================================================
// VELO Frontend -- AdminPromosView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// Every master's promo codes plus VELO's own, with admin deactivation. Money:
// a master promo is absorbed from the MASTER's revenue while a company promo is
// absorbed by VELO (generated.ts:161) -- so mislabelling an owner, or failing to
// kill a code the admin deactivated, keeps discounting someone's real money.
//
// PATTERN B (local-ref): items/loading/error/hasMore are refs fed by a direct
// getAdminPromos() in onMounted + a watch on `filter` (AdminPromosView.vue:143-263).
// No store, so no pinia -- the seam is @/api/admin.
//
// THE TABS ARE SERVER-SIDE FILTERS, NOT CLIENT-SIDE (AdminPromosView.vue:159-167).
// So the assertions are about the PARAMS the screen sends, not about which rows
// it hides -- asserting a client-side filter here would be testing a layer this
// screen deliberately does not have.
//
// VConfirmDialog wraps VModal, which is `Teleport to="body"` (VModal.vue:20), so
// the dialog is queried from document.body (SC-07) and reaped in afterEach (it
// leaks past unmount -- see the note there).
//
// No time pinning needed: valid_until is formatted from fixture data and
// formatShortDate pins timeZone='UTC' itself (utils/format.ts:118).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminPromosView from '@/views/admin/AdminPromosView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminPromoResponse } from '@/api/admin'

vi.mock('@/api/admin')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function promo(id: string, overrides: Partial<AdminPromoResponse> = {}): AdminPromoResponse {
  return {
    id,
    code: `CODE${id}`,
    type: 'master',
    master_id: 'master_1',
    practice_id: null,
    discount_percent: 20,
    max_uses: 10,
    used_count: 3,
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: null,
    first_purchase_only: false,
    is_active: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    master_first_name: 'Анна',
    master_last_name: 'Петрова',
    ...overrides,
  }
}

function page(items: AdminPromoResponse[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminPromosView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.pcard') ?? [])
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

function tab(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment__item') ?? []).find((b) =>
    b.textContent?.includes(label),
  )
}

// The confirm dialog is teleported to body (VModal.vue:20), not under host --
// and a CLOSED one leaks (see afterEach), so a reopened dialog is the LAST
// match in document order, not the first. Taking the first would click a dead
// node from the previous open and silently do nothing.
function dialogButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('.v-confirm__actions button'))
    .filter((b) => b.textContent?.includes(label))
    .pop() as HTMLButtonElement | undefined
}

function dialogText(): string {
  return [...document.body.querySelectorAll('.v-confirm__text')].pop()?.textContent ?? ''
}

beforeEach(() => {
  vi.mocked(adminApi.getAdminPromos).mockReset().mockResolvedValue(page([]))
  vi.mocked(adminApi.deactivateAdminPromo).mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // MANDATORY -- a closed teleported modal leaks past unmount (the <Transition>
  // leave never completes in happy-dom), and the next test then clicks the DEAD
  // dialog and silently does nothing. Same trap as
  // AdminWithdrawalDetailView.test.ts; see the report.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('AdminPromosView', () => {
  describe('state ladder', () => {
    it('shows the loader while the first page is in flight', async () => {
      vi.mocked(adminApi.getAdminPromos).mockReturnValue(
        new Promise(() => {}) as Promise<ReturnType<typeof page>>,
      )
      mount()
      await flush()

      expect(host?.querySelector('.admin-promos__loader')).not.toBeNull()
    })

    it('error: shows the error state AND toasts the REAL backend detail', async () => {
      vi.mocked(adminApi.getAdminPromos).mockRejectedValue(
        new ApiResponseError(503, 'База промокодов недоступна', 'db_down'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить промокоды')
      expect(toastError).toHaveBeenCalledWith('База промокодов недоступна')
    })

    it('error: falls back to a generic toast on a non-API error', async () => {
      vi.mocked(adminApi.getAdminPromos).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки промокодов')
    })

    it('error retry: the «Повторить» button RENDERS and re-fetches', async () => {
      // REGRESSION GUARD (T8, find from PROMPT №432, fixed in №433).
      // Same defect as AdminWithdrawalsView: this screen passes its retry button
      // through `<template #action>` (AdminPromosView.vue:42-44), a slot
      // VEmptyState did not declare -- so Vue dropped it silently and the admin
      // got an error card with nothing to click. VEmptyState now declares
      // `action` (VEmptyState.vue:~40).
      vi.mocked(adminApi.getAdminPromos).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить промокоды')
      const retry = button('Повторить')
      expect(retry).toBeDefined()

      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1', { code: 'BACK' })]))
      retry?.click()
      await flush()

      expect(text()).toContain('BACK')
      expect(text()).not.toContain('Не удалось загрузить промокоды')
    })

    it('empty: shows the empty state when there are no promos at all', async () => {
      mount()
      await flush()

      expect(text()).toContain('Промокодов пока нет')
      expect(cards()).toHaveLength(0)
    })

    it('content: renders a card per promo the API returned', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1'), promo('p2')]))
      mount()
      await flush()

      expect(cards()).toHaveLength(2)
    })

    it('the header count is the API total, not the loaded page size', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')], 42))
      mount()
      await flush()

      expect(host?.querySelector('.admin-promos__count')?.textContent?.trim()).toBe('42')
    })

    it('the header count is «—» when nothing loaded, not «0»', async () => {
      vi.mocked(adminApi.getAdminPromos).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(host?.querySelector('.admin-promos__count')?.textContent?.trim()).toBe('—')
    })
  })

  describe('card content', () => {
    it('renders the code, discount and usage from the API', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([
          promo('p1', { code: 'SUMMER25', discount_percent: 25, used_count: 4, max_uses: 10 }),
        ]),
      )
      mount()
      await flush()

      expect(text()).toContain('SUMMER25')
      expect(text()).toContain('Скидка: 25%')
      expect(text()).toContain('Использовано: 4 из 10')
    })

    it('an unlimited promo shows ∞, not a bogus cap', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { max_uses: null, used_count: 4 })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Использовано: 4 из ∞')
    })

    it('a promo with no end date shows «бессрочно»', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { valid_until: null })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Действует до: бессрочно')
    })

    it('a dated promo shows the formatted end date', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { valid_until: '2026-08-15T00:00:00Z' })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Действует до: 15 авг.')
    })
  })

  describe('owner attribution (whose money the discount comes out of)', () => {
    it('a master promo names the master and is labelled «Мастер»', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([
          promo('p1', { type: 'master', master_first_name: 'Анна', master_last_name: 'Петрова' }),
        ]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.pcard__owner-label')?.textContent?.trim()).toBe('Мастер')
      expect(host?.querySelector('.pcard__owner-name')?.textContent?.trim()).toBe('Анна Петрова')
    })

    it('a company promo is «VELO», ignoring any name fields', async () => {
      // Company promos come back with master_id=null and both name parts null
      // (generated.ts:161). Labelling one as a master's would blame a master for
      // a discount VELO is paying for.
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([
          promo('p1', {
            type: 'company',
            master_id: null,
            master_first_name: null,
            master_last_name: null,
          }),
        ]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.pcard__owner-label')?.textContent?.trim()).toBe('Компания')
      expect(host?.querySelector('.pcard__owner-name')?.textContent?.trim()).toBe('VELO')
    })

    it('a master with only a first name renders just that, with no stray space', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { master_first_name: 'Анна', master_last_name: null })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.pcard__owner-name')?.textContent?.trim()).toBe('Анна')
    })

    it('a nameless master falls back to «Пользователь», not to a blank', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { master_first_name: null, master_last_name: null })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.pcard__owner-name')?.textContent?.trim()).toBe('Пользователь')
    })
  })

  describe('active badge', () => {
    it('an active promo is badged «Активен» and offers the deactivate button', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1', { is_active: true })]))
      mount()
      await flush()

      expect(text()).toContain('Активен')
      expect(button('Деактивировать')).toBeDefined()
      expect(cards()[0]?.className).not.toContain('pcard--inactive')
    })

    it('a deactivated promo is badged and offers NO button -- it is already dead', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { is_active: false })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Деактивирован')
      expect(button('Деактивировать')).toBeUndefined()
      expect(cards()[0]?.className).toContain('pcard--inactive')
    })
  })

  describe('tab filters are SERVER-side params', () => {
    it('«Все» sends no filter at all', async () => {
      mount()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenCalledWith(undefined, undefined, 20, 0)
    })

    it('«Мастеров» filters by type=master', async () => {
      mount()
      await flush()

      tab('Мастеров')?.click()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith('master', undefined, 20, 0)
    })

    it('«Компании» filters by type=company', async () => {
      mount()
      await flush()

      tab('Компании')?.click()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith('company', undefined, 20, 0)
    })

    it('«Деактивир.» filters by is_active=false, NOT by a type', async () => {
      // currentParams returns { isActive: false } with no type
      // (AdminPromosView.vue:165) -- sending a type here would hide half the
      // deactivated codes.
      mount()
      await flush()

      tab('Деактивир.')?.click()
      await flush()

      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith(undefined, false, 20, 0)
    })

    it("switching tabs clears the previous tab's rows before the new ones land", async () => {
      // loadInitial resets items/total/hasMore up front (AdminPromosView.vue:192-194).
      // Without that, company promos would flash under the «Мастеров» tab.
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1', { code: 'FIRST' })]))
      mount()
      await flush()
      expect(text()).toContain('FIRST')

      vi.mocked(adminApi.getAdminPromos).mockReturnValue(
        new Promise(() => {}) as Promise<ReturnType<typeof page>>,
      )
      tab('Компании')?.click()
      await flush()

      expect(text()).not.toContain('FIRST')
      expect(cards()).toHaveLength(0)
    })

    it('each tab has its OWN empty copy, so an empty tab is not read as an empty app', async () => {
      mount()
      await flush()
      expect(text()).toContain('Промокодов пока нет')

      tab('Мастеров')?.click()
      await flush()
      expect(text()).toContain('Нет промокодов мастеров')

      tab('Компании')?.click()
      await flush()
      expect(text()).toContain('Нет промокодов компании')

      tab('Деактивир.')?.click()
      await flush()
      expect(text()).toContain('Нет деактивированных промокодов')
    })

    it('a STALE tab response is discarded rather than painted over the current tab', async () => {
      // The generation counter (AdminPromosView.vue:186-198). On a rapid switch
      // the first tab's response can land last; without the guard it would
      // overwrite the tab the admin is actually looking at.
      let resolveFirst!: (v: ReturnType<typeof page>) => void
      vi.mocked(adminApi.getAdminPromos).mockReturnValueOnce(
        new Promise<ReturnType<typeof page>>((r) => {
          resolveFirst = r
        }),
      )
      mount()
      await flush()

      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p2', { code: 'SECOND' })]))
      tab('Компании')?.click()
      await flush()
      expect(text()).toContain('SECOND')

      // The abandoned first request finally answers -- it must be ignored.
      resolveFirst(page([promo('p1', { code: 'STALE' })]))
      await flush()

      expect(text()).toContain('SECOND')
      expect(text()).not.toContain('STALE')
    })
  })

  describe('load more', () => {
    it('offers «Показать ещё» only while the loaded count is short of the total', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')], 5))
      mount()
      await flush()

      expect(button('Показать ещё')).toBeDefined()
    })

    it('hides «Показать ещё» once everything is loaded', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')], 1))
      mount()
      await flush()

      expect(button('Показать ещё')).toBeUndefined()
    })

    it('load-more APPENDS, pages from the loaded count, and KEEPS the tab filter', async () => {
      // currentParams() is re-read inside loadMore (AdminPromosView.vue:215) --
      // dropping the filter on page 2 would mix other masters' codes in.
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')], 2))
      mount()
      await flush()
      tab('Мастеров')?.click()
      await flush()

      vi.mocked(adminApi.getAdminPromos).mockResolvedValue({
        items: [promo('p2')],
        total: 2,
        limit: 20,
        offset: 1,
      })
      button('Показать ещё')?.click()
      await flush()

      expect(cards()).toHaveLength(2)
      expect(adminApi.getAdminPromos).toHaveBeenLastCalledWith('master', undefined, 20, 1)
    })

    it('a load-more failure keeps the loaded rows and toasts', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')], 5))
      mount()
      await flush()

      vi.mocked(adminApi.getAdminPromos).mockRejectedValue(new TypeError('boom'))
      button('Показать ещё')?.click()
      await flush()

      expect(cards()).toHaveLength(1)
      expect(text()).not.toContain('Не удалось загрузить промокоды')
      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки')
    })
  })

  describe('deactivate', () => {
    it('«Деактивировать» asks first -- it does NOT deactivate on the first click', async () => {
      // Killing a live promo is irreversible (there is no re-activate endpoint).
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1', { code: 'SUMMER' })]))
      mount()
      await flush()

      button('Деактивировать')?.click()
      await flush()

      expect(adminApi.deactivateAdminPromo).not.toHaveBeenCalled()
      expect(dialogText()).toContain('SUMMER')
      expect(dialogText()).toContain('больше не смогут им воспользоваться')
    })

    it('cancelling the dialog deactivates NOTHING', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')]))
      mount()
      await flush()
      button('Деактивировать')?.click()
      await flush()

      dialogButton('Отмена')?.click()
      await flush()

      expect(adminApi.deactivateAdminPromo).not.toHaveBeenCalled()
      expect(text()).toContain('Активен')
    })

    it('confirming deactivates THAT promo by id and flips its badge in place', async () => {
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(
        page([promo('p1', { code: 'FIRST' }), promo('p2', { code: 'SECOND' })]),
      )
      vi.mocked(adminApi.deactivateAdminPromo).mockResolvedValue(
        promo('p2', { is_active: false }) as never,
      )
      mount()
      await flush()

      // The SECOND card's button -- the id must follow the card, not the list head.
      const secondBtn = Array.from(cards()[1]?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('Деактивировать'),
      )
      secondBtn?.click()
      await flush()
      dialogButton('Деактивировать')?.click()
      await flush()

      expect(adminApi.deactivateAdminPromo).toHaveBeenCalledWith('p2')
      expect(toastSuccess).toHaveBeenCalledWith('Промокод деактивирован')
      // Flipped in place, not removed: the row stays, the badge changes.
      expect(cards()).toHaveLength(2)
      expect(cards()[1]?.className).toContain('pcard--inactive')
      expect(cards()[0]?.className).not.toContain('pcard--inactive')
    })

    it('a FAILED deactivate leaves the promo ACTIVE -- it is still live on the backend', async () => {
      // is_active is only flipped after the await succeeds (AdminPromosView.vue:246-248).
      // An optimistic flip would tell the admin a code is dead while it keeps
      // discounting every purchase.
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')]))
      vi.mocked(adminApi.deactivateAdminPromo).mockRejectedValue(
        new ApiResponseError(409, 'Промокод уже деактивирован', 'already'),
      )
      mount()
      await flush()
      button('Деактивировать')?.click()
      await flush()
      dialogButton('Деактивировать')?.click()
      await flush()

      expect(text()).toContain('Активен')
      expect(cards()[0]?.className).not.toContain('pcard--inactive')
      expect(toastError).toHaveBeenCalledWith('Промокод уже деактивирован')
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('a failure releases the in-flight lock, so the admin can try again', async () => {
      // `finally` clears deactivatingId AND confirmTarget (AdminPromosView.vue:256-259).
      // If either stuck, the re-entry guard at :243 would swallow every later
      // attempt and the promo could never be killed.
      //
      // NOTE: "the dialog visually closed" is deliberately NOT asserted -- a
      // closed teleported modal leaks in happy-dom (see afterEach), so its
      // absence is not observable here. This asserts the state that actually
      // matters instead: a second attempt genuinely reaches the API.
      vi.mocked(adminApi.getAdminPromos).mockResolvedValue(page([promo('p1')]))
      vi.mocked(adminApi.deactivateAdminPromo).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      button('Деактивировать')?.click()
      await flush()
      dialogButton('Деактивировать')?.click()
      await flush()
      expect(toastError).toHaveBeenCalledWith('Не удалось деактивировать промокод')

      vi.mocked(adminApi.deactivateAdminPromo).mockResolvedValue(
        promo('p1', { is_active: false }) as never,
      )
      button('Деактивировать')?.click()
      await flush()
      dialogButton('Деактивировать')?.click()
      await flush()

      expect(adminApi.deactivateAdminPromo).toHaveBeenCalledTimes(2)
      expect(toastSuccess).toHaveBeenCalledWith('Промокод деактивирован')
      expect(cards()[0]?.className).toContain('pcard--inactive')
    })
  })

  describe('navigation', () => {
    it('the back button goes back', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.admin-promos__top button')?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })
  })
})
