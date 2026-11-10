// =============================================================================
// VELO Frontend -- usePracticeForm (FE-157 stage 4, track 4A)
// =============================================================================
//
// The shared model behind CreatePracticeView and EditPracticeView. The screen
// suites pin each screen end to end; this file pins the rules both screens now
// share, at the seam where they are decided:
//   - one validation, with the future check switchable per screen (edit runs
//     it only when the schedule moved -- the one case the backend refuses);
//   - after a failed validation a fixed field loses its error, and editing
//     never adds one before the next validate();
//   - the PATCH carries only changed fields, coupled ones in pairs.
//
// Messages are compared through t() rather than as literals: the ru catalog
// is the test locale, and the assertion is "this slot got that message".
// Instants are pinned through rules.now, so no fake timers are needed.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { t } from '@/locales'
import {
  emptyPracticeForm,
  practiceToForm,
  scheduleChanged,
  snapshotPracticeForm,
  toCreatePayload,
  toPracticePatch,
  usePracticeForm,
  validatePracticeForm,
  type PracticeFormValues,
} from '@/composables/usePracticeForm'
import type { PracticeResponse } from '@/api/types'

// 2026-07-20 12:00Z == 15:00 in Europe/Moscow (UTC+3, no DST).
const NOW = Date.parse('2026-07-20T12:00:00Z')

function filled(over: Partial<PracticeFormValues> = {}): PracticeFormValues {
  return {
    ...emptyPracticeForm('Europe/Moscow'),
    title: 'Morning',
    direction: 'yoga',
    difficulty: 'beginner',
    date: '2026-07-25',
    time: '12:00',
    duration_minutes: '60',
    ...over,
  }
}

const msg = {
  futureDate: () => t('masterScreens.createPractice.validation.futureDate'),
  enterTitle: () => t('masterScreens.createPractice.validation.enterTitle'),
}

describe('validatePracticeForm', () => {
  it('a blank form names every required slot', () => {
    const e = validatePracticeForm(emptyPracticeForm(), { checkFuture: true, now: NOW })
    expect(e.title).toBe(msg.enterTitle())
    expect(e.direction).not.toBe('')
    expect(e.difficulty).not.toBe('')
    expect(e.date).not.toBe('')
    expect(e.time).not.toBe('')
    expect(e.duration_minutes).not.toBe('')
    expect(e.max_participants).toBe('')
  })

  it('a filled form passes', () => {
    const e = validatePracticeForm(filled(), { checkFuture: true, now: NOW })
    expect(Object.values(e).every((m) => m === '')).toBe(true)
  })

  it("the future check reads the wall-clock in the FORM's zone", () => {
    // 14:00 Moscow today is 11:00Z -- an hour gone at 12:00Z, whatever the
    // runner's own zone; 16:00 Moscow (13:00Z) is still ahead.
    const past = filled({ date: '2026-07-20', time: '14:00' })
    const ahead = filled({ date: '2026-07-20', time: '16:00' })
    expect(validatePracticeForm(past, { checkFuture: true, now: NOW }).date).toBe(msg.futureDate())
    expect(validatePracticeForm(ahead, { checkFuture: true, now: NOW }).date).toBe('')
  })

  it('without the future check a started practice is still valid (edit, schedule untouched)', () => {
    const started = filled({ date: '2026-07-20', time: '14:00' })
    expect(validatePracticeForm(started, { checkFuture: false, now: NOW }).date).toBe('')
  })

  it('the series rules apply only while the recurring toggle is on', () => {
    const series = filled({ is_recurring: true, recurrence: 'weekly', recurrence_days: [] })
    expect(validatePracticeForm(series, { checkFuture: true, now: NOW }).recurrence_days).not.toBe(
      '',
    )
    const oneOff = { ...series, is_recurring: false }
    expect(validatePracticeForm(oneOff, { checkFuture: true, now: NOW }).recurrence_days).toBe('')
  })

  it('a schools audience without its school reports into the audience slot', () => {
    const e = validatePracticeForm(filled({ audience_kind: 'schools', audience_school_id: null }), {
      checkFuture: true,
      now: NOW,
    })
    expect(e.audience_group_ids).toBe(t('masterScreens.createPractice.validation.chooseSchool'))
  })
})

