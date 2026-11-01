// =============================================================================
// VELO Frontend -- AdminSupportStatsView Tests (FE-107 / BE-162 delivery 3)
// =============================================================================
//
// The month window is the admin's own ([00:00 of the 1st, 00:00 of the next
// 1st) in their users.timezone, ISO with the offset -- asserted by mirroring
// the same luxon arithmetic, not by hardcoding dates. The figures assert the
// null-rules: average/share null (nothing rated) is «—», never 0.
//
// Seams mocked: @/api/support (getSupportStats), @/stores/auth (timezone),
// vue-router (back).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { DateTime } from 'luxon'
import AdminSupportStatsView from '@/views/admin/AdminSupportStatsView.vue'
import * as supportApi from '@/api/support'
import type { SupportStats } from '@/api/support'

vi.mock('@/api/support')

vi.mock('vue-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: 'admin_me', timezone: 'Europe/Berlin' },
  }),
}))

function stats(overrides: Partial<SupportStats> = {}): SupportStats {
  return {
    period: { created_from: 'x', created_to: 'y' },
    categories: [
      { category: 'payments', tickets: 12, rated: 3, average: 4.33, share_4_5: 0.667 },
      { category: 'tech', tickets: 5, rated: 0, average: null, share_4_5: null },
    ],
    total: 17,
    spam: 2,
    resolvers: [
      {
        admin: { user_id: 'a_1', name: 'Ольга', avatar_url: null },
        rated: 3,
        average: 4.33,
        share_4_5: 0.667,
      },
    ],
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminSupportStatsView).use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function fromArgs(): [string, string] | undefined {
  return vi.mocked(supportApi.getSupportStats).mock.lastCall
}

beforeEach(() => {
  vi.mocked(supportApi.getSupportStats).mockReset().mockResolvedValue(stats())
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks()
})

describe('AdminSupportStatsView', () => {
  it("asks for the admin's own current month, ISO with the offset", async () => {
    mount()
    await flush()

    const start = DateTime.now().setZone('Europe/Berlin').startOf('month')
    expect(fromArgs()).toEqual([start.toISO(), start.plus({ months: 1 }).toISO()])
  })

  it('renders the totals, spam, and the category rows with their figures', async () => {
    mount()
    await flush()

    expect(host?.querySelectorAll('[data-testid="stats-category-row"]')).toHaveLength(2)
    expect(text()).toContain('17')
    expect(text()).toContain('Оплаты')
    expect(text()).toContain('12 обр.')
    expect(text()).toContain('3 с оценкой')
    expect(text()).toContain('ср. 4.33')
    expect(text()).toContain('4–5: 67%')
    // Nothing rated is «—», never a zero average.
    expect(text()).toContain('ср. —')
    expect(text()).toContain('4–5: —')
  })

  it('renders a resolver row per admin a rating is about', async () => {
    mount()
    await flush()

    const rows = host?.querySelectorAll('[data-testid="stats-resolver-row"]')
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.textContent).toContain('Ольга')
  })

  it('no resolvers -> the honest empty line, not an empty card', async () => {
    vi.mocked(supportApi.getSupportStats).mockResolvedValue(stats({ resolvers: [] }))
    mount()
    await flush()

    expect(host?.querySelectorAll('[data-testid="stats-resolver-row"]')).toHaveLength(0)
    expect(text()).toContain('Оценок за этот период пока нет')
  })

  it('‹ steps one month back and asks again; › is capped at the current month', async () => {
    mount()
    await flush()

    host?.querySelector<HTMLButtonElement>('[data-testid="stats-prev"]')?.click()
    await flush()

    const prev = DateTime.now().setZone('Europe/Berlin').startOf('month').minus({ months: 1 })
    expect(fromArgs()).toEqual([prev.toISO(), prev.plus({ months: 1 }).toISO()])

    const next = host?.querySelector<HTMLButtonElement>('[data-testid="stats-next"]')
    expect(next?.disabled).toBe(false)
    next?.click()
    await flush()
    expect(fromArgs()).toEqual([
      DateTime.now().setZone('Europe/Berlin').startOf('month').toISO(),
      DateTime.now().setZone('Europe/Berlin').startOf('month').plus({ months: 1 }).toISO(),
    ])

    // Back at the current month, › is disabled -- the future has no appeals.
    const capped = host?.querySelector<HTMLButtonElement>('[data-testid="stats-next"]')
    expect(capped?.disabled).toBe(true)
  })

  it('a failed load shows the error state with a retry', async () => {
    vi.mocked(supportApi.getSupportStats).mockRejectedValueOnce(new Error('down'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить')
    vi.mocked(supportApi.getSupportStats).mockClear()
    const retry = Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    retry?.click()
    await flush()
    expect(supportApi.getSupportStats).toHaveBeenCalledTimes(1)
  })
})
