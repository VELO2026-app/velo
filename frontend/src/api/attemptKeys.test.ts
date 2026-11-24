// =============================================================================
// VELO Frontend -- api/attemptKeys.ts Unit Tests (FE-232 / FE-104)
// =============================================================================
//
// "One attempt, one key" is pure: tested directly with an injected key source.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { createAttemptKeys } from '@/api/attemptKeys'

function keeper() {
  let n = 0
  const mint = vi.fn(() => `k${++n}`)
  return { keys: createAttemptKeys(mint), mint }
}

describe('createAttemptKeys -- one attempt, one key', () => {
  it('the same parts asked again get the SAME key -- a retry is one write', () => {
    const { keys, mint } = keeper()

    expect(keys.keyFor('payment', 'Текст')).toBe('k1')
    expect(keys.keyFor('payment', 'Текст')).toBe('k1')
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('a changed part gets a NEW key, whichever part it is', () => {
    const { keys } = keeper()

    keys.keyFor('payment', 'Текст')
    expect(keys.keyFor('payment', 'Текст, исправленный')).toBe('k2')
    expect(keys.keyFor('technical', 'Текст, исправленный')).toBe('k3')
  })

  it('parts are not glued: (ab, c) and (a, bc) are different attempts', () => {
    const { keys } = keeper()

    keys.keyFor('ab', 'c')
    expect(keys.keyFor('a', 'bc')).toBe('k2')
  })

  it('going back to an earlier attempt is a new key too -- only the LAST attempt is kept', () => {
    const { keys } = keeper()

    keys.keyFor('payment', 'А')
    keys.keyFor('payment', 'Б')
    expect(keys.keyFor('payment', 'А')).toBe('k3')
  })

  it('release makes the same parts a new write', () => {
    const { keys } = keeper()

    keys.keyFor('t1', 'Ok')
    keys.release()
    expect(keys.keyFor('t1', 'Ok')).toBe('k2')
  })

  it('two keepers (two form instances) never share a key', () => {
    let n = 0
    const mint = () => `k${++n}`
    const a = createAttemptKeys(mint)
    const b = createAttemptKeys(mint)

    expect(a.keyFor('payment', 'Текст')).not.toBe(b.keyFor('payment', 'Текст'))
  })

  it('the default key source yields a non-empty key', () => {
    const keys = createAttemptKeys()

    const key = keys.keyFor('payment', 'Текст')
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
    expect(keys.keyFor('payment', 'Текст')).toBe(key)
  })
})
