// =============================================================================
// VELO Frontend -- SchoolInviteCard Tests (invite screens, owner 2026-10-02)
// =============================================================================
//
// The card's contract, per the mockups and the owner's no-analytics ruling:
// logo/name/counters/description plus the bold invitation heading -- and
// NOTHING else. The counters are the same pluralised «ученики → мастера»
// pair the hero card renders; an empty description is omitted, never an
// empty paragraph; without a hash the initials plate stands in until the
// derived mandala resolves (§5.2 variant A).
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import SchoolInviteCard from '@/components/shared/SchoolInviteCard.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: {
  name: string
  avatarUrl?: string | null
  hash?: string | null
  studentsCount: number
  mastersCount: number
  description?: string | null
  curatorName?: string | null
  heading: string
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Wrapper = defineComponent({
    setup() {
      return () => h(SchoolInviteCard, { ...props })
    },
  })
  app = createApp(Wrapper)
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

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('SchoolInviteCard', () => {
  it('renders the mockup anatomy: name, pluralised counters, description, heading', async () => {
    mount({
      name: 'Ураган',
      studentsCount: 220,
      mastersCount: 15,
      description: 'Школа медитации и дыхания',
      heading: 'Вас пригласили в школу!',
    })
    await flush()

    expect(text()).toContain('Ураган')
    expect(text()).toContain('220 учеников')
    expect(text()).toContain('15 мастеров')
    expect(text()).toContain('Школа медитации и дыхания')
    expect(text()).toContain('Вас пригласили в школу!')
  })

  it('pluralises honestly: 1 ученик / 2 мастера / 5 учеников', async () => {
    mount({
      name: 'Тихая школа',
      studentsCount: 1,
      mastersCount: 2,
      heading: 'Приглашение стать мастером школы!',
    })
    await flush()

    expect(text()).toContain('1 ученик')
    expect(text()).toContain('2 мастера')
    expect(text()).not.toContain('1 учеников')
  })

  it('omits a blank description instead of rendering an empty paragraph', async () => {
    mount({
      name: 'Ураган',
      studentsCount: 0,
      mastersCount: 0,
      description: '   ',
      heading: 'Вас пригласили в школу!',
    })
    await flush()

    expect(host?.querySelectorAll('.school-invite__description').length).toBe(0)
    // Honest zeroes, still spelled out.
    expect(text()).toContain('0 учеников')
    expect(text()).toContain('0 мастеров')
  })

  it('names the curator when the caller knows one, omits the line when not (FE-67)', async () => {
    mount({
      name: 'Тихая школа',
      curatorName: 'Мария Иванова',
      studentsCount: 12,
      mastersCount: 3,
      heading: 'Приглашение стать мастером школы!',
    })
    await flush()

    expect(text()).toContain('Куратор: Мария Иванова')

    mount({
      name: 'Тихая школа',
      curatorName: null,
      studentsCount: 12,
      mastersCount: 3,
      heading: 'Приглашение стать мастером школы!',
    })
    await flush()

    expect(text()).not.toContain('Куратор:')
  })

  it('no analytics lines exist on the card at all -- counts are the only figures', async () => {
    mount({
      name: 'Ураган',
      studentsCount: 220,
      mastersCount: 15,
      description: 'Школа медитации и дыхания',
      heading: 'Вас пригласили в школу!',
    })
    await flush()

    // The card renders exactly two stat spans and no other numeric lines.
    expect(host?.querySelectorAll('.school-invite__stats span').length).toBe(2)
  })
})
