// =============================================================================
// VELO Frontend -- ConsoleCatalogView screen tests (FE-262, slice 3)
// =============================================================================
//
// The catalog is one Colada query (getFullTaxonomy) and four writes, all in
// @/api/taxonomy -- the seam mocked here. `catalog` below is the "server":
// getFullTaxonomy answers with it, and a test that expects a write to show up
// changes it before the write resolves, so what the screen shows after the
// write is what the refetch returned, not local state. The screen mounts with
// a real Pinia and Colada, as in production.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import ConsoleCatalogView from '@/views/console/ConsoleCatalogView.vue'
import * as taxonomyApi from '@/api/taxonomy'
import type { TaxonomyDirectionItem, TaxonomyStyleItem } from '@/api/taxonomy'

vi.mock('@/api/taxonomy')

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: toastSuccess }),
}))

function style(overrides: Partial<TaxonomyStyleItem>): TaxonomyStyleItem {
  return {
    id: 'st_0',
    direction_id: 'dir_a',
    value: 'style',
    label: 'Стиль',
    display_order: 0,
    is_active: true,
    source: 'seed',
    ...overrides,
  }
}

function direction(overrides: Partial<TaxonomyDirectionItem>): TaxonomyDirectionItem {
  return {
    id: 'dir_0',
    value: 'direction',
    label: 'Направление',
    display_order: 0,
    is_active: true,
    source: 'seed',
    styles: [],
    ...overrides,
  }
}

const DIR_A = direction({
  id: 'dir_a',
  label: 'Медитация',
  display_order: 3,
  styles: [
    style({ id: 'st_a1', direction_id: 'dir_a', label: 'Випассана', display_order: 1 }),
    style({ id: 'st_a2', direction_id: 'dir_a', label: 'Метта', display_order: 2 }),
  ],
})
const DIR_B = direction({
  id: 'dir_b',
  label: 'Йога',
  is_active: false,
  styles: [style({ id: 'st_b1', direction_id: 'dir_b', label: 'Нидра', is_active: false })],
})
const DIR_C = direction({ id: 'dir_c', label: 'Дыхание', styles: [] })

// The window width classes (composables/useConsoleWidth.ts):
// happy-dom is 1024 px wide, so the test sets them. Default: the wide layout.
const width = vi.hoisted(() => ({ narrow: false, medium: false }))
vi.mock('@/composables/useConsoleWidth', async () => {
  const { ref } = await import('vue')
  return { useConsoleWidth: () => ({ narrow: ref(width.narrow), medium: ref(width.medium) }) }
})

/** The slug the API accepts (backend admin/taxonomy/schemas.py SlugStr). */
const SLUG = /^[a-z][a-z0-9_]{1,49}$/

/** The server's catalog; a test changes it to say what a write did. */
let catalog: TaxonomyDirectionItem[]

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsoleCatalogView)
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mountAndLoad(): Promise<void> {
  mount()
  await flush()
}

