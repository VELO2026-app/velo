// =============================================================================
// VELO Frontend -- ConsoleMasterDetailView tests (FE-262, slice 1)
// =============================================================================
//
// The web master card decides whether a master may work on the platform, so
// the tests follow the consequence: the verdict (verify with the promote
// pause, reject with a reason), the rights and the revoke of a verified
// master, then the profile editor (one path for eight fields, one for the
// directions), then the load states. Real Pinia + Pinia Colada and a real
// router; @/api/admin is the mocked boundary. The method picker and the
// catalog fall back to the hardcoded taxonomy (the catalog fetch is mocked to
// fail), so a label outside it reads as a custom method.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleMasterDetailView from '@/views/console/people/ConsoleMasterDetailView.vue'
import * as adminApi from '@/api/admin'
import * as taxonomyApi from '@/api/taxonomy'
import { ApiResponseError } from '@/api/client'
import type { AdminMasterDetail, RevokeMasterAdvisory } from '@/api/admin'

vi.mock('@/api/admin')
vi.mock('@/api/taxonomy')

vi.mock('@/utils/methodTaxonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/methodTaxonomy')>()
  return { ...actual, primeMethodTaxonomyCatalog: vi.fn().mockResolvedValue(undefined) }
})

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function master(overrides: Partial<AdminMasterDetail> = {}): AdminMasterDetail {
  return {
    id: 'm1',
    telegram_id: 1,
    first_name: 'Anna',
    last_name: 'Lebedeva',
    avatar_url: null,
    role: 'master',
    is_active: true,
    master_status: 'pending',
    methods: ['Медитация'], // a bare direction of the hardcoded taxonomy
    practices_count: 3,
    students_count: 40,
    schools_count: 0,
    available_cents: 0,
    can_create_schools: false,
    experience_years: 5,
    bio: 'Practising for five years',
    display_name: 'Anna L',
    email: 'anna@example.com',
    phone: '+491512345678',
    languages: [],
    certifications: [],
    ...overrides,
  }
}

function advisory(overrides: Partial<RevokeMasterAdvisory> = {}): RevokeMasterAdvisory {
  return {
    scheduled_or_live_practices: 0,
    available_cents: 0,
    frozen_cents: 0,
    pending_withdrawals: 0,
    has_warnings: false,
    ...overrides,
  }
}

let app: App | null = null
let root: HTMLElement | null = null
let router: Router

// The server's copy of the master: a write changes it, and the refetch after
// the write reads it back (as in production), so a test that only mocked the
// write would see the old value return.
let server: AdminMasterDetail

function serve(m: AdminMasterDetail): void {
  server = m
  vi.mocked(adminApi.getMasterById).mockImplementation(async () => ({ ...server }))
}

function change(patch: Partial<AdminMasterDetail>): void {
  server = { ...server, ...patch }
}

async function mount(expectCard = true): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/console/masters/:id',
        name: 'console-masters-detail',
        component: ConsoleMasterDetailView,
      },
      { path: '/console/masters', name: 'console-masters', component: { render: () => null } },
    ],
  })
  await router.push('/console/masters/m1')
  const pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ template: '<RouterView />' })
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
    .use(router)
  app.mount(root)
  if (expectCard) await vi.waitFor(() => expect(row('Email')).toBeDefined())
  return root
}

/** The profile row captioned `label`. */
function row(label: string): HTMLElement | undefined {
  return Array.from(
    root?.querySelectorAll<HTMLElement>('[data-testid="console-field-row"]') ?? [],
  ).find((r) => r.querySelector('.field-row__label')?.textContent?.trim() === label)
}

