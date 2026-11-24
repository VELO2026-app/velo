import { createTestI18n } from '@/locales/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import ConsoleTable from '@/components/console/ConsoleTable.vue'

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'count', label: 'Count', width: 80, align: 'end' as const },
]
const rows = [
  { id: 'a', name: 'Alpha', count: 3 },
  { id: 'b', name: 'Beta', count: 0 },
]

let app: App | null = null
let root: HTMLElement | null = null

function mount(props: Record<string, unknown>, slots: Record<string, unknown> = {}): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(ConsoleTable as Component, props, slots) }).use(
    createTestI18n(),
  )
  app.mount(root)
  return root
}

function rowEls(): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-testid="console-table-row"]') ?? [])
}

afterEach(() => {
  app?.unmount()
  root?.remove()
})

describe('ConsoleTable', () => {
  it('shows a header and one row per item, the field as text by default', () => {
    const el = mount({ columns, rows })

    expect(
      Array.from(el.querySelectorAll('[role="columnheader"]')).map((c) => c.textContent?.trim()),
    ).toEqual(['Name', 'Count'])
    expect(
      rowEls().map((r) =>
        Array.from(r.querySelectorAll('[role="cell"]')).map((c) => c.textContent?.trim()),
      ),
    ).toEqual([
      ['Alpha', '3'],
      ['Beta', '0'],
    ])
  })

  it('fills a cell through its cell-<key> slot', () => {
    mount(
      { columns, rows },
      { 'cell-name': ({ row }: { row: { name: string } }) => h('b', row.name.toUpperCase()) },
    )

    expect(rowEls()[0]?.querySelector('b')?.textContent).toBe('ALPHA')
  })

  it('makes clickable rows focusable controls that emit row-click', () => {
    const onRowClick = vi.fn()
    mount({ columns, rows, clickable: true, onRowClick })

    rowEls()[1]?.click()
    rowEls()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(onRowClick.mock.calls.map(([row]) => (row as { id: string }).id)).toEqual(['b', 'a'])
    expect(rowEls()[0]?.getAttribute('tabindex')).toBe('0')
  })

  it('leaves rows inert unless clickable', () => {
    const onRowClick = vi.fn()
    mount({ columns, rows, onRowClick })

    rowEls()[0]?.click()

    expect(rowEls()[0]?.getAttribute('tabindex')).toBeNull()
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('marks the selected row', () => {
    mount({ columns, rows, selected: 'b' })

    expect(rowEls().map((r) => r.classList.contains('console-table__row--selected'))).toEqual([
      false,
      true,
    ])
  })

  it('shows the empty slot when there are no rows', () => {
    const el = mount({ columns, rows: [] }, { empty: () => 'Nothing yet' })

    expect(el.querySelector('.console-table__empty')?.textContent?.trim()).toBe('Nothing yet')
  })
})