/** The input a label names (the labels of the hidden-label inputs count). */
function field(label: string): HTMLInputElement {
  const el = Array.from(host?.querySelectorAll('label') ?? []).find(
    (l) => l.textContent?.trim() === label,
  )
  const input = el ? document.getElementById(el.htmlFor) : null
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`)
  return input
}
function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
function button(text: string): HTMLButtonElement {
  const el = Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!el) throw new Error(`no button ${text}`)
  return el
}
function byLabel(label: string): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!el) throw new Error(`no control ${label}`)
  return el
}
function directionItems(): string[] {
  return Array.from(host?.querySelectorAll('[data-testid="direction-item"]') ?? []).map((el) =>
    Array.from(el.querySelectorAll('span'))
      .map((s) => s.textContent?.trim())
      .join(' | '),
  )
}
function selectedDirection(): string | undefined {
  return host
    ?.querySelector('[data-testid="direction-item"][aria-current="true"] span')
    ?.textContent?.trim()
}
function styleRows(): string[] {
  return Array.from(
    host?.querySelectorAll('[role="table"] [data-testid="console-table-row"]') ?? [],
  ).map((row) => {
    const cells = Array.from(row.querySelectorAll('[role="cell"]'))
    return `${cells[0]?.textContent?.trim()} #${cells[1]?.textContent?.trim()} ${
      cells[2]?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true'
        ? 'on'
        : 'off'
    }`
  })
}
async function click(el: HTMLElement): Promise<void> {
  el.click()
  await flush()
}

beforeEach(() => {
  width.narrow = false
  width.medium = false
  catalog = [DIR_A, DIR_B, DIR_C]
  vi.mocked(taxonomyApi.getFullTaxonomy)
    .mockReset()
    .mockImplementation(async () => ({ directions: catalog }))
  vi.mocked(taxonomyApi.getActiveTaxonomy).mockReset().mockResolvedValue({ directions: [] })
  vi.mocked(taxonomyApi.createTaxonomyDirection).mockReset()
  vi.mocked(taxonomyApi.createTaxonomyStyle).mockReset()
  vi.mocked(taxonomyApi.updateTaxonomyDirection).mockReset()
  vi.mocked(taxonomyApi.updateTaxonomyStyle).mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('ConsoleCatalogView', () => {
  describe('reading', () => {
    it('lists the directions with their style count and opens the first one with its styles', async () => {
      await mountAndLoad()

      expect(directionItems()).toEqual([
        'Медитация | 2 стиля',
        'Йога | Скрыто | 1 стиль',
        'Дыхание | 0 стилей',
      ])
      expect(selectedDirection()).toBe('Медитация')
      expect(field('Название').value).toBe('Медитация')
      expect(field('Порядок в каталоге').value).toBe('3')
      expect(styleRows()).toEqual(['Випассана #1 on', 'Метта #2 on'])
    })

    it('picking a direction opens it; a hidden one shows its hidden styles as off', async () => {
      await mountAndLoad()

      await click(
        host?.querySelectorAll<HTMLElement>('[data-testid="direction-item"]')[1] as HTMLElement,
      )

      expect(selectedDirection()).toBe('Йога')
      expect(field('Название').value).toBe('Йога')
      expect(
        host
          ?.querySelector('[role="switch"][aria-label="Виден мастерам"]')
          ?.getAttribute('aria-checked'),
      ).toBe('false')
      expect(styleRows()).toEqual(['Нидра #0 off'])
    })

    it('on a narrow screen the directions are a row above the open one, and still pick', async () => {
      width.narrow = true
      await mountAndLoad()

      expect(host?.querySelector('[data-testid="catalog-stacked"]')).not.toBeNull()
      expect(host?.querySelector('.console-split')).toBeNull()
      expect(selectedDirection()).toBe('Медитация')

      await click(
        host?.querySelectorAll<HTMLElement>('[data-testid="direction-item"]')[1] as HTMLElement,
      )

      expect(selectedDirection()).toBe('Йога')
      expect(field('Название').value).toBe('Йога')
    })

    it('an empty catalog says so', async () => {
      catalog = []
      await mountAndLoad()

      expect(host?.textContent).toContain('В каталоге пока нет направлений')
      expect(host?.querySelector('[data-testid="direction-save"]')).toBeNull()
    })

    it('a failed load shows the error and Retry recovers', async () => {
      vi.mocked(taxonomyApi.getFullTaxonomy).mockRejectedValueOnce(new Error('ECONNRESET'))
      await mountAndLoad()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить каталог',
      )

      await click(button('Повторить'))

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(directionItems()).toHaveLength(3)
    })
  })

  describe('background refetch (a return to the app)', () => {
    /** A background refetch of the catalog, as a return to the app does. */
    async function refetchInBackground(): Promise<void> {
      useQueryCache(pinia)
        .invalidateQueries({ key: adminKeys.taxonomy() })
        .catch(() => {})
      await flush()
    }

    it('keeps the tree on screen while it runs, then shows the fresh answer', async () => {
      await mountAndLoad()

      let resolveFresh!: (value: { directions: TaxonomyDirectionItem[] }) => void
      vi.mocked(taxonomyApi.getFullTaxonomy).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve
          }),
      )
      await refetchInBackground()

      expect(host?.querySelector('[data-testid="catalog-loading"]')).toBeNull()
      expect(directionItems()).toHaveLength(3)

      resolveFresh({ directions: [DIR_C] })
      await flush()
      expect(directionItems()).toEqual(['Дыхание | 0 стилей'])
      expect(toastError).not.toHaveBeenCalled()
    })

    it('failing again and again is told once, until an answer arrives; the tree stays', async () => {
      await mountAndLoad()
      vi.mocked(taxonomyApi.getFullTaxonomy).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await refetchInBackground()
      await refetchInBackground()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить каталог')
      expect(directionItems()).toHaveLength(3)
      expect(host?.querySelector('.v-empty__title')).toBeNull()

      vi.mocked(taxonomyApi.getFullTaxonomy).mockImplementation(async () => ({
        directions: catalog,
      }))
      await refetchInBackground()
      vi.mocked(taxonomyApi.getFullTaxonomy).mockImplementation(() =>
        Promise.reject(new Error('down again')),
      )
      await refetchInBackground()

      expect(toastError).toHaveBeenCalledTimes(2)
    })
  })

  describe('a direction', () => {
    it('is added last with a valid machine slug, selected, and the app taxonomy is refreshed', async () => {
      const created = direction({ id: 'dir_new', label: 'Звук', source: 'custom' })
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockImplementation(async () => {
        catalog = [...catalog, created]
        return created
      })
      await mountAndLoad()

      await click(byTestId('direction-add'))
      type(field('Название направления'), '  Звук ')
      await flush()
      await click(byTestId('direction-add-confirm'))

      const [body] = vi.mocked(taxonomyApi.createTaxonomyDirection).mock.calls[0] ?? []
      // Orders in use are 3, 0, 0: the new direction goes after the largest.
      expect(body).toEqual({ value: expect.stringMatching(SLUG), label: 'Звук', display_order: 4 })
      // The list is the refetched catalog; the new direction is the open one.
      expect(directionItems()).toHaveLength(4)
      expect(selectedDirection()).toBe('Звук')
      // The practice forms and method pickers read the active catalog: reloaded.
      await vi.waitFor(() => expect(taxonomyApi.getActiveTaxonomy).toHaveBeenCalled())
      expect(toastSuccess).toHaveBeenCalledWith('Направление добавлено')
      expect(host?.querySelector('[data-testid="direction-add-row"]')).toBeNull()
    })

    it('a rejected add tells it, keeps the name typed and adds nothing', async () => {
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockRejectedValue(new Error('boom'))
      await mountAndLoad()

      await click(byTestId('direction-add'))
      type(field('Название направления'), 'Йога')
      await flush()
      await click(byTestId('direction-add-confirm'))

      expect(toastError).toHaveBeenCalledWith('Не удалось добавить направление')
      expect(field('Название направления').value).toBe('Йога')
      expect(directionItems()).toHaveLength(3)
    })

    it('from the keyboard: Enter adds, Escape closes the form', async () => {
      const created = direction({ id: 'dir_new', label: 'Звук', source: 'custom' })
      vi.mocked(taxonomyApi.createTaxonomyDirection).mockImplementation(async () => {
        catalog = [...catalog, created]
        return created
      })
      await mountAndLoad()

      await click(byTestId('direction-add'))
      field('Название направления').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
      await flush()
      expect(host?.querySelector('[data-testid="direction-add-row"]')).toBeNull()

      await click(byTestId('direction-add'))
      type(field('Название направления'), 'Звук')
      await flush()
      field('Название направления').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await flush()

      expect(taxonomyApi.createTaxonomyDirection).toHaveBeenCalledTimes(1)
      expect(selectedDirection()).toBe('Звук')
    })

    it('Add is off for a blank name and on once a name is typed', async () => {
      await mountAndLoad()

      await click(byTestId('direction-add'))
      type(field('Название направления'), '   ')
      await flush()
      expect(byTestId('direction-add-confirm').disabled).toBe(true)

      type(field('Название направления'), 'Звук')
      await flush()
      expect(byTestId('direction-add-confirm').disabled).toBe(false)
    })

    it('Save stays off until something changed, then sends only what changed', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockImplementation(async (_id, body) => {
        catalog = [
          { ...DIR_A, ...body, label: body.label ?? DIR_A.label } as TaxonomyDirectionItem,
          DIR_B,
          DIR_C,
        ]
        return catalog[0] as TaxonomyDirectionItem
      })
      await mountAndLoad()
      expect(byTestId('direction-save').disabled).toBe(true)

      type(field('Порядок в каталоге'), '7')
      await flush()
      await click(byTestId('direction-save'))

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledWith('dir_a', {
        display_order: 7,
      })
      expect(toastSuccess).toHaveBeenCalledWith('Сохранено')

      type(field('Название'), 'Медитации')
      await flush()
      await click(byTestId('direction-save'))

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenLastCalledWith('dir_a', {
        label: 'Медитации',
      })
      expect(directionItems()[0]).toBe('Медитации | 2 стиля')
    })

    it('Save stays off for a blank name or an order that is not a whole number', async () => {
      await mountAndLoad()

      type(field('Название'), '  ')
      await flush()
      expect(byTestId('direction-save').disabled).toBe(true)

      type(field('Название'), 'Медитации')
      type(field('Порядок в каталоге'), '1.5')
      await flush()
      expect(byTestId('direction-save').disabled).toBe(true)

      type(field('Порядок в каталоге'), '2')
      await flush()
      expect(byTestId('direction-save').disabled).toBe(false)
    })

    it('a failed save tells it and leaves the draft', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockRejectedValue(new Error('boom'))
      await mountAndLoad()

      type(field('Название'), 'Медитации')
      await flush()
      await click(byTestId('direction-save'))

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить')
      expect(field('Название').value).toBe('Медитации')
    })

    it('is hidden and shown again with the visibility switch', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyDirection).mockImplementation(async (_id, body) => {
        catalog = [{ ...DIR_A, is_active: body.is_active ?? true }, DIR_B, DIR_C]
        return catalog[0] as TaxonomyDirectionItem
      })
      await mountAndLoad()

      await click(byRoleLabel('Виден мастерам'))

      expect(taxonomyApi.updateTaxonomyDirection).toHaveBeenCalledWith('dir_a', {
        is_active: false,
      })
      expect(directionItems()[0]).toBe('Медитация | Скрыто | 2 стиля')
    })
  })

  describe('a style', () => {
    it('is added last in the open direction, with a valid machine slug', async () => {
      vi.mocked(taxonomyApi.createTaxonomyStyle).mockImplementation(async (_dirId, body) => {
        const added = style({
          id: 'st_new',
          direction_id: 'dir_a',
          label: body.label,
          display_order: body.display_order ?? 0,
        })
        catalog = [{ ...DIR_A, styles: [...(DIR_A.styles ?? []), added] }, DIR_B, DIR_C]
        return added
      })
      await mountAndLoad()

      await click(button('Добавить стиль'))
      type(field('Название стиля'), ' Дзадзен ')
      await flush()
      await click(byTestId('style-add-confirm'))

      const [directionId, body] = vi.mocked(taxonomyApi.createTaxonomyStyle).mock.calls[0] ?? []
      expect(directionId).toBe('dir_a')
      // The styles in use are 1 and 2: the new one goes after them.
      expect(body).toEqual({
        value: expect.stringMatching(SLUG),
        label: 'Дзадзен',
        display_order: 3,
      })
      expect(styleRows()).toEqual(['Випассана #1 on', 'Метта #2 on', 'Дзадзен #3 on'])
      expect(toastSuccess).toHaveBeenCalledWith('Стиль добавлен')
    })

    it('is renamed and reordered in its row; only the changes are sent', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockImplementation(async (id, body) => {
        const styles = (DIR_A.styles ?? []).map((s) => (s.id === id ? { ...s, ...body } : s))
        catalog = [{ ...DIR_A, styles } as TaxonomyDirectionItem, DIR_B, DIR_C]
        return styles[0] as TaxonomyStyleItem
      })
      await mountAndLoad()

      await click(byLabel('Изменить стиль Випассана'))
      type(field('Стиль'), 'Випассана классическая')
      await flush()
      await click(byLabel('Сохранить'))

      expect(taxonomyApi.updateTaxonomyStyle).toHaveBeenCalledWith('st_a1', {
        label: 'Випассана классическая',
      })
      // The row went back to reading, with the refetched name.
      expect(styleRows()).toEqual(['Випассана классическая #1 on', 'Метта #2 on'])
      expect(host?.querySelector('[aria-label="Сохранить"]')).toBeNull()
    })

    it('Cancel leaves the row as it was and sends nothing', async () => {
      await mountAndLoad()

      await click(byLabel('Изменить стиль Метта'))
      type(field('Стиль'), 'Другое имя')
      await flush()
      await click(byLabel('Отмена'))

      expect(styleRows()).toEqual(['Випассана #1 on', 'Метта #2 on'])
      expect(taxonomyApi.updateTaxonomyStyle).not.toHaveBeenCalled()
    })

    it('a failed save tells it and keeps the row in edit', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockRejectedValue(new Error('boom'))
      await mountAndLoad()

      await click(byLabel('Изменить стиль Метта'))
      type(field('Стиль'), 'Метта-бхавана')
      await flush()
      await click(byLabel('Сохранить'))

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить')
      expect(field('Стиль').value).toBe('Метта-бхавана')
    })

    it('Enter in the order field saves only the new order', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockImplementation(async (id, body) => {
        const styles = (DIR_A.styles ?? []).map((s) => (s.id === id ? { ...s, ...body } : s))
        catalog = [{ ...DIR_A, styles } as TaxonomyDirectionItem, DIR_B, DIR_C]
        return styles[0] as TaxonomyStyleItem
      })
      await mountAndLoad()

      await click(byLabel('Изменить стиль Метта'))
      const order = field('Порядок')
      type(order, '5')
      await flush()
      order.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flush()

      expect(taxonomyApi.updateTaxonomyStyle).toHaveBeenCalledWith('st_a2', { display_order: 5 })
    })

    it('a rejected add tells it and adds nothing', async () => {
      vi.mocked(taxonomyApi.createTaxonomyStyle).mockRejectedValue(new Error('boom'))
      await mountAndLoad()

      await click(button('Добавить стиль'))
      type(field('Название стиля'), 'Дзадзен')
      await flush()
      await click(byTestId('style-add-confirm'))

      expect(toastError).toHaveBeenCalledWith('Не удалось добавить стиль')
      expect(styleRows()).toEqual(['Випассана #1 on', 'Метта #2 on'])
    })

    it('a failed visibility change tells it and keeps the style as it was', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockRejectedValue(new Error('boom'))
      await mountAndLoad()

      await click(byRoleLabel('Виден: Метта'))

      expect(toastError).toHaveBeenCalledWith('Не удалось изменить видимость')
      expect(styleRows()).toEqual(['Випассана #1 on', 'Метта #2 on'])
    })

    it('is hidden with its visibility switch', async () => {
      vi.mocked(taxonomyApi.updateTaxonomyStyle).mockImplementation(async (id, body) => {
        const styles = (DIR_A.styles ?? []).map((s) => (s.id === id ? { ...s, ...body } : s))
        catalog = [{ ...DIR_A, styles } as TaxonomyDirectionItem, DIR_B, DIR_C]
        return styles[0] as TaxonomyStyleItem
      })
      await mountAndLoad()

      await click(byRoleLabel('Виден: Метта'))

      expect(taxonomyApi.updateTaxonomyStyle).toHaveBeenCalledWith('st_a2', { is_active: false })
      expect(styleRows()).toEqual(['Випассана #1 on', 'Метта #2 off'])
    })
  })
})

/** A control by its data-testid. */
function byTestId(testid: string): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)
  if (!el) throw new Error(`no ${testid}`)
  return el
}
/** A switch by its aria-label. */
function byRoleLabel(label: string): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)
  if (!el) throw new Error(`no switch ${label}`)
  return el
}
