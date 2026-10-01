// =============================================================================
// VELO Frontend -- MasterCard method chips (FE-61/63/64)
// =============================================================================
//
// The master info card sits ON the practice/booking detail screens, so its
// method tags are the chips "on the event". Same contract as the public
// profile's «Методы» (utils/methodChips.ts): direction icon + SHORT label,
// the embedded direction word stripped, unknown strings verbatim under the
// neutral fallback glyph.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import MasterCard from '@/components/shared/MasterCard.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

async function mountCard(methods: string[] | null): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(MasterCard, {
          masterName: 'Анна Соколова',
          methods,
          avatarUrl: null,
          masterId: 'm1',
        })
    },
  })
  app = createApp(Wrapper)
  app.mount(host)
  await nextTick()
  await nextTick()
  return host
}

function pillTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.master-card__tags .v-tag')).map((p) =>
    (p.textContent ?? '').trim().replace(/\s+/g, ' '),
  )
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterCard -- method chips (FE-61/63/64)', () => {
  it('a «Направление — Вид» method renders icon + short label, not the doubled word', async () => {
    const root = await mountCard(['Медитация — Медитация молчания', 'Йога — Кундалини-йога'])

    expect(pillTexts(root)).toEqual(['Молчания', 'Кундалини'])
    for (const pill of root.querySelectorAll('.master-card__tags .v-tag')) {
      expect(pill.querySelector('svg')).not.toBeNull()
    }
  })

  it('a string the taxonomy does not know stays verbatim under the fallback glyph', async () => {
    const root = await mountCard(['Мой уникальный метод'])

    expect(pillTexts(root)).toEqual(['Мой уникальный метод'])
    expect(root.querySelector('.master-card__tags .v-tag svg')).not.toBeNull()
  })

  it('no methods: no tag row at all', async () => {
    const root = await mountCard(null)
    expect(root.querySelector('.master-card__tags')).toBeNull()
  })
})
