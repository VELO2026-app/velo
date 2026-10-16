// =============================================================================
// VELO Frontend -- platform/zoom-sdk.ts Unit Tests (Standalone F4)
// =============================================================================
//
// The Meeting SDK itself is mocked at its module boundary: what this module
// owns is the HAND-OVER -- the order (preLoadWasm, prepareWebSDK, init, join),
// what goes into init (leaveUrl, leaveOnPageUnload) and join (exactly one of
// tk+userEmail / zak, never an empty-string credential), how a callback
// error becomes a ZoomSdkError with its stage and code, and that the SDK is
// loaded once per page. Zoom's client is Zoom's to test.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ZoomSdkJoinResponse } from '@/api/types'

type Callbacks = { success: () => void; error: (e: unknown) => void }

const calls: string[] = []
const initArgs: Array<Record<string, unknown>> = []
const joinArgs: Array<Record<string, unknown>> = []
const outcome = {
  init: { ok: true, error: null as unknown },
  join: { ok: true, error: null as unknown },
}
const leaveMeeting = vi.fn()
const loadCount = { n: 0 }

vi.mock('@zoom/meetingsdk', () => {
  loadCount.n += 1
  return {
    ZoomMtg: {
      preLoadWasm: () => calls.push('preLoadWasm'),
      prepareWebSDK: () => calls.push('prepareWebSDK'),
      init: (args: Record<string, unknown> & Callbacks) => {
        calls.push('init')
        initArgs.push(args)
        if (outcome.init.ok) args.success()
        else args.error(outcome.init.error)
      },
      join: (args: Record<string, unknown> & Callbacks) => {
        calls.push('join')
        joinArgs.push(args)
        if (outcome.join.ok) args.success()
        else args.error(outcome.join.error)
      },
      leaveMeeting: (args: unknown) => leaveMeeting(args),
    },
  }
})

const sdk = await import('@/platform/zoom-sdk')

/** F4 fix: the top inset the practice screen hands over (useSafeArea). */
const OPTS = { insetTop: '59px' }

const ATTENDEE: ZoomSdkJoinResponse = {
  sdk_key: 'k',
  signature: 'sig',
  meeting_number: '123',
  password: 'pw',
  user_name: 'Ученик User',
  role: 0,
  tk: 'tk-1',
  user_email: 'user-1@users.velo.invalid',
  zak: null,
}
const HOST: ZoomSdkJoinResponse = {
  ...ATTENDEE,
  role: 1,
  tk: null,
  user_email: null,
  zak: 'zak-1',
}

beforeEach(() => {
  calls.length = 0
  initArgs.length = 0
  joinArgs.length = 0
  outcome.init = { ok: true, error: null }
  outcome.join = { ok: true, error: null }
  leaveMeeting.mockReset()
  sdk._resetZoomSdkForTest()
})

describe('enterZoomMeeting', () => {
  it('prepares, inits with the leaveUrl, then joins -- in that order', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/user/feedback/p1', OPTS)

    expect(calls).toEqual(['preLoadWasm', 'prepareWebSDK', 'init', 'join'])
    expect(initArgs[0]).toMatchObject({
      leaveUrl: 'https://app.test/user/feedback/p1',
      leaveOnPageUnload: true,
    })
  })

  it('an attendee joins with tk and the registration email, and NO zak key at all', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)

    const args = joinArgs[0]!
    expect(args).toMatchObject({
      meetingNumber: '123',
      userName: 'Ученик User',
      signature: 'sig',
      passWord: 'pw',
      tk: 'tk-1',
      userEmail: 'user-1@users.velo.invalid',
    })
    expect('zak' in args).toBe(false)
  })

  it('the host joins with zak, and NO tk or userEmail keys at all', async () => {
    await sdk.enterZoomMeeting(HOST, 'https://app.test/master/dashboard', OPTS)

    const args = joinArgs[0]!
    expect(args.zak).toBe('zak-1')
    expect('tk' in args).toBe(false)
    expect('userEmail' in args).toBe(false)
  })

  it('a meeting with no passcode passes the empty one through (the SDK wants "")', async () => {
    await sdk.enterZoomMeeting({ ...ATTENDEE, password: '' }, 'https://app.test/x', OPTS)

    expect(joinArgs[0]!.passWord).toBe('')
  })

  it('init failing rejects with stage "init" and the SDK errorCode -- join is never called', async () => {
    outcome.init = { ok: false, error: { errorCode: 3712 } }

    await expect(sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)).rejects.toMatchObject({
      name: 'ZoomSdkError',
      stage: 'init',
      code: 3712,
    })
    expect(calls).not.toContain('join')
  })

  it('join failing rejects with stage "join"; an error without a code keeps code null', async () => {
    outcome.join = { ok: false, error: 'boom' }

    await expect(sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)).rejects.toMatchObject({
      stage: 'join',
      code: null,
    })
  })

  it('REPEAT: the SDK module is loaded once per page, however many entries', async () => {
    const before = loadCount.n
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)

    expect(loadCount.n - before).toBeLessThanOrEqual(1)
    expect(sdk.zoomSdkLoaded()).toBe(true)
  })
})

