// =============================================================================
// VELO Frontend -- SchoolMemberRow Component Tests (tz-curator.md §1.11)
// =============================================================================
//
// The roster row is pure presentation over CuratorGroupMemberItem: the name
// shows, a suspended master (is_visible=false, I-4) degrades to a
// «Временно недоступен» subtitle instead of vanishing, and the whole row is
// one touch target that hands the member up to the parent (which decides
// where the profile lives -- a row navigates, it does not act).
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import SchoolMemberRow from '@/components/shared/SchoolMemberRow.vue'
import type { CuratorGroupMemberItem, CuratorGroupRosterItem } from '@/api/types'

function member(overrides: Partial<CuratorGroupMemberItem> = {}): CuratorGroupMemberItem {
  return {
    user_id: 'u1',
    name: 'Анна Петрова',
    avatar_url: null,
    kind: 'student',
    joined_at: '2026-09-01T00:00:00Z',
    is_visible: true,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

// The row emits the base CuratorGroupRosterItem (BE-76: it renders both the
// curator's and a school master's rows), so the listener takes the base type.
function mountRow(
  m: CuratorGroupMemberItem | CuratorGroupRosterItem,
  onOpen: (m: CuratorGroupRosterItem) => void,
): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(SchoolMemberRow, { member: m, onOpen }) })
  app.mount(host)
}

function row(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.v-list-row') ?? null
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('SchoolMemberRow', () => {
  it('renders the name and emits open with the member on click', async () => {
    const m = member()
    const onOpen = vi.fn()
    mountRow(m, onOpen)
    await nextTick()

    expect(host?.textContent).toContain('Анна Петрова')
    expect(host?.textContent).not.toContain('Временно недоступен')

    row()?.click()
    await nextTick()
    expect(onOpen).toHaveBeenCalledWith(m)
  })

  it('a suspended master (is_visible=false) stays a row with an honest subtitle (I-4)', async () => {
    mountRow(member({ kind: 'master', is_visible: false }), vi.fn())
    await nextTick()

    expect(host?.textContent).toContain('Анна Петрова')
    expect(host?.textContent).toContain('Временно недоступен')
    // Still a touch target: the membership is real and manageable.
    expect(row()?.hasAttribute('disabled')).toBe(false)
  })
})

it.each([
  ['awaiting_verification', 'Ожидает проверки мастера'],
  ['awaiting_answer', 'Ожидает ответа участника'],
] as const)('shows %s without claiming the student is already a master', async (state, label) => {
  const candidate = member({ master_offer: state })
  const onOpen = vi.fn()
  mountRow(candidate, onOpen)
  await nextTick()
  expect(host?.textContent).toContain(label)
  row()?.click()
  expect(onOpen).toHaveBeenCalledWith(candidate)
})

describe("SchoolMemberRow -- a school master's row (BE-76)", () => {
  it('a row WITHOUT the curator fields renders no subtitle, even for a master', () => {
    const plain: CuratorGroupRosterItem = {
      user_id: 'm1',
      name: 'Борис Ветров',
      avatar_url: null,
      kind: 'master',
      joined_at: '2026-09-01T00:00:00Z',
    }
    mountRow(plain, () => {})
    // The pair: the row is there and named; only the subtitle is absent.
    expect(row()?.textContent).toContain('Борис Ветров')
    expect(host?.textContent).not.toContain('Временно недоступен')
    expect(host?.querySelector('.v-list-row__sub')).toBeNull()
  })
})

