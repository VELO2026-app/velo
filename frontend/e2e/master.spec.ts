/**
 * Master scenario (FE-157 5A.2): a verified master fills the create-practice
 * form and publishes.
 */
import { expect, test } from '@playwright/test'
import { mockApi } from './support/api'
import {
  freezeClock,
  makePractice,
  makeUser,
  mockSignedIn,
  paged,
  seedSession,
} from './support/fixtures'

test('master creates and publishes a practice', async ({ page }) => {
  const api = await mockApi(page)
  const master = makeUser({ role: 'master' })
  mockSignedIn(api, master)
  api.on('GET', '/api/v1/masters/me', {
    user_id: master.id,
    status: 'verified',
    display_name: 'Mira Master',
    // The confirmed methods bound the directions the form offers.
    methods: ['Meditation'],
    frozen_cents: 0,
    available_cents: 0,
    min_withdrawal_cents: 1000,
    withdrawal_fee_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    rejection_reason: null,
  })
  api.on('GET', '/api/v1/masters/me/practices', paged([]))
  api.on('GET', '/api/v1/masters/me/groups', { items: [] })
  api.on('GET', '/api/v1/taxonomy', {
    directions: [
      {
        id: '00000000-0000-4000-8000-0000000000e1',
        value: 'meditation',
        label: 'Meditation',
        display_order: 1,
        is_active: true,
        source: 'seed',
        styles: [],
      },
    ],
  })
  const created = makePractice({ status: 'draft', title: 'Evening Meditation' })
  api.on('POST', '/api/v1/practices', () => ({ status: 201, body: created }))
  api.on('PATCH', `/api/v1/practices/${created.id as string}`, () => ({
    body: { ...created, status: 'scheduled' },
  }))
  await seedSession(page)
  await freezeClock(page)

  await page.goto('/master/practices/new')
  await expect(page.getByRole('heading', { name: 'New practice' })).toBeVisible()

  await page.getByPlaceholder('Title', { exact: true }).fill('Evening Meditation')
  await page.getByRole('combobox').nth(0).selectOption('meditation')
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Beginner' })

  // Tomorrow (the clock is frozen on the 10th), 12:00 -- where the time sheet opens.
  await page.getByRole('button', { name: 'Date' }).click()
  await page.getByRole('button', { name: '11', exact: true }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Time' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('combobox').nth(2).selectOption('60')

  await page.getByRole('button', { name: 'Create the practice' }).click()

  await expect(page).toHaveURL(/\/master\/practices$/)
  expect(api.bodies('POST', '/api/v1/practices')).toEqual([
    expect.objectContaining({
      title: 'Evening Meditation',
      direction: 'meditation',
      difficulty: 'beginner',
      scheduled_at: '2026-11-11T12:00:00.000Z',
      duration_minutes: 60,
      is_free: true,
    }),
  ])
  // A fresh practice is published at once: the draft -> scheduled PATCH.
  expect(api.bodies('PATCH', `/api/v1/practices/${created.id as string}`)).toEqual([
    { status: 'scheduled' },
  ])
  expect(api.unhandled).toEqual([])
})
