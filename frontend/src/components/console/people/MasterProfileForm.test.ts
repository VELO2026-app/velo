// =============================================================================
// VELO Frontend -- MasterProfileForm tests (FE-262, slice 1)
// =============================================================================
//
// The editors of the master card's profile that the screen test
// (views/console/people/ConsoleMasterDetailView.test.ts) does not walk: the
// account name, the about text, the language chips, the certificate list, the
// display-name rule, and cancelling an editor. One editor is open at a time and
// every save sends only its own keys. Real Pinia + Pinia Colada; @/api/admin is
// the mocked boundary.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import MasterProfileForm from '@/components/console/people/MasterProfileForm.vue'
import * as adminApi from '@/api/admin'
import * as taxonomyApi from '@/api/taxonomy'
import type { AdminMasterDetail } from '@/api/admin'
import { LANGUAGES } from '@/utils/languages'

vi.mock('@/api/admin')
vi.mock('@/api/taxonomy')

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function master(overrides: Partial<AdminMasterDetail> = {}): AdminMasterDetail {
  return {
    id: 'm1',
    first_name: 'Anna',
    last_name: 'Lebedeva',
    avatar_url: null,
    role: 'master',
    is_active: true,
    master_status: 'verified',
    methods: ['Медитация'],
    experience_years: 5,
    bio: 'Practising',
    display_name: 'Anna L',
    email: 'anna@example.com',
    phone: '+491512345678',
    languages: [LANGUAGES[0]],
    certifications: ['Instructor'],
    ...overrides,
  }
}

let app: App | null = null
let root: HTMLElement | null = null

function mount(m: AdminMasterDetail = master()): void {
  const pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(MasterProfileForm as Component, { master: m }) })
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(root)
}

function row(label: string): HTMLElement {
  const found = Array.from(
    root?.querySelectorAll<HTMLElement>('[data-testid="console-field-row"]') ?? [],
  ).find((r) => r.querySelector('.field-row__label')?.textContent?.trim() === label)
  if (!found) throw new Error(`no row «${label}»`)
  return found
}

function pen(label: string): void {
  row(label).querySelector<HTMLButtonElement>('.field-row__pen')?.click()
}

function press(label: string, text: string): void {
  Array.from(row(label).querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => b.textContent?.trim() === text)
    ?.click()
}

