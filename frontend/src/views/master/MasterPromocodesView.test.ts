// =============================================================================
// VELO Frontend -- MasterPromocodesView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// A master's promo codes. Money-adjacent by construction: the master ABSORBS
// the discount out of their own revenue (generated.ts:427, CreateMasterPromoRequest
// docstring), so a wrong percent or a code that survives "Удалить" costs the
// master real money on every redemption.
//
// PATTERN B (local-ref): promos/loading/error/deactivatingId are refs in the
// component, fed by a direct getMyPromos() in onMounted
// (MasterPromocodesView.vue:92-110,146). No store, so NO pinia -- the seam is
// @/api/promos, the module the screen itself imports.
//
// Honest scope note on the error rung: `catch { error.value = true }`
// (MasterPromocodesView.vue:105) SWALLOWS the backend message and the template
// hardcodes the title. So the error test proves the screen's own copy reaches
// the DOM; it deliberately does NOT claim the backend message surfaces -- it
// cannot. (Same shape as MasterStudentsView; contrast MyBookingsView, which
// binds :description="store.error" and does surface it.)
//
// navigator.clipboard does not exist in happy-dom -- it is defined per test.
// No time pinning needed: the screen formats valid_until from fixture data
// (formatShortDate pins timezone='UTC' itself), and reads no clock of its own.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterPromocodesView from '@/views/master/MasterPromocodesView.vue'
import * as promosApi from '@/api/promos'
import type { PromoResponse } from '@/api/types'

vi.mock('@/api/promos')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function promo(id: string, overrides: Partial<PromoResponse> = {}): PromoResponse {
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
    ...overrides,
  }
}

function page(items: PromoResponse[]) {
  return { items, total: items.length, limit: 50, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null
let writeText: ReturnType<typeof vi.fn>

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterPromocodesView)
  app.mount(host)
  return host
}

// onMounted(load) awaits getMyPromos() -- mount tick, promise continuation,
// re-render (velo-idiom §3).
async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function items(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.promo__item') ?? [])
}

function codes(): string[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.promo__code') ?? []).map(
    (el) => el.textContent?.trim() ?? '',
  )
}