describe('leaveZoomMeeting / zoomSdkLoaded', () => {
  it('before any entry: not loaded, and leaving is a no-op', () => {
    expect(sdk.zoomSdkLoaded()).toBe(false)
    sdk.leaveZoomMeeting()
    expect(leaveMeeting).not.toHaveBeenCalled()
  })

  it('after an entry: leaving asks the SDK to leave (it then navigates to leaveUrl)', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)
    sdk.leaveZoomMeeting()
    expect(leaveMeeting).toHaveBeenCalledTimes(1)
  })
})

describe('appUrl', () => {
  it('turns an app path into an absolute URL on this origin', () => {
    expect(sdk.appUrl('/user/feedback/p1')).toBe(
      new URL('/user/feedback/p1', window.location.origin).toString(),
    )
  })
})

// =============================================================================
// F4 fix (iPhone): the SDK's root and both its panels sat under the status
// bar and on the home bar. For the meeting only, a class on <html> and one
// <style> move the root's own edges into the safe area and paint the canvas
// black. What happy-dom can hold: that the style is there DURING the meeting,
// scoped so it cannot reach our screens, covers all four edges, and is gone
// after any failure. Where the panels actually land is the iPhone's to say.
// =============================================================================
describe('the meeting safe-area style', () => {
  function styleEl(): HTMLStyleElement | null {
    return document.getElementById(sdk.MEETING_STYLE_ID) as HTMLStyleElement | null
  }
  function hasClass(): boolean {
    return document.documentElement.classList.contains(sdk.MEETING_CLASS)
  }
  function insetVar(): string {
    return document.documentElement.style.getPropertyValue(sdk.MEETING_INSET_TOP_VAR)
  }

  it('is absent before any entry', () => {
    expect(hasClass()).toBe(false)
    expect(styleEl()).toBeNull()
  })

  it('is on for the meeting: the class, ONE style, the top inset handed over', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)

    expect(hasClass()).toBe(true)
    expect(document.querySelectorAll(`#${sdk.MEETING_STYLE_ID}`)).toHaveLength(1)
    expect(insetVar()).toBe('59px')
  })

  it('moves all four EDGES of the root (not padding) and lets go of its fixed size', () => {
    const css = sdk.MEETING_STYLE
    expect(css).toMatch(/#zmmtg-root\s*\{/)
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(css).toContain(`env(safe-area-inset-${edge}, 0px)`)
    }
    expect(css).toMatch(/top:\s*var\(--velo-zoom-inset-top, env\(safe-area-inset-top, 0px\)\)/)
    expect(css).toMatch(/width:\s*auto/)
    expect(css).toMatch(/height:\s*auto/)
    expect(css).not.toMatch(/padding/)
    expect(css).toMatch(/background:\s*#000/)
  })

  it('every rule is scoped under html.velo-zoom-meeting -- it cannot reach a screen of ours', () => {
    const selectors = sdk.MEETING_STYLE.split('}')
      .map((block) => block.split('{')[0]!.trim())
      .filter(Boolean)
      .flatMap((group) => group.split(',').map((sel) => sel.trim()))
    expect(selectors.length).toBeGreaterThan(0)
    for (const sel of selectors) {
      expect(sel.startsWith(`html.${sdk.MEETING_CLASS}`)).toBe(true)
    }
  })

  it('REPEAT: a second entry on the same page adds no second <style>', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)

    expect(document.querySelectorAll(`#${sdk.MEETING_STYLE_ID}`)).toHaveLength(1)
  })

  it('init failing takes it all off again -- the practice screen is left as it was', async () => {
    outcome.init = { ok: false, error: { errorCode: 1 } }

    await expect(sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)).rejects.toThrow()

    expect(hasClass()).toBe(false)
    expect(styleEl()).toBeNull()
    expect(insetVar()).toBe('')
  })

  it('join failing takes it all off again too', async () => {
    outcome.join = { ok: false, error: 'boom' }

    await expect(sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)).rejects.toThrow()

    expect(hasClass()).toBe(false)
    expect(styleEl()).toBeNull()
  })

  it('EMPTINESS: an empty top inset sets no variable -- the env() fallback applies', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', { insetTop: '' })

    expect(hasClass()).toBe(true)
    expect(insetVar()).toBe('')
  })

  it('setZoomInsetTop follows a changed inset (Telegram insets arrive late)', async () => {
    await sdk.enterZoomMeeting(ATTENDEE, 'https://app.test/x', OPTS)
    sdk.setZoomInsetTop('70px')

    expect(insetVar()).toBe('70px')
  })
})
