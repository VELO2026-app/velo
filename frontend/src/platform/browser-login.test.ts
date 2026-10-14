// =============================================================================
// VELO Frontend -- platform/browser-login.ts (Standalone phase 3)
// =============================================================================
//
// The mark (one-time, localStorage) and the return (read once, wiped from
// the address bar). Driven on happy-dom's real window: history.replaceState
// moves window.location the way a browser does.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  LOGIN_MARK_KEY,
  RETURN_PATH,
  newMark,
  rememberLoginMark,
  takeLoginMark,
  takeLoginReturn,
} from '@/platform/browser-login'

function openAt(url: string): void {
  window.history.replaceState(null, '', url)
}

describe('newMark', () => {
  it('is 43 base64url characters -- within the backend bounds (32..128, [A-Za-z0-9_-])', () => {
    const mark = newMark()
    expect(mark).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('is fresh every time', () => {
    const marks = new Set(Array.from({ length: 50 }, () => newMark()))
    expect(marks.size).toBe(50)
  })
})

describe('the mark', () => {
  beforeEach(() => localStorage.clear())

  it('is taken once: the second take finds nothing', () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    expect(takeLoginMark()).toEqual({ state: 'S1', mark: 'M1' })
    expect(takeLoginMark()).toBeNull()
    expect(localStorage.getItem(LOGIN_MARK_KEY)).toBeNull()
  })

  it('a later start replaces the earlier one', () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    rememberLoginMark({ state: 'S2', mark: 'M2' })
    expect(takeLoginMark()).toEqual({ state: 'S2', mark: 'M2' })
  })

  it.each([
    ['not JSON', '{oops'],
    ['no mark', JSON.stringify({ state: 'S' })],
    ['empty mark', JSON.stringify({ state: 'S', mark: '' })],
    ['empty state', JSON.stringify({ state: '', mark: 'M' })],
    ['wrong types', JSON.stringify({ state: 1, mark: 2 })],
    ['null', 'null'],
  ])('garbage (%s) reads as no mark -- and is removed', (_label, raw) => {
    localStorage.setItem(LOGIN_MARK_KEY, raw)
    expect(takeLoginMark()).toBeNull()
    expect(localStorage.getItem(LOGIN_MARK_KEY)).toBeNull()
  })

  it('storage that throws: no mark (the return is then refused -- the safe side)', () => {
    const blocked = (): Storage => {
      throw new DOMException('blocked', 'SecurityError')
    }
    expect(() => rememberLoginMark({ state: 'S', mark: 'M' }, blocked)).not.toThrow()
    expect(takeLoginMark(blocked)).toBeNull()
  })
})

describe('takeLoginReturn', () => {
  beforeEach(() => openAt('/'))

  it('reads code and state and wipes them from the address -- history.state kept', () => {
    openAt(`${RETURN_PATH}?code=C1&state=S1`)
    window.history.replaceState({ router: 'owned' }, '', window.location.href)

    expect(takeLoginReturn()).toEqual({ code: 'C1', state: 'S1', error: null })
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')
    expect(window.history.state).toEqual({ router: 'owned' })
  })

  it('a second read of the same page finds nothing -- a reload cannot replay the state', () => {
    openAt(`${RETURN_PATH}?code=C1&state=S1`)
    takeLoginReturn()
    expect(takeLoginReturn()).toBeNull()
  })

  it('reads an error from Telegram', () => {
    openAt(`${RETURN_PATH}?error=access_denied&state=S1`)
    expect(takeLoginReturn()).toEqual({ code: null, state: 'S1', error: 'access_denied' })
    expect(window.location.search).toBe('')
  })

  it('the return path with nothing on it is not a return', () => {
    openAt(RETURN_PATH)
    expect(takeLoginReturn()).toBeNull()
  })

  it('empty parameters count as absent', () => {
    openAt(`${RETURN_PATH}?code=&state=`)
    expect(takeLoginReturn()).toBeNull()
  })

  it('any other page is left alone -- its query untouched', () => {
    openAt('/user/dashboard?code=C1&state=S1')
    expect(takeLoginReturn()).toBeNull()
    expect(window.location.pathname).toBe('/user/dashboard')
    expect(window.location.search).toBe('?code=C1&state=S1')
  })
})
