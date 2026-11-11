// =============================================================================
// VELO Frontend -- keepConfirmedPick (FE-157 stage 4, track 4A)
// =============================================================================
//
// The one rule behind CreatePracticeView's template copy and its re-filter on
// a change of whose methods the pickers offer: a direction / style pick
// survives only while the confirmed set allows it, otherwise the backend
// refuses it on submit (direction_not_confirmed / style_not_confirmed). The
// pickers themselves are pinned through the screen suites.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { keepConfirmedPick } from '@/composables/usePracticeTaxonomyOptions'
import type { PracticeDirection } from '@/api/types'

const confirmed = {
  directions: ['yoga', 'breathwork'] as PracticeDirection[],
  styles: { yoga: ['hatha'] },
}

describe('keepConfirmedPick', () => {
  it('keeps a confirmed direction and style', () => {
    expect(keepConfirmedPick(confirmed, 'yoga', 'hatha')).toEqual({
      direction: 'yoga',
      style: 'hatha',
    })
  })

  it('drops a style the direction does not confirm, keeps the direction', () => {
    expect(keepConfirmedPick(confirmed, 'yoga', 'vinyasa')).toEqual({
      direction: 'yoga',
      style: '',
    })
  })

  it('a direction confirmed WITHOUT styles offers none', () => {
    expect(keepConfirmedPick(confirmed, 'breathwork', 'hatha')).toEqual({
      direction: 'breathwork',
      style: '',
    })
  })

  it('an unconfirmed direction takes its style with it', () => {
    expect(keepConfirmedPick(confirmed, 'meditation', 'hatha')).toEqual({
      direction: '',
      style: '',
    })
  })

  it('an unknown confirmed set keeps nothing (fail closed)', () => {
    expect(keepConfirmedPick(null, 'yoga', 'hatha')).toEqual({ direction: '', style: '' })
  })
})
