// =============================================================================
// VELO Frontend -- PracticeAudiencePicker Tests (FE-24 / GT P5)
// =============================================================================
//
// The picker owns the fourth audience option's WHOLE contract: it appears
// only when the master belongs to at least one school, its chips are a
// separate model from the student-groups one -- ONE school id or null (a
// practice belongs to exactly one school, BE-74), the group toggles replace
// their array immutably, and the empty/validation states stay honest. The Create/Edit
// suites cover their own wiring; this file covers the shared mechanism.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import PracticeAudiencePicker from '@/components/shared/PracticeAudiencePicker.vue'
import type { AudienceSchoolOption } from '@/components/shared/practiceAudience'
import type { PracticeAudienceKind } from '@/api/types'
import type { GroupListItem } from '@/api/groups'

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiResponseError: class {},
}))

const GROUPS: GroupListItem[] = [
  { id: 'gr1', kind: 'custom', name: 'Утро', members_count: 4, description: null },
  { id: 'gr2', kind: 'custom', name: 'VIP', members_count: 2, description: null },
]

const SCHOOLS: AudienceSchoolOption[] = [
  { id: 'sc1', name: 'Тихая школа' },
  { id: 'sc2', name: 'Утренняя школа' },
]

let app: App | null = null
let host: HTMLElement | null = null
// Model state, held by the wrapper and readable from the assertions.
const kind = ref<PracticeAudienceKind>('public')
const groupIds = ref<string[]>([])
const curatorGroupId = ref<string | null>(null)

interface MountOpts {
  groups?: GroupListItem[]
  schools?: AudienceSchoolOption[]
  error?: string
  studentsLabel?: string
}

function mount(opts: MountOpts = {}): HTMLElement {
  kind.value = 'public'
  groupIds.value = []
  curatorGroupId.value = null
  host = document.createElement('div')
  document.body.appendChild(host)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(PracticeAudiencePicker, {
          kind: kind.value,
          'onUpdate:kind': (v: PracticeAudienceKind) => {
            kind.value = v
          },
          groupIds: groupIds.value,
          'onUpdate:groupIds': (v: string[]) => {
            groupIds.value = v
          },
          curatorGroupId: curatorGroupId.value,
          'onUpdate:curatorGroupId': (v: string | null) => {
            curatorGroupId.value = v
          },
          groups: opts.groups ?? GROUPS,
          schools: opts.schools ?? [],
          error: opts.error,
          studentsLabel: opts.studentsLabel,
        })
    },
  })
  app = createApp(Wrapper)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

/** Radio options are VRadioGroup-rendered labels; chips are VChip buttons. */
function optionWith(label: string): HTMLElement | undefined {
  return Array.from(
    host?.querySelectorAll<HTMLElement>('label, button, [role="button"]') ?? [],
  ).find((el) => el.textContent?.trim() === label)
}

function chipWith(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (el) => el.textContent?.trim() === label,
  )
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('PracticeAudiencePicker', () => {
  it('no schools: exactly the three classic options, no «Школы»', () => {
    mount({ schools: [] })
    expect(optionWith('Публичная')).toBeTruthy()
    expect(optionWith('Все ученики')).toBeTruthy()
    expect(optionWith('Конкретные группы')).toBeTruthy()
    expect(text()).not.toContain('Школы')
  })

  it('with schools: the fourth option appears', () => {
    mount({ schools: SCHOOLS })
    expect(optionWith('Школы')).toBeTruthy()
  })

  it('studentsLabel relabels ONLY the students option (T24-24 seam)', () => {
    mount({ schools: SCHOOLS, studentsLabel: 'Все мои ученики' })
    expect(optionWith('Все мои ученики')).toBeTruthy()
    expect(optionWith('Все ученики')).toBeFalsy()
    expect(optionWith('Школы')).toBeTruthy()
  })

  it('kind=groups renders the group chips and NOT the school chips', async () => {
    mount({ schools: SCHOOLS })
    kind.value = 'groups'
    await flush()

    expect(chipWith('Утро')).toBeTruthy()
    expect(chipWith('Тихая школа')).toBeFalsy()
  })

  it('kind=curator_groups renders the school chips and NOT the group chips', async () => {
    mount({ schools: SCHOOLS })
    kind.value = 'curator_groups'
    await flush()

    expect(chipWith('Тихая школа')).toBeTruthy()
    expect(chipWith('Утренняя школа')).toBeTruthy()
    expect(chipWith('Утро')).toBeFalsy()
  })

  it('a school chip is a single select: a second school REPLACES the first, a re-tap clears', async () => {
    // Before BE-74 this test asserted that two school taps accumulate into
    // ['sc1', 'sc2'] -- right while a practice could target several schools.
    // The owner ruling of 2026-10-01 (a practice belongs to exactly ONE
    // school) made that union false; the precise statement now is that the
    // second tap replaces the first, so the model can never hold two.
    mount({ schools: SCHOOLS })
    kind.value = 'curator_groups'
    await flush()

    chipWith('Тихая школа')?.click()
    await flush()
    expect(curatorGroupId.value).toBe('sc1')

    // A tick between taps: the emit updates the child's prop on re-render,
    // and no real user taps two chips within one tick.
    chipWith('Утренняя школа')?.click()
    await flush()
    expect(curatorGroupId.value).toBe('sc2')

    chipWith('Утренняя школа')?.click()
    await flush()
    expect(curatorGroupId.value).toBeNull()
    // The student-groups array is untouched by school taps.
    expect(groupIds.value).toEqual([])
  })

  it('groups empty state names where to create one; error line renders as given', async () => {
    mount({ groups: [], error: 'Выберите хотя бы одну группу' })
    kind.value = 'groups'
    await flush()

    expect(text()).toContain('Пока нет ни одной группы')
    expect(text()).toContain('Выберите хотя бы одну группу')
  })

  it('the defensive schools-empty state (list emptied after the kind was picked)', async () => {
    mount({ schools: [] })
    kind.value = 'curator_groups'
    await flush()

    expect(text()).toContain('Нет школ, доступных для выбора')
  })

  it('review fix: the error line belongs to the targeted kinds only -- switching to «Публичная» clears it', async () => {
    mount({ error: 'Выберите хотя бы одну группу' })
    expect(text()).not.toContain('Выберите хотя бы одну группу')

    kind.value = 'groups'
    await flush()
    expect(text()).toContain('Выберите хотя бы одну группу')

    kind.value = 'public'
    await flush()
    expect(text()).not.toContain('Выберите хотя бы одну группу')
  })
})
