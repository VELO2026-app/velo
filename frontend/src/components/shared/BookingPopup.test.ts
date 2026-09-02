// =============================================================================
// VELO Frontend -- BookingPopup Component Tests (FE-52)
// =============================================================================
//
// [FE-52] The booking summary's date must render in the VIEWER's own profile
// timezone (useViewerTimezone, the F5 "profile decides" decision -- same as
// the calendar cards and the bookings list), NOT in the practice's own
// timezone: a Berlin viewer booking a Yekaterinburg-mastered practice was
// shown the MASTER's wall clock. The instant (scheduled_at) and the
// practice's timezone are untouched -- only the rendering zone moves.
//
// Pattern: useViewerTimezone is mocked to a MUTABLE zone (two-zone cases);
// the balance store and router are dependencies, mocked wholesale.
// Assertions are literals with the zone math in comments (house style).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import BookingPopup from '@/components/shared/BookingPopup.vue'
import type { PracticeResponse } from '@/api/types'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/stores/balance', () => ({
  useBalanceStore: () => ({
    hasEnough: () => true,
    refresh: vi.fn(),
    formattedBalance: '100,00 €',
  }),
}))

// MUTABLE viewer zone -- each test pins the pair it asserts (undefined =
// the no-profile contract case).
let viewerZone: string | undefined = 'Europe/Berlin'
vi.mock('@/composables/useViewerTimezone', async () => {
  const { computed } = await import('vue')
  return { useViewerTimezone: () => computed(() => viewerZone) }
})

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    title: 'Утренняя медитация',
    description: null,
    scheduled_at: '2026-07-22T10:00:00Z',
    duration_minutes: 60,
    // The MASTER's zone (Yekaterinburg, UTC+5) -- deliberately unlike the
    // viewer's; this is the FE-52 regression shape.
    timezone: 'Asia/Yekaterinburg',
    master_id: 'm1',
    master_name: 'Мастер',
    direction: null,
    difficulty: null,
    practice_type: 'live',
    status: 'scheduled',
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    max_participants: 10,
    current_participants: 3,
    ...overrides,
  } as PracticeResponse
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia | null = null

function mountPopup(p: PracticeResponse): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(BookingPopup, { practice: p, open: true }) })
  app.use(pinia!)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

describe('BookingPopup · [FE-52] viewer-timezone date', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    viewerZone = 'Europe/Berlin'
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
  })

  it('renders the date in the VIEWER zone, not the master zone (same calendar day)', async () => {
    // 10:00 UTC -> 12:00 Europe/Berlin (CEST, July) vs 15:00 Asia/Yekaterinburg.
    mountPopup(practice())
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('22 июля')
    expect(text).toContain('12:00')
    expect(text).not.toContain('15:00')
  })

  it('the calendar DAY follows the viewer zone when the zones disagree on the date', async () => {
    // 23:30 UTC -> 19:30 22 июля in America/New_York (EDT) -- but 04:30 23
    // июля in the master's Asia/Yekaterinburg. The popup must show the
    // VIEWER's day, not the master's.
    viewerZone = 'America/New_York'
    mountPopup(practice({ scheduled_at: '2026-07-22T23:30:00Z' }))
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('22 июля')
    expect(text).toContain('19:30')
    expect(text).not.toContain('23 июля')
    expect(text).not.toContain('04:30')
  })

  it('no viewer profile zone -> formatDate neutral default (UTC), never the master zone', async () => {
    // useViewerTimezone's contract: undefined when unauthenticated -> the
    // format helpers apply their own neutral default. The master zone must
    // not leak in through that path either.
    viewerZone = undefined
    mountPopup(practice())
    await flush()
    const text = document.body.textContent ?? ''
    // 10:00 UTC rendered as 10:00 (neutral default), not 15:00 (master).
    expect(text).toContain('10:00')
    expect(text).not.toContain('15:00')
  })
})
