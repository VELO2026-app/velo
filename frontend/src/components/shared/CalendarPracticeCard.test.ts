// =============================================================================
// VELO Frontend -- CalendarPracticeCard badge tests (FE-24 / GT P5)
// =============================================================================
//
// The card's ONLY audience-aware surface: the muted «Для школы» badge for
// audience_kind === 'curator_groups', absent for every other kind. Rendered
// for the unavailable case too (flag and names diverge on purpose -- the
// badge never guesses which one it is; the master detail screen carries the
// warning).
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import type { PracticeResponse } from '@/api/types'

vi.mock('@/composables/useViewerTimezone', async () => {
  const { ref } = await import('vue')
  return { useViewerTimezone: () => ref('Europe/Moscow') }
})

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'm1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Практика',
    description: null,
    scheduled_at: '2026-09-10T18:00:00Z',
    duration_minutes: 60,
    timezone: 'Europe/Moscow',
    max_participants: null,
    current_participants: 0,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'RUB',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

async function mountCard(p: PracticeResponse): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Wrapper = defineComponent({
    setup() {
      return () => h(CalendarPracticeCard, { practice: p, showDate: true })
    },
  })
  app = createApp(Wrapper)
  app.mount(host)
  await nextTick()
  await nextTick()
  return host.textContent ?? ''
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('CalendarPracticeCard -- «Для школы» badge (FE-24)', () => {
  it('curator_groups audience: the badge renders', async () => {
    const text = await mountCard(practice({ audience_kind: 'curator_groups' }))
    expect(text).toContain('Для школы')
  })

  it('every other audience kind: no badge', async () => {
    for (const kind of ['public', 'students', 'groups'] as const) {
      const text = await mountCard(practice({ audience_kind: kind }))
      expect(text).not.toContain('Для школы')
    }
  })

  it('unavailable school audience: badge still renders (names and flag diverge on purpose)', async () => {
    const text = await mountCard(
      practice({
        audience_kind: 'curator_groups',
        audience_unavailable: true,
        audience_curator_group_names: ['Тихая школа'],
      }),
    )
    expect(text).toContain('Для школы')
  })
})
