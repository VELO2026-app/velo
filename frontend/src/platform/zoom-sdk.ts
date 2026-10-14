// =============================================================================
// VELO Frontend -- Zoom inside the app: the Meeting SDK, client view
// (Standalone F4)
// =============================================================================
//
// The practice screen enters Zoom HERE instead of opening a Zoom link. The
// server decides who may enter and mints the parameters (POST
// .../zoom/sdk-join); this module only loads the SDK and hands them over.
// It lives in platform/ because the SDK takes over the host page (its own
// <body> node, global CSS, navigation on leave) -- host access stays behind
// the seam (eslint no-restricted-globals).
//
// LAZY, ON PURPOSE. @zoom/meetingsdk is about 5 MB with React and redux
// behind it. It is imported with a dynamic import() at the moment somebody
// presses «Войти» / «Начать», never at module load: no other screen pays for
// it, and the service worker's precache keeps it out too (vite.config.ts
// manualChunks 'zoom-sdk' + globIgnores). The SDK's own media files (av,
// WASM, CSS) come from Zoom's CDN, source.zoom.us/<version>/lib -- the SDK's
// default, so nothing of that sits in our build either.
//
// CLIENT VIEW OWNS THE PAGE. It draws a full-page Zoom UI into its own node
// on <body> and global styles; nothing unmounts it cleanly from an SPA. The
// one way out is the SDK's own: leaveUrl, a FULL page load. Leaving the
// meeting (or the host ending it) navigates there, which also reloads VELO
// into a clean page -- the session survives in persistent storage (F3).
// =============================================================================

import type { ZoomSdkJoinResponse } from '@/api/types'
import { host } from './host'

/** Where the SDK stopped: loading its code, init(), or join(). `code` is the
 * SDK's own errorCode when it gave one. */
export class ZoomSdkError extends Error {
  constructor(
    readonly stage: 'load' | 'init' | 'join',
    readonly code: number | null = null,
  ) {
    super(`Zoom SDK ${stage} failed${code === null ? '' : ` (${code})`}`)
    this.name = 'ZoomSdkError'
  }
}

type ZoomMtgModule = typeof import('@zoom/meetingsdk')
type ZoomMtg = ZoomMtgModule['ZoomMtg']

/** Set once the SDK has been loaded on this page -- a page enters Zoom once
 * (leaving reloads it), so there is never a second instance to track. */
let loaded: ZoomMtg | null = null

/** The SDK's errorCode off whatever its error callback received, or null. */
function errorCodeOf(payload: unknown): number | null {
  if (payload && typeof payload === 'object' && 'errorCode' in payload) {
    const code = payload.errorCode
    return typeof code === 'number' ? code : null
  }
  return null
}

/**
 * Load the SDK (once per page) and enter the meeting with the server's
 * parameters. Resolves when join() reported success -- from then on the SDK
 * owns the page until leaveUrl reloads it. Rejects with ZoomSdkError.
 *
 * `leaveUrl` must be an absolute URL of THIS app (the SDK navigates to it).
 */
export async function enterZoomMeeting(join: ZoomSdkJoinResponse, leaveUrl: string): Promise<void> {
  let mtg: ZoomMtg
  try {
    mtg = loaded ?? (await import('@zoom/meetingsdk')).ZoomMtg
  } catch {
    throw new ZoomSdkError('load')
  }
  loaded = mtg
  mtg.preLoadWasm()
  mtg.prepareWebSDK()

  await new Promise<void>((resolve, reject) => {
    // The SDK types init/join as `void | Promise`: with callbacks passed, the
    // callbacks are the contract and any returned promise is not ours.
    void mtg.init({
      leaveUrl,
      // Shut the session at once on reload/close instead of Zoom's failover
      // wait: a person who closed the app has left.
      leaveOnPageUnload: true,
      success: () => resolve(),
      error: (e: unknown) => reject(new ZoomSdkError('init', errorCodeOf(e))),
    })
  })

  await new Promise<void>((resolve, reject) => {
    void mtg.join({
      meetingNumber: join.meeting_number,
      userName: join.user_name,
      signature: join.signature,
      passWord: join.password,
      // Exactly one of the two credentials is set by the server: tk (with
      // the registrant's email) for an attendee, zak for the host. An absent
      // one is passed as absent, not as an empty string the SDK might read.
      ...(join.tk ? { tk: join.tk } : {}),
      ...(join.user_email ? { userEmail: join.user_email } : {}),
      ...(join.zak ? { zak: join.zak } : {}),
      success: () => resolve(),
      error: (e: unknown) => reject(new ZoomSdkError('join', errorCodeOf(e))),
    })
  })
}

/** True once the SDK has been loaded on this page. */
export function zoomSdkLoaded(): boolean {
  return loaded !== null
}

/** Leave the meeting the SDK holds -- which navigates to leaveUrl. No-op
 * when the SDK was never loaded on this page. */
export function leaveZoomMeeting(): void {
  void loaded?.leaveMeeting({})
}

/** Absolute URL of an app path on THIS origin -- what the SDK's leaveUrl
 * needs (it does a full navigation there). */
export function appUrl(path: string): string {
  return new URL(path, host.location.origin).toString()
}

/** Test seam: forget the loaded SDK. */
export function _resetZoomSdkForTest(): void {
  loaded = null
}