function inside(scope: ParentNode | undefined, text: string): HTMLButtonElement | undefined {
  return Array.from(scope?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}

function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | null | undefined,
  value: string,
): void {
  if (!el) throw new Error('no field to fill')
  el.value = value
  el.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  vi.mocked(adminApi.getMasterById).mockReset()
  serve(master())
  vi.mocked(adminApi.verifyMaster).mockReset()
  vi.mocked(adminApi.rejectMaster).mockReset()
  vi.mocked(adminApi.editMasterProfile).mockReset()
  vi.mocked(adminApi.editMasterMethods).mockReset()
  vi.mocked(adminApi.setMasterSchoolRight).mockReset()
  vi.mocked(adminApi.getRevokePreview).mockReset().mockResolvedValue(advisory())
  vi.mocked(adminApi.revokeMaster).mockReset()
  // The catalog never loads: parseMethods and the picker use the hardcoded maps.
  vi.mocked(taxonomyApi.getActiveTaxonomy).mockReset().mockRejectedValue(new Error('offline'))
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
  app = null
  root = null
})

describe('ConsoleMasterDetailView: the verdict on a pending application', () => {
  it('verifies at once and leaves for the queue when no method is outside the catalog', async () => {
    vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm1', status: 'verified' })
    await mount()

    inside(
      root?.querySelector('[data-testid="master-review-card"]') ?? undefined,
      'Одобрить',
    )?.click()

    await vi.waitFor(() =>
      expect(adminApi.verifyMaster).toHaveBeenCalledWith('m1', undefined, undefined, false),
    )
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('console-masters'))
    expect(router.currentRoute.value.query).toEqual({ tab: 'pending' })
    expect(dialog()).toBeNull()
  })

  it('grants the school right with the verdict only when the tick is set', async () => {
    vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm1', status: 'verified' })
    await mount()

    root
      ?.querySelector<HTMLButtonElement>('[data-testid="master-review-card"] [role="checkbox"]')
      ?.click()
    inside(
      root?.querySelector('[data-testid="master-review-card"]') ?? undefined,
      'Одобрить',
    )?.click()

    await vi.waitFor(() =>
      expect(adminApi.verifyMaster).toHaveBeenCalledWith('m1', undefined, undefined, true),
    )
  })

  it('pauses on a custom method; "This master only" still verifies, scoped to the master', async () => {
    serve(master({ methods: ['Нестандартный метод'] }))
    vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm1', status: 'verified' })
    await mount()

    inside(
      root?.querySelector('[data-testid="master-review-card"]') ?? undefined,
      'Одобрить',
    )?.click()
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Нестандартный метод'))
    expect(adminApi.verifyMaster).not.toHaveBeenCalled()

    inside(dialog() ?? undefined, 'Только этому мастеру')?.click()

    await vi.waitFor(() =>
      expect(adminApi.verifyMaster).toHaveBeenCalledWith(
        'm1',
        undefined,
        ['Нестандартный метод'],
        false,
      ),
    )
  })

  it('"Add to catalog" verifies and promotes the custom method', async () => {
    serve(master({ methods: ['Нестандартный метод'] }))
    vi.mocked(adminApi.verifyMaster).mockResolvedValue({ user_id: 'm1', status: 'verified' })
    await mount()

    inside(
      root?.querySelector('[data-testid="master-review-card"]') ?? undefined,
      'Одобрить',
    )?.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    inside(dialog() ?? undefined, 'Добавить в каталог')?.click()

    await vi.waitFor(() =>
      expect(adminApi.verifyMaster).toHaveBeenCalledWith(
        'm1',
        ['Нестандартный метод'],
        undefined,
        false,
      ),
    )
  })

  it('tells a failed verification and stays on the card', async () => {
    vi.mocked(adminApi.verifyMaster).mockRejectedValue(new Error('500'))
    await mount()

    inside(
      root?.querySelector('[data-testid="master-review-card"]') ?? undefined,
      'Одобрить',
    )?.click()

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(router.currentRoute.value.name).toBe('console-masters-detail')
  })

  it('will not reject without a reason; with one it rejects and leaves for the queue', async () => {
    vi.mocked(adminApi.rejectMaster).mockResolvedValue({ user_id: 'm1', status: 'rejected' })
    await mount()

    inside(
      root?.querySelector('[data-testid="master-review-card"]') ?? undefined,
      'Отклонить',
    )?.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())

    inside(dialog() ?? undefined, 'Отклонить заявку')?.click()
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Укажите причину отказа'))
    expect(adminApi.rejectMaster).not.toHaveBeenCalled()

    setValue(dialog()?.querySelector('textarea'), '  Documents are missing  ')
    inside(dialog() ?? undefined, 'Отклонить заявку')?.click()

    await vi.waitFor(() =>
      expect(adminApi.rejectMaster).toHaveBeenCalledWith('m1', 'Documents are missing'),
    )
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('console-masters'))
  })
})

