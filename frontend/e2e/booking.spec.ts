/**
 * Booking scenario (FE-157 5A.2): a student finds a practice in the calendar,
 * opens it, books it and lands on the confirmation screen.
 */
import { expect, test } from './support/test'
import { mockApi } from './support/api'
import {
  freezeClock,
  makePractice,
  makeUser,
  mockSignedIn,
  paged,
  seedSession,
} from './support/fixtures'

test('student books a free practice from the calendar', async ({ page }) => {
  const api = await mockApi(page)
  const user = makeUser()
  mockSignedIn(api, user)

  const practice = makePractice()
  const id = practice.id as string
  const booking = {
    id: '00000000-0000-4000-8000-0000000000c1',
    practice_id: id,
    user_id: user.id,
    status: 'confirmed',
    purchase_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    joined_at: null,
    left_at: null,
    checkin_skipped: false,
    created_at: '2026-11-10T08:00:00Z',
    updated_at: null,
  }
  let booked = false
  api.on('GET', '/api/v1/practices', () => ({ body: paged([practice]) }))
  api.on('GET', `/api/v1/practices/${id}`, () => ({
    body: { ...practice, is_booked: booked, current_participants: booked ? 4 : 3 },
  }))
  api.on('GET', '/api/v1/bookings/me', () => ({
    body: paged(
      booked
        ? [
            {
              ...booking,
              has_feedback: false,
              has_checkin: false,
              has_reflection: false,
              practice,
            },
          ]
        : [],
    ),
  }))
  api.on('POST', `/api/v1/practices/${id}/purchase`, () => {
    booked = true
    return {
      status: 201,
      body: {
        id: '00000000-0000-4000-8000-0000000000d1',
        user_id: user.id,
        practice_id: id,
        booking_id: booking.id,
        promo_id: null,
        amount_cents: 0,
        discount_cents: 0,
        paid_cents: 0,
        currency: 'USD',
        commission_cents: 0,
        status: 'completed',
        completed_at: '2026-11-10T08:00:00Z',
      },
    }
  })
  await seedSession(page)
  await freezeClock(page)

  // The calendar opens on today, where the practice is.
  await page.goto('/user/calendar')
  await page.getByText('Morning Breathwork').first().click()
  await expect(page).toHaveURL(new RegExp(`/user/practices/${id}$`))

  await page.getByRole('button', { name: 'Book for free' }).click()
  const popup = page.getByRole('dialog')
  await expect(popup.getByText('Morning Breathwork')).toBeVisible()
  await popup.getByRole('button', { name: 'Book', exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/user/booking-confirmed/${id}$`))
  await expect(page.getByRole('heading', { name: 'The practice is booked!' })).toBeVisible()
  expect(api.bodies('POST', `/api/v1/practices/${id}/purchase`)).toHaveLength(1)
  expect(api.unhandled).toEqual([])
})
