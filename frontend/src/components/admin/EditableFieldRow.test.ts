// =============================================================================
// VELO Frontend -- EditableFieldRow Tests (FE-157 s4/admin-review)
// =============================================================================
//
// The row's chrome only: view mode (value + pen), edit mode (editor slot,
// cancel/save, error), the saving lock, and the methods variant's classes.
// What a save sends is the screen's part (AdminMasterReviewView.test.ts).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import EditableFieldRow from '@/components/admin/EditableFieldRow.vue'

let app: App | null = null
let host: HTMLElement | null = null
let emitted: string[] = []

type Props = {
  editing: boolean
  saving?: boolean
  error?: string
  variant?: 'field' | 'methods'
  saveLabel?: string
  valueClass?: string
}

async function mountRow(initial: Props): Promise<Props> {
  const props = reactive<Props>({ ...initial })
  emitted = []
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        EditableFieldRow,
        {
          label: 'Phone',
          editLabel: 'Edit phone',
          ...props,
          onStart: () => emitted.push('start'),
          onCancel: () => emitted.push('cancel'),
          onSave: () => emitted.push('save'),
        },
        { default: () => 'VALUE', edit: () => h('input', { class: 'editor' }) },
      ),
  })
  app.use(createTestI18n())
  app.mount(host)
  await nextTick()
  return props
}

function btn(text: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('EditableFieldRow', () => {
  it('view mode shows label, value and a pen that emits start', async () => {
    await mountRow({ editing: false })
    expect(host?.querySelector('.mreview__k')?.textContent).toBe('Phone')
    expect(host?.querySelector('.mreview__v')?.textContent?.trim()).toBe('VALUE')
    expect(host?.querySelector('.editor')).toBeNull()
    const pen = host?.querySelector<HTMLButtonElement>('.mreview__pen')
    expect(pen?.getAttribute('aria-label')).toBe('Edit phone')
    pen?.click()
    expect(emitted).toEqual(['start'])
  })

  it('applies valueClass to the value cell', async () => {
    await mountRow({ editing: false, valueClass: 'mreview__chips' })
    expect(host?.querySelector('.mreview__v.mreview__chips')).not.toBeNull()
  })

  it('edit mode swaps value and pen for the editor with cancel and save', async () => {
    await mountRow({ editing: true })
    expect(host?.querySelector('.mreview__v')).toBeNull()
    expect(host?.querySelector('.mreview__pen')).toBeNull()
    expect(host?.querySelector('.mreview__edit .editor')).not.toBeNull()
    const buttons = host?.querySelectorAll<HTMLButtonElement>('.mreview__edit-actions button')
    expect(buttons?.length).toBe(2)
    buttons?.[0]?.click()
    buttons?.[1]?.click()
    expect(emitted).toEqual(['cancel', 'save'])
  })

  it('renders the error only when given, and reacts to changes', async () => {
    const props = await mountRow({ editing: true })
    expect(host?.querySelector('.mreview__edit-err')).toBeNull()
    props.error = 'Boom'
    await nextTick()
    expect(host?.querySelector('.mreview__edit-err')?.textContent?.trim()).toBe('Boom')
  })

  it('while saving, cancel is disabled', async () => {
    await mountRow({ editing: true, saving: true })
    const cancel = host?.querySelector<HTMLButtonElement>('.mreview__edit-actions button')
    expect(cancel?.disabled).toBe(true)
  })

  it('methods variant uses its own class set and save label', async () => {
    await mountRow({ editing: true, variant: 'methods', error: 'Nope', saveLabel: 'Apply' })
    expect(host?.querySelector('.mreview__methods-edit .editor')).not.toBeNull()
    expect(host?.querySelector('.mreview__edit')).toBeNull()
    expect(host?.querySelector('.mreview__methods-err')?.textContent?.trim()).toBe('Nope')
    expect(btn('Apply')).toBeDefined()
    btn('Apply')?.click()
    expect(emitted).toEqual(['save'])
  })
})
