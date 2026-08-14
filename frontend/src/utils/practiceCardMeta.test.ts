import { describe, it, expect } from 'vitest'
import { checkinLabel } from './practiceCardMeta'
import type { PracticeResponse } from '@/api/types'

function basePractice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'm1',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Test practice',
    description: null,
    scheduled_at: '2026-08-01T10:00:00Z',
    duration_minutes: 60,
    timezone: 'Europe/Moscow',
    max_participants: 12,
    current_participants: 8,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'eur',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  } as PracticeResponse
}

describe('checkinLabel', () => {
  it('renders a filled count as "N/M" against max_participants', () => {
    expect(checkinLabel(basePractice({ checkin_count: 7, max_participants: 12 }))).toBe('7/12')
  })

  it('falls back to current_participants when max_participants is null (unlimited)', () => {
    expect(
      checkinLabel(
        basePractice({ checkin_count: 3, max_participants: null, current_participants: 5 }),
      ),
    ).toBe('3/5')
  })

  it('renders a real zero as "0/M", not omitted (operator: the fraction is honest, not empty)', () => {
    expect(checkinLabel(basePractice({ checkin_count: 0, max_participants: 12 }))).toBe('0/12')
  })

  it('returns null for a non-owner surface (checkin_count=null) -- never a fabricated "0/M"', () => {
    expect(checkinLabel(basePractice({ checkin_count: null }))).toBeNull()
  })

  it('returns null when checkin_count is entirely absent (undefined)', () => {
    expect(checkinLabel(basePractice({ checkin_count: undefined }))).toBeNull()
  })
})
