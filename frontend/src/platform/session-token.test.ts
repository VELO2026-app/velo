// =============================================================================
// VELO Frontend -- platform/session-token.ts (Standalone phase 3)
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { SESSION_TOKEN_KEY, sessionTokenStore } from '@/platform/session-token'
import { telegramPlatform } from '@/platform/telegram'
import { standalonePlatform } from '@/platform/standalone'

describe('sessionTokenStore', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('writes, reads and removes on the carrier it was given -- and only there', () => {
    const store = sessionTokenStore(() => localStorage)

    store.write('tok_1')
    expect(store.read()).toBe('tok_1')
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('tok_1')
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()

    store.write(null)
    expect(store.read()).toBeNull()
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
  })

  it('nothing saved reads as null', () => {
    expect(sessionTokenStore(() => localStorage).read()).toBeNull()
  })

  it('an empty string saved reads as no token', () => {
    localStorage.setItem(SESSION_TOKEN_KEY, '')
    expect(sessionTokenStore(() => localStorage).read()).toBeNull()
  })

  it('an empty token removes rather than saves an empty string', () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'old')
    sessionTokenStore(() => localStorage).write('')
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
  })

  it('storage that throws (blocked, private mode): reads null, writes nothing, never throws', () => {
    const blocked = (): Storage => {
      throw new DOMException('blocked', 'SecurityError')
    }
    const store = sessionTokenStore(blocked)
    expect(store.read()).toBeNull()
    expect(() => store.write('tok')).not.toThrow()
    expect(() => store.write(null)).not.toThrow()
  })
})

// The carriers the two REAL platforms wire (every other test mocks
// @/platform): the reason Telegram never sees a browser sign-in.
describe('the platforms\' carriers', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('standalone keeps the token in localStorage -- across launches', () => {
    standalonePlatform.writeSessionToken('browser_tok')
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('browser_tok')
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
    expect(standalonePlatform.readSessionToken()).toBe('browser_tok')
  })

  it('Telegram keeps it in sessionStorage and never reads localStorage', () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'browser_tok')
    expect(telegramPlatform.readSessionToken()).toBeNull()

    telegramPlatform.writeSessionToken('tg_tok')
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('tg_tok')
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('browser_tok')
  })
})