describe('ConsoleMasterDetailView: a verified master', () => {
  beforeEach(() => {
    serve(master({ master_status: 'verified' }))
  })

  it('has rights and revoke instead of the verdict', async () => {
    await mount()

    expect(root?.querySelector('[data-testid="master-review-card"]')).toBeNull()
    expect(root?.querySelector('[data-testid="master-rights-card"]')).not.toBeNull()
    expect(root?.querySelector('[data-testid="master-revoke-card"]')).not.toBeNull()
  })

  it('grants the school right with the switch', async () => {
    vi.mocked(adminApi.setMasterSchoolRight).mockImplementation(async (_id, grant) => {
      change({ can_create_schools: grant })
      return { can_create_schools: grant }
    })
    await mount()

    root
      ?.querySelector<HTMLButtonElement>('[data-testid="master-rights-card"] [role="switch"]')
      ?.click()

    await vi.waitFor(() => expect(adminApi.setMasterSchoolRight).toHaveBeenCalledWith('m1', true))
    await vi.waitFor(() =>
      expect(
        root
          ?.querySelector('[data-testid="master-rights-card"] [role="switch"]')
          ?.getAttribute('aria-checked'),
      ).toBe('true'),
    )
  })

  it('warns in the revoke dialog about what stays behind, then revokes and shows the new status', async () => {
    vi.mocked(adminApi.getRevokePreview).mockResolvedValue(
      advisory({ scheduled_or_live_practices: 2, pending_withdrawals: 1, has_warnings: true }),
    )
    vi.mocked(adminApi.revokeMaster).mockImplementation(async () => {
      change({ master_status: 'suspended' })
      return advisory()
    })
    await mount()

    inside(
      root?.querySelector('[data-testid="master-revoke-card"]') ?? undefined,
      'Отозвать мастера',
    )?.click()
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('2 практик'))
    expect(dialog()?.textContent).toContain('1 выплат')

    inside(dialog() ?? undefined, 'Отозвать')?.click()

    await vi.waitFor(() => expect(adminApi.revokeMaster).toHaveBeenCalledWith('m1'))
    await vi.waitFor(() =>
      expect(root?.querySelector('[data-testid="master-rights-card"]')).toBeNull(),
    )
    expect(root?.textContent).toContain('Заблокирован')
  })

  it('says the check did not run when the revoke preview fails, and still lets the revoke through', async () => {
    vi.mocked(adminApi.getRevokePreview).mockRejectedValue(new Error('500'))
    vi.mocked(adminApi.revokeMaster).mockResolvedValue(advisory())
    await mount()

    inside(
      root?.querySelector('[data-testid="master-revoke-card"]') ?? undefined,
      'Отозвать мастера',
    )?.click()
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('не прошла'))
    inside(dialog() ?? undefined, 'Отозвать')?.click()

    await vi.waitFor(() => expect(adminApi.revokeMaster).toHaveBeenCalledWith('m1'))
  })
})