describe('usePracticeForm: errors after a failed validate()', () => {
  it('a fixed field loses its own error at once; the others stay', async () => {
    const scope = effectScope()
    const { form, errors, validate } = scope.run(() =>
      usePracticeForm(emptyPracticeForm('Europe/Moscow'), () => ({ checkFuture: true, now: NOW })),
    )!
    expect(validate()).toBe(false)
    expect(errors.title).toBe(msg.enterTitle())

    form.title = 'Morning'
    await nextTick()

    expect(errors.title).toBe('')
    expect(errors.direction).not.toBe('')
    scope.stop()
  })

  it('editing never ADDS an error, before or after a failed validate()', async () => {
    const scope = effectScope()
    const { form, errors, validate } = scope.run(() =>
      usePracticeForm(filled(), () => ({ checkFuture: true, now: NOW })),
    )!
    form.title = ''
    await nextTick()
    expect(errors.title).toBe('')

    form.direction = ''
    expect(validate()).toBe(false)
    form.max_participants_raw = '0'
    await nextTick()
    expect(errors.max_participants).toBe('')
    scope.stop()
  })
})

describe('toPracticePatch: only what changed, coupled fields in pairs', () => {
  const base = filled({ is_free: false, price_eur_raw: '25.99' })

  it('an untouched form sends nothing', () => {
    expect(toPracticePatch(snapshotPracticeForm(base), base, false)).toBeNull()
  })

  it('a moved time sends the instant, not the untouched zone', () => {
    const body = toPracticePatch({ ...base, time: '13:00' }, base, false)
    expect(body).toEqual({ scheduled_at: '2026-07-25T10:00:00.000Z' })
  })

  it('a changed zone travels with the instant it reinterprets', () => {
    const body = toPracticePatch({ ...base, timezone: 'Europe/Berlin' }, base, false)
    expect(body).toEqual({ scheduled_at: '2026-07-25T10:00:00.000Z', timezone: 'Europe/Berlin' })
  })

  it('price and the free flag travel together', () => {
    expect(toPracticePatch({ ...base, is_free: true }, base, false)).toEqual({
      is_free: true,
      price_cents: 0,
    })
  })

  it('the audience pair travels only when the screen says it changed', () => {
    const groups = { ...base, audience_kind: 'groups' as const, audience_group_ids: ['g1'] }
    expect(toPracticePatch(groups, base, true)).toEqual({
      audience_kind: 'groups',
      group_ids: ['g1'],
    })
    expect(toPracticePatch(groups, base, false)).toBeNull()
  })

  it('a date and time that form no instant abort the PATCH', () => {
    expect(toPracticePatch({ ...base, time: '25:99' }, base, false)).toBeUndefined()
  })

  it('scheduleChanged follows exactly the fields that put scheduled_at in the PATCH', () => {
    expect(scheduleChanged(base, base)).toBe(false)
    expect(scheduleChanged({ ...base, title: 'Other' }, base)).toBe(false)
    expect(scheduleChanged({ ...base, date: '2026-07-26' }, base)).toBe(true)
  })
})

describe('toCreatePayload / practiceToForm', () => {
  it('the create body nulls blank optionals and ships the start in the form zone', () => {
    const body = toCreatePayload(filled({ style: '  ', description: ' ' }))
    expect(body).toMatchObject({
      practice_type: 'live',
      style: null,
      description: null,
      scheduled_at: '2026-07-25T09:00:00.000Z',
      duration_minutes: 60,
      price_cents: 0,
      recurrence: null,
      group_ids: [],
      school_id: null,
    })
  })

  it('a stored practice renders in its OWN zone and round-trips to an empty PATCH', () => {
    const p = {
      title: 'Morning',
      scheduled_at: '2026-07-22T10:00:00Z',
      timezone: 'Europe/Moscow',
      duration_minutes: 45,
      max_participants: null,
      is_free: false,
      price_cents: 2599,
      direction: 'yoga',
      difficulty: null,
      style: null,
      description: null,
      what_to_prepare: null,
      contraindications: null,
      school_id: 's1',
    } as unknown as PracticeResponse
    const v = practiceToForm(p)
    expect(v).toMatchObject({
      date: '2026-07-22',
      time: '13:00',
      duration_minutes: '45',
      max_participants_raw: '',
      price_eur_raw: '25.99',
      difficulty: '',
      audience_school_id: 's1',
    })
    expect(toPracticePatch(snapshotPracticeForm(v), v, false)).toBeNull()
  })
})