function buttonIn(root: HTMLElement | undefined, label: string): HTMLButtonElement | undefined {
  return Array.from(root?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

function button(label: string): HTMLButtonElement | undefined {
  return buttonIn(host ?? undefined, label)
}

beforeEach(() => {
  vi.mocked(promosApi.getMyPromos).mockReset().mockResolvedValue(page([]))
  vi.mocked(promosApi.deactivatePromo).mockReset()
  push.mockReset()
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
  vi.clearAllMocks()
})

describe('MasterPromocodesView', () => {
  describe('state ladder', () => {
    it('shows the loader while the first fetch is in flight', async () => {
      vi.mocked(promosApi.getMyPromos).mockReturnValue(
        new Promise(() => {}) as Promise<ReturnType<typeof page>>,
      )
      mount()
      await flush()

      expect(host?.querySelector('.promo__loader')).not.toBeNull()
      expect(text()).not.toContain('Промокодов пока нет')
    })

    it('on failure: shows the error state with the screen fallback copy', async () => {
      vi.mocked(promosApi.getMyPromos).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить промокоды')
      // The screen's own constant. Its bare `catch {}` (MasterPromocodesView.vue:105)
      // discards the rejection, so asserting 'boom' here would be a lie.
      expect(text()).not.toContain('boom')
    })

    it('error retry: «Повторить» re-runs the fetch and recovers into content', async () => {
      vi.mocked(promosApi.getMyPromos).mockRejectedValueOnce(new Error('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить промокоды')

      vi.mocked(promosApi.getMyPromos).mockResolvedValue(page([promo('p1', { code: 'SUMMER20' })]))
      button('Повторить')?.click()
      await flush()

      expect(text()).toContain('SUMMER20')
      expect(text()).not.toContain('Не удалось загрузить промокоды')
    })

    it('empty: shows the empty state when the master has no promos', async () => {
      mount()
      await flush()

      expect(text()).toContain('Промокодов пока нет')
      expect(host?.querySelector('.promo__loader')).toBeNull()
    })

    it('content: renders the code, its discount and its usage from the API', async () => {
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([
          promo('p1', { code: 'SUMMER20', discount_percent: 25, used_count: 4, max_uses: 10 }),
        ]),
      )
      mount()
      await flush()

      expect(text()).toContain('SUMMER20')
      expect(text()).toContain('Скидка: 25%')
      expect(text()).toContain('Использовано: 4 из 10')
      expect(items()).toHaveLength(1)
    })
  })

  describe('labels', () => {
    it('an unlimited promo shows ∞ rather than a bogus cap', async () => {
      // usedLabel falls back to '∞' on a null max_uses (MasterPromocodesView.vue:113).
      // Printing "4 из 0" or "4 из null" would read as an exhausted code.
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([promo('p1', { max_uses: null, used_count: 4 })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Использовано: 4 из ∞')
    })

    it('a promo with no end date shows «бессрочно»', async () => {
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(page([promo('p1', { valid_until: null })]))
      mount()
      await flush()

      expect(text()).toContain('Действует до: бессрочно')
    })

    it('a dated promo shows the formatted end date', async () => {
      // formatShortDate pins timeZone='UTC' internally (utils/format.ts:118-129),
      // so this cannot drift with the runner's local zone.
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([promo('p1', { valid_until: '2026-08-15T00:00:00Z' })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Действует до: 15 авг.')
    })
  })

  describe('active filter (MasterPromocodesView.vue:97)', () => {
    it('renders only active promos and hides deactivated ones', async () => {
      // The backend has no hard delete -- it returns deactivated codes too. If
      // the filter broke, a master would see codes they already killed and could
      // hand them out again.
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([
          promo('p1', { code: 'LIVE', is_active: true }),
          promo('p2', { code: 'DEAD', is_active: false }),
        ]),
      )
      mount()
      await flush()

      expect(codes()).toEqual(['LIVE'])
      expect(text()).not.toContain('DEAD')
    })

    it('a page of only-deactivated promos reads as empty, not as content', async () => {
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([promo('p1', { is_active: false }), promo('p2', { is_active: false })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Промокодов пока нет')
      expect(items()).toHaveLength(0)
    })
  })

  describe('deactivate', () => {
    it('«Удалить» soft-deactivates by id and drops the code from the list', async () => {
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([promo('p1', { code: 'LIVE' }), promo('p2', { code: 'OTHER' })]),
      )
      vi.mocked(promosApi.deactivatePromo).mockResolvedValue(promo('p1', { is_active: false }))
      mount()
      await flush()

      buttonIn(items()[0], 'Удалить')?.click()
      await flush()

      expect(promosApi.deactivatePromo).toHaveBeenCalledWith('p1')
      expect(codes()).toEqual(['OTHER'])
      expect(toastSuccess).toHaveBeenCalledWith('Промокод деактивирован')
    })

    it('a FAILED deactivate leaves the code visible -- it is still live on the backend', async () => {
      // MasterPromocodesView.vue:132-144 only flips is_active INSIDE the try,
      // after the await. Optimistically hiding it would tell a master a code is
      // dead while it still discounts every purchase that uses it.
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(page([promo('p1', { code: 'LIVE' })]))
      vi.mocked(promosApi.deactivatePromo).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      buttonIn(items()[0], 'Удалить')?.click()
      await flush()

      expect(codes()).toEqual(['LIVE'])
      expect(toastError).toHaveBeenCalledWith('Не удалось деактивировать промокод')
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('does not fire a second deactivate while one is in flight', async () => {
      // The deactivatingId re-entry guard (MasterPromocodesView.vue:133).
      let resolve!: (v: PromoResponse) => void
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([promo('p1', { code: 'LIVE' }), promo('p2', { code: 'OTHER' })]),
      )
      vi.mocked(promosApi.deactivatePromo).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()

      buttonIn(items()[0], 'Удалить')?.click()
      await nextTick()
      // A DIFFERENT promo -- the guard is global (any id in flight), not per-row.
      buttonIn(items()[1], 'Удалить')?.click()
      await nextTick()

      expect(promosApi.deactivatePromo).toHaveBeenCalledTimes(1)
      expect(promosApi.deactivatePromo).toHaveBeenCalledWith('p1')

      resolve(promo('p1', { is_active: false }))
      await flush()
    })
  })

  describe('copy', () => {
    it("«Копировать» writes THAT row's code to the clipboard", async () => {
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(
        page([promo('p1', { code: 'FIRST' }), promo('p2', { code: 'SECOND' })]),
      )
      mount()
      await flush()

      buttonIn(items()[1], 'Копировать')?.click()
      await flush()

      expect(writeText).toHaveBeenCalledWith('SECOND')
      expect(toastSuccess).toHaveBeenCalledWith('Промокод скопирован')
    })

    it('a clipboard rejection surfaces as an error, not a false success', async () => {
      // Telling a master the code is copied when it is not means they paste
      // whatever was in the buffer to a client.
      writeText.mockRejectedValue(new Error('denied'))
      vi.mocked(promosApi.getMyPromos).mockResolvedValue(page([promo('p1', { code: 'FIRST' })]))
      mount()
      await flush()

      buttonIn(items()[0], 'Копировать')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось скопировать')
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })

  describe('navigation', () => {
    it('the header + button opens the create form', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.promo__add')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-promocode-new' })
    })

    it('the empty state «Создать» opens the same create form', async () => {
      mount()
      await flush()

      button('Создать')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-promocode-new' })
    })

    it('the header back arrow goes back', async () => {
      mount()
      await flush()

      const backBtn = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.getAttribute('aria-label') === 'Назад' || b.className.includes('back'),
      )
      expect(backBtn).toBeDefined()
      backBtn?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })
  })
})