describe('ConsoleMasterDetailView: the profile editor', () => {
  it('sends only the edited field and shows the saved value', async () => {
    vi.mocked(adminApi.editMasterProfile).mockImplementation(async (_id, patch) => {
      change(patch as Partial<AdminMasterDetail>)
      return { user_id: 'm1', status: 'ok' }
    })
    await mount()

    row('Email')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()
    await vi.waitFor(() => expect(row('Email')?.querySelector('input')).not.toBeNull())
    setValue(row('Email')?.querySelector('input'), 'new@example.com')
    inside(row('Email'), 'Сохранить')?.click()

    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', { email: 'new@example.com' }),
    )
    await vi.waitFor(() => expect(row('Email')?.textContent).toContain('new@example.com'))
    expect(row('Email')?.querySelector('input')).toBeNull()
  })

  it('refuses an experience outside 0-50 without a request, and accepts one inside', async () => {
    vi.mocked(adminApi.editMasterProfile).mockResolvedValue({ user_id: 'm1', status: 'ok' })
    await mount()

    row('Опыт')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()
    await vi.waitFor(() => expect(row('Опыт')?.querySelector('input')).not.toBeNull())
    setValue(row('Опыт')?.querySelector('input'), '51')
    inside(row('Опыт'), 'Сохранить')?.click()

    await vi.waitFor(() => expect(row('Опыт')?.textContent).toContain('0–50'))
    expect(adminApi.editMasterProfile).not.toHaveBeenCalled()

    setValue(row('Опыт')?.querySelector('input'), '12')
    inside(row('Опыт'), 'Сохранить')?.click()

    await vi.waitFor(() =>
      expect(adminApi.editMasterProfile).toHaveBeenCalledWith('m1', { experience_years: 12 }),
    )
  })

  it('keeps the editor open with the reason when a save fails', async () => {
    vi.mocked(adminApi.editMasterProfile).mockRejectedValue(new Error('500'))
    await mount()

    row('Телефон')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()
    await vi.waitFor(() => expect(row('Телефон')?.querySelector('input')).not.toBeNull())
    inside(row('Телефон'), 'Сохранить')?.click()

    await vi.waitFor(() => expect(row('Телефон')?.querySelector('[role="alert"]')).not.toBeNull())
    expect(row('Телефон')?.querySelector('input')).not.toBeNull()
  })

  it('opens one editor at a time', async () => {
    await mount()

    row('Email')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()
    await vi.waitFor(() => expect(row('Email')?.querySelector('input')).not.toBeNull())
    row('Телефон')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()

    await vi.waitFor(() => expect(row('Телефон')?.querySelector('input')).not.toBeNull())
    expect(row('Email')?.querySelector('input')).toBeNull()
  })

  it('saves the directions through their own endpoint', async () => {
    vi.mocked(adminApi.editMasterMethods).mockResolvedValue({ user_id: 'm1', status: 'ok' })
    await mount()

    row('Направления практик')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()
    await vi.waitFor(() => expect(inside(row('Направления практик'), 'Сохранить')).toBeDefined())
    inside(row('Направления практик'), 'Сохранить')?.click()

    await vi.waitFor(() =>
      expect(adminApi.editMasterMethods).toHaveBeenCalledWith('m1', ['Медитация']),
    )
  })

  it('needs at least one direction', async () => {
    serve(master({ methods: [] }))
    await mount()

    row('Направления практик')?.querySelector<HTMLButtonElement>('.field-row__pen')?.click()
    await vi.waitFor(() => expect(inside(row('Направления практик'), 'Сохранить')).toBeDefined())
    inside(row('Направления практик'), 'Сохранить')?.click()

    await vi.waitFor(() =>
      expect(row('Направления практик')?.textContent).toContain('хотя бы одно направление'),
    )
    expect(adminApi.editMasterMethods).not.toHaveBeenCalled()
  })
})

describe('ConsoleMasterDetailView: load states', () => {
  it('says the master is not found on a 404', async () => {
    vi.mocked(adminApi.getMasterById).mockRejectedValue(new ApiResponseError(404, 'not found'))
    await mount(false)

    await vi.waitFor(() => expect(root?.textContent).toContain('Заявка не найдена'))
    expect(root?.querySelector('[data-testid="master-profile-form"]')).toBeNull()
  })

  it('shows an error with a retry on another failure, and the card once it loads', async () => {
    vi.mocked(adminApi.getMasterById).mockRejectedValue(new Error('down'))
    await mount(false)
    await vi.waitFor(() =>
      expect(root?.querySelector('[data-testid="screen-error"]')).not.toBeNull(),
    )

    serve(master())
    root?.querySelector<HTMLButtonElement>('[data-testid="screen-error"] button')?.click()

    await vi.waitFor(() =>
      expect(root?.querySelector('[data-testid="master-profile-form"]')).not.toBeNull(),
    )
  })
})
