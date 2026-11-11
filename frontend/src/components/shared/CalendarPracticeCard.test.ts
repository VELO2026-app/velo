// =============================================================================
// VELO Frontend -- CalendarPracticeCard school-marker tests
// =============================================================================
//
// School practices (audience_kind === 'schools') are listed exactly
// like every other practice: the muted "For school" badge (FE-24 / GT P5)
// was retired by owner decision 2026-10-02. Asserted on the
// unavailable-school
// case too -- the master zone carries the audience_unavailable warning, the
// shared card carries nothing.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import type { PracticeResponse } from '@/api/types'
import { applyInstanceConfig } from '@/platform/instance'

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
  app = createApp(Wrapper).use(createTestI18n())
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
  it('schools audience: no «Для школы» badge, card renders normally', async () => {
    const text = await mountCard(practice({ audience_kind: 'schools' }))
    expect(text).toContain('Практика')
    expect(text).not.toContain('Для школы')
  })

  it('unavailable school audience: no badge either (the master zone keeps the warning)', async () => {
    const text = await mountCard(
      practice({
        audience_kind: 'schools',
        audience_unavailable: true,
        school_id: 'sc1',
        school_name: 'Тихая школа',
      }),
    )
    expect(text).toContain('Практика')
    expect(text).not.toContain('Для школы')
  })
})

describe('CalendarPracticeCard -- payments option off (FE-163, PM-22 p.2)', () => {
  it('a paid practice shows no price', async () => {
    applyInstanceConfig({ options: { payments: 'false' } })
    onTestFinished(() => applyInstanceConfig(null))
    const text = await mountCard(practice({ is_free: false, is_paid: false, price_cents: 2500 }))
    expect(text).not.toContain('25')
    expect(text).toContain('Запись недоступна')
  })

  it('a free practice still reads «Бесплатно»', async () => {
    applyInstanceConfig({ options: { payments: 'false' } })
    onTestFinished(() => applyInstanceConfig(null))
    const text = await mountCard(practice({ is_free: true }))
    expect(text).toContain('Бесплатно')
  })
})
