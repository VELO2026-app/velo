// =============================================================================
// VELO Frontend -- CalendarPracticeCard school-marker tests
// =============================================================================
//
// School practices (audience_kind === 'curator_groups') are listed exactly
// like every other practice: the muted «Для школы» badge (FE-24 / GT P5) was
// retired by owner decision 2026-10-02. Asserted on the unavailable-school
// case too -- the master zone carries the audience_unavailable warning, the
// shared card carries nothing.
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

describe('CalendarPracticeCard -- school practices carry no marker', () => {
  it('curator_groups audience: no «Для школы» badge, card renders normally', async () => {
    const text = await mountCard(practice({ audience_kind: 'curator_groups' }))
    expect(text).toContain('Практика')
    expect(text).not.toContain('Для школы')
  })

  it('unavailable school audience: no badge either (the master zone keeps the warning)', async () => {
    const text = await mountCard(
      practice({
        audience_kind: 'curator_groups',
        audience_unavailable: true,
        curator_group_id: 'sc1',
        curator_group_name: 'Тихая школа',
      }),
    )
    expect(text).toContain('Практика')
    expect(text).not.toContain('Для школы')
  })
})
