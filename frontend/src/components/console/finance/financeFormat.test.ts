// =============================================================================
// VELO Frontend -- finance date helpers tests (FE-267)
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  endOfDayIso,
  formatDay,
  formatStamp,
  todayIn,
} from '@/components/console/finance/financeFormat'

describe('formatStamp / formatDay', () => {
  it('writes day, month and time, in the zone asked for', () => {
    expect(formatStamp('2026-11-24T09:12:00Z', 'UTC')).toBe('24.11, 09:12')
    // The same instant, three hours on.
    expect(formatStamp('2026-11-24T09:12:00Z', 'Europe/Moscow')).toBe('24.11, 12:12')
  })

  it('writes a full date', () => {
    expect(formatDay('2026-12-31T10:00:00Z', 'UTC')).toBe('31.12.2026')
  })
})

describe('endOfDayIso', () => {
  it('is the last moment of that calendar day in the zone asked for', () => {
    // Berlin is UTC+1 in winter: 23:59:59.999 there is 22:59:59.999 UTC.
    expect(endOfDayIso('2026-12-31', 'Europe/Berlin')).toBe('2026-12-31T22:59:59.999Z')
    expect(endOfDayIso('2026-12-31', 'UTC')).toBe('2026-12-31T23:59:59.999Z')
  })
})

describe('todayIn', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is the date of this moment in the zone asked for', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T23:30:00Z'))

    expect(todayIn('UTC')).toBe('2026-11-25')
    // Half past eleven at night in London is half past one in the morning in Moscow.
    expect(todayIn('Europe/Moscow')).toBe('2026-11-26')
  })
})
