// =============================================================================
// VELO Frontend -- Telegram Platform Chrome Tests (T8, PROMPT №437)
// =============================================================================
//
// Covers the chrome tokenisation: #334D6E / #F8FAFC used to be bare literals in
// telegram.ts and existed in NO token, so the header and background around every
// screen sat outside the design system. They are now --velo-tg-header /
// --velo-tg-bg in variables.css, read BY NAME because the Telegram SDK takes a
// colour string and cannot consume a var().
//
// WHY THIS FILE EXISTS: the read has a fallback, and these tests pin which
// branch wins when.
//
// HONESTY NOTE (PROMPT №437). The previous commit claimed this file guards the
// fallback literals against drifting from variables.css. IT DOES NOT, and the
// first version of that test proved the point by passing while --velo-tg-bg was
// changed from #f8fafc to #ffffff and the fallback still said #F8FAFC -- it set
// the token itself and never read the real file. Reading variables.css here
// needs node:fs (no @types/node in this repo), ?raw (empty under vitest), or
// css:true globally -- none justified. The pair is kept in sync by comments on
// both sides instead, and the precedence test below shows why a drift would be
// invisible anyway: the token always wins.
//
// The stylesheet is NOT loaded in happy-dom (vitest imports no CSS), so the
// token is injected onto :root per test -- which is also what makes the
// fallback branch honest to test.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { telegramPlatform } from '@/platform/telegram'

// The fallback literals telegram.ts ships. They MUST mirror --velo-tg-header /
// --velo-tg-bg in variables.css. See the honesty note in the banner above: this
// pair is held in sync by a comment, not by a machine.
const FALLBACK_HEADER = '#334d6e'
const FALLBACK_BG = '#ffffff'

const setHeaderColor = vi.fn()
const setBackgroundColor = vi.fn()
const ready = vi.fn()
const expand = vi.fn()

function installWebApp(): void {
  ;(window as unknown as { Telegram: unknown }).Telegram = {
    WebApp: { ready, expand, setHeaderColor, setBackgroundColor },
  }
}

function setToken(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value)
}

beforeEach(() => {
  installWebApp()
  vi.clearAllMocks()
})

afterEach(() => {
  document.documentElement.style.removeProperty('--velo-tg-header')
  document.documentElement.style.removeProperty('--velo-tg-bg')
  delete (window as unknown as { Telegram?: unknown }).Telegram
})

describe('telegramPlatform.init -- app chrome', () => {
  it('paints the chrome from the design tokens when they are defined', async () => {
    setToken('--velo-tg-header', '#334d6e')
    setToken('--velo-tg-bg', '#f8fafc')

    await telegramPlatform.init()

    expect(setHeaderColor).toHaveBeenCalledWith('#334d6e')
    expect(setBackgroundColor).toHaveBeenCalledWith('#f8fafc')
  })

  it('a re-theme of the token re-themes the chrome -- the token is really the source', async () => {
    // The whole point of the change: change the value in variables.css and the
    // Telegram header follows. If someone reverts to a literal, this goes red.
    setToken('--velo-tg-header', '#123456')
    setToken('--velo-tg-bg', '#abcdef')

    await telegramPlatform.init()

    expect(setHeaderColor).toHaveBeenCalledWith('#123456')
    expect(setBackgroundColor).toHaveBeenCalledWith('#abcdef')
  })

  it('falls back to the shipped literals when the stylesheet has not applied', async () => {
    // getPropertyValue returns '' before the CSS lands. Passing '' to the SDK
    // would throw the colour away; the fallback keeps the chrome as it shipped.
    await telegramPlatform.init()

    expect(setHeaderColor).toHaveBeenCalledWith(FALLBACK_HEADER)
    expect(setBackgroundColor).toHaveBeenCalledWith(FALLBACK_BG)
  })

  it('the token WINS over the fallback -- so drift in the fallback cannot show', async () => {
    // Why there is no test comparing the fallback to variables.css, despite the
    // previous commit message claiming one (wrong, corrected PROMPT №437):
    //
    // Reading variables.css from a test needs node:fs (vue-tsc rejects it -- this
    // repo carries no @types/node), or Vite's ?raw (returns '' because vitest
    // disables the CSS pipeline), or css:true in vitest.config (would newly
    // process CSS for all 500 tests). None is worth it for this.
    //
    // It also matters less than it looks: whenever the stylesheet is present --
    // i.e. always, main.ts:29 imports it before init runs -- the TOKEN wins and
    // the fallback is dead code. If the two ever drift, nothing changes for a
    // user; the fallback would only surface in a world where variables.css
    // failed to load entirely, and there the whole app is unstyled anyway.
    // So: the fallback is insurance that should never pay out, the pair is kept
    // in sync by comments on both sides, and this test pins the precedence that
    // makes drift harmless.
    setToken('--velo-tg-header', '#0a0b0c')
    setToken('--velo-tg-bg', '#0d0e0f')

    await telegramPlatform.init()

    expect(setHeaderColor).toHaveBeenCalledWith('#0a0b0c')
    expect(setHeaderColor).not.toHaveBeenCalledWith(FALLBACK_HEADER)
    expect(setBackgroundColor).toHaveBeenCalledWith('#0d0e0f')
    expect(setBackgroundColor).not.toHaveBeenCalledWith(FALLBACK_BG)
  })

  it('still readies and expands the WebApp', async () => {
    await telegramPlatform.init()

    expect(ready).toHaveBeenCalled()
    expect(expand).toHaveBeenCalled()
  })
})
