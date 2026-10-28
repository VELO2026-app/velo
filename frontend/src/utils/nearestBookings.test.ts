// =============================================================================
// VELO Frontend -- nearestBookings.ts Unit Tests (TASK-2)
// =============================================================================

import { describe, it, expect } from 'vitest'
import { selectNearestBookings, selectActionableBookings } from '@/utils/nearestBookings'
import type { BookingWithPracticeResponse } from '@/api/types'

const NOW = 1_700_000_000_000 // fixed epoch ms

/** Minimal booking: only the fields selectNearestBookings reads. */
function makeBooking(opts: {
  id: string
  startOffsetMin: number
  durationMin?: number
  status?: string // booking status
  practiceStatus?: string
}): BookingWithPracticeResponse {
  return {
    id: opts.id,
    practice_id: `p-${opts.id}`,
    status: opts.status ?? 'confirmed',
    has_checkin: false,
    practice: {
      status: opts.practiceStatus ?? 'scheduled',
      scheduled_at: new Date(NOW + opts.startOffsetMin * 60_000).toISOString(),
      duration_minutes: opts.durationMin ?? 60,
    },
  } as unknown as BookingWithPracticeResponse
}

const ids = (list: BookingWithPracticeResponse[]) => list.map((b) => b.id)

describe('selectNearestBookings', () => {
  it('pins the live session first, then the 2 soonest upcoming (max 3, ordering)', () => {
    const bookings = [
      makeBooking({ id: 'up3', startOffsetMin: 180 }), // 3rd upcoming (dropped)
      makeBooking({ id: 'up1', startOffsetMin: 30 }), //  soonest upcoming
      makeBooking({ id: 'live', startOffsetMin: -10 }), // in progress (started 10m ago)
      makeBooking({ id: 'up2', startOffsetMin: 90 }), //  2nd upcoming
    ]
    const result = selectNearestBookings(bookings, NOW)
    // live pinned first, then upcoming soonest-first; the 3rd upcoming is capped out.
    expect(ids(result)).toEqual(['live', 'up1', 'up2'])
    expect(result).toHaveLength(3)
  })

  it('with two live sessions keeps only the single latest-started, still + 2 upcoming', () => {
    const bookings = [
      makeBooking({ id: 'liveOld', startOffsetMin: -50 }),
      makeBooking({ id: 'liveNew', startOffsetMin: -5 }), // latest-started wins
      makeBooking({ id: 'up1', startOffsetMin: 20 }),
      makeBooking({ id: 'up2', startOffsetMin: 40 }),
    ]
    expect(ids(selectNearestBookings(bookings, NOW))).toEqual(['liveNew', 'up1', 'up2'])
  })

  it('nothing live -> just the 2 soonest upcoming, soonest first', () => {
    const bookings = [
      makeBooking({ id: 'up2', startOffsetMin: 120 }),
      makeBooking({ id: 'up1', startOffsetMin: 15 }),
      makeBooking({ id: 'up3', startOffsetMin: 300 }),
    ]
    const result = selectNearestBookings(bookings, NOW)
    expect(ids(result)).toEqual(['up1', 'up2'])
    expect(result).toHaveLength(2)
  })

  it('excludes non-confirmed, completed/cancelled, and already-ended bookings', () => {
    const bookings = [
      makeBooking({ id: 'pending', startOffsetMin: 10, status: 'attended' }),
      makeBooking({ id: 'cancelledPractice', startOffsetMin: 10, practiceStatus: 'cancelled' }),
      makeBooking({ id: 'completedPractice', startOffsetMin: 10, practiceStatus: 'completed' }),
      makeBooking({ id: 'ended', startOffsetMin: -120, durationMin: 60 }), // ended 1h ago
      makeBooking({ id: 'ok', startOffsetMin: 25 }),
    ]
    expect(ids(selectNearestBookings(bookings, NOW))).toEqual(['ok'])
  })

  it('is empty when there are no eligible bookings', () => {
    expect(selectNearestBookings([], NOW)).toEqual([])
  })
})

describe('selectActionableBookings (FE-56: the check-in banner pool)', () => {
  it('returns ALL eligible bookings soonest-first -- no top-3 cap', () => {
    // 4 upcoming + a live session: the LIST would cap this at 3, the banner
    // pool must keep every still-actionable booking.
    const bookings = [
      makeBooking({ id: 'up4', startOffsetMin: 240 }),
      makeBooking({ id: 'live', startOffsetMin: -10 }),
      makeBooking({ id: 'up2', startOffsetMin: 90 }),
      makeBooking({ id: 'up3', startOffsetMin: 180 }),
      makeBooking({ id: 'up1', startOffsetMin: 30 }),
    ]
    expect(ids(selectActionableBookings(bookings, NOW))).toEqual([
      'live',
      'up1',
      'up2',
      'up3',
      'up4',
    ])
  })

  it('excludes non-confirmed, completed/cancelled, and already-ended bookings', () => {
    const bookings = [
      makeBooking({ id: 'pending', startOffsetMin: 10, status: 'attended' }),
      makeBooking({ id: 'cancelledPractice', startOffsetMin: 10, practiceStatus: 'cancelled' }),
      makeBooking({ id: 'completedPractice', startOffsetMin: 10, practiceStatus: 'completed' }),
      makeBooking({ id: 'ended', startOffsetMin: -120, durationMin: 60 }), // ended 1h ago
      makeBooking({ id: 'ok1', startOffsetMin: 25 }),
      makeBooking({ id: 'ok2', startOffsetMin: 85 }),
    ]
    expect(ids(selectActionableBookings(bookings, NOW))).toEqual(['ok1', 'ok2'])
  })

  it('is empty when there are no eligible bookings', () => {
    expect(selectActionableBookings([], NOW)).toEqual([])
  })
})