function fill(el: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string): void {
  if (!el) throw new Error('no field to fill')
  el.value = value
  el.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  vi.mocked(adminApi.editMasterProfile)
    .mockReset()
    .mockResolvedValue({ user_id: 'm1', status: 'ok' })
  vi.mocked(adminApi.editMasterMethods)
    .mockReset()
    .mockResolvedValue({ user_id: 'm1', status: 'ok' })
  vi.mocked(taxonomyApi.getActiveTaxonomy).mockReset().mockRejectedValue(new Error('offline'))
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('MasterProfileForm', () => {
  it('sends the account name as two fields', async () => {
    mount()

    pen('Имя аккаунта')
    await vi.waitFor(() => expect(row('Имя аккаунта').querySelectorAll('input')).toHaveLength(2))
    const [first, last] = Array.from(row('Имя аккаунта').querySelectorAll('input'))
    fill(first, 'Anya')
    fill(last, '')
    press('Имя аккаунта', 'Сохранить')

    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', {
        first_name: 'Anya',
        last_name: null,
      }),
    )
  })

  it('edits the about text', async () => {
    mount()

    pen('О себе')
    await vi.waitFor(() => expect(row('О себе').querySelector('textarea')).not.toBeNull())
    fill(row('О себе').querySelector('textarea'), 'Eight years of practice')
    press('О себе', 'Сохранить')

    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', {
        bio: 'Eight years of practice',
      }),
    )
  })

  it('will not save an empty display name, and saves a filled one', async () => {
    mount()

    pen('Имя-визитка')
    await vi.waitFor(() => expect(row('Имя-визитка').querySelector('input')).not.toBeNull())
    fill(row('Имя-визитка').querySelector('input'), '  ')
    press('Имя-визитка', 'Сохранить')

    await vi.waitFor(() => expect(row('Имя-визитка').textContent).toContain('Введите имя-визитку'))
    expect(adminApi.editMasterProfile).not.toHaveBeenCalled()

    fill(row('Имя-визитка').querySelector('input'), 'Mira')
    press('Имя-визитка', 'Сохранить')
    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', { display_name: 'Mira' }),
    )
  })

  it('toggles the language chips and sends the chosen set', async () => {
    mount()

    pen('Язык практик')
    await vi.waitFor(() =>
      expect(row('Язык практик').querySelectorAll('.v-chip').length).toBeGreaterThan(1),
    )
    const chip = (name: string) =>
      Array.from(row('Язык практик').querySelectorAll<HTMLElement>('.v-chip')).find(
        (c) => c.textContent?.trim() === name,
      )
    chip(LANGUAGES[1])?.click() // add
    chip(LANGUAGES[0])?.click() // remove the one the master had
    press('Язык практик', 'Сохранить')

    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', { languages: [LANGUAGES[1]] }),
    )
  })

  it('adds a certificate once, removes another, and sends the list', async () => {
    mount()

    pen('Сертификаты')
    await vi.waitFor(() => expect(row('Сертификаты').querySelector('input')).not.toBeNull())
    const addButton = () =>
      Array.from(row('Сертификаты').querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Добавить',
      )
    // The add button waits for text.
    expect(addButton()?.disabled).toBe(true)
    // The second add of the same text changes nothing.
    for (let n = 0; n < 2; n++) {
      fill(row('Сертификаты').querySelector('input'), 'Breathwork')
      await vi.waitFor(() => expect(addButton()?.disabled).toBe(false))
      addButton()?.click()
      await vi.waitFor(() => expect(row('Сертификаты').querySelector('input')?.value).toBe(''))
    }
    Array.from(row('Сертификаты').querySelectorAll<HTMLElement>('.v-chip'))
      .find((c) => c.textContent?.includes('Instructor'))
      ?.click()
    press('Сертификаты', 'Сохранить')

    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', {
        certifications: ['Breathwork'],
      }),
    )
  })

  it('closes an editor on Cancel without a request', async () => {
    mount()

    pen('Телефон')
    await vi.waitFor(() => expect(row('Телефон').querySelector('input')).not.toBeNull())
    press('Телефон', 'Отмена')

    await vi.waitFor(() => expect(row('Телефон').querySelector('input')).toBeNull())
    expect(adminApi.editMasterProfile).not.toHaveBeenCalled()
  })

  it('closes the directions editor on Cancel without a request', async () => {
    mount()

    pen('Направления практик')
    await vi.waitFor(() => expect(row('Направления практик').querySelector('.mtp')).not.toBeNull())
    press('Направления практик', 'Отмена')

    await vi.waitFor(() =>
      expect(
        Array.from(row('Направления практик').querySelectorAll('button')).some(
          (b) => b.textContent?.trim() === 'Сохранить',
        ),
      ).toBe(false),
    )
    expect(adminApi.editMasterMethods).not.toHaveBeenCalled()
  })

  it('tells a failed directions save and keeps the editor', async () => {
    vi.mocked(adminApi.editMasterMethods).mockRejectedValue(new Error('500'))
    mount()

    pen('Направления практик')
    await vi.waitFor(() =>
      expect(
        Array.from(row('Направления практик').querySelectorAll('button')).some(
          (b) => b.textContent?.trim() === 'Сохранить',
        ),
      ).toBe(true),
    )
    press('Направления практик', 'Сохранить')

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(row('Направления практик').querySelector('.mtp')).not.toBeNull()
  })

  it('shows a dash when the master has no directions', async () => {
    mount(master({ methods: [] }))

    expect(row('Направления практик').textContent).toContain('—')
  })

  it.each([
    ['Имя-визитка', 'input'],
    ['О себе', 'textarea'],
    ['Почта', 'input'],
    ['Телефон', 'input'],
  ])('opens «%s» empty for a master who has not filled it', async (label, tag) => {
    mount(
      master({
        display_name: null,
        bio: null,
        email: null,
        phone: null,
        experience_years: null as unknown as number,
        first_name: null,
        last_name: null,
      }),
    )

    pen(label)
    await vi.waitFor(() => expect(row(label).querySelector(tag)).not.toBeNull())

    expect((row(label).querySelector(tag) as HTMLInputElement).value).toBe('')
  })

  it('opens the experience at 0 and the account name empty for a master who has none', async () => {
    mount(
      master({ experience_years: null as unknown as number, first_name: null, last_name: null }),
    )

    pen('Опыт')
    await vi.waitFor(() => expect(row('Опыт').querySelector('input')).not.toBeNull())
    expect(row('Опыт').querySelector('input')?.value).toBe('0')

    press('Опыт', 'Отмена')
    pen('Имя аккаунта')
    await vi.waitFor(() => expect(row('Имя аккаунта').querySelectorAll('input')).toHaveLength(2))
    expect(Array.from(row('Имя аккаунта').querySelectorAll('input')).map((i) => i.value)).toEqual([
      '',
      '',
    ])
  })
})
