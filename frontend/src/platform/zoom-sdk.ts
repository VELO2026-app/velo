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
//
// SAFE AREAS (F4 fix, iPhone). The SDK's root is
//   #zmmtg-root{width:100%;height:100%;position:fixed;top:0;left:0;background:#000}
// (dist/ui/zoom-meetingsdk.css, 6.5.0), and both panels hang off its edges:
// .meeting-header (End / Leave) is position:absolute at the top, .footer is
// position:absolute;bottom:0. The SDK declares --sat/--sab/--sal/--sar from
// env(safe-area-inset-*) and reads them nowhere. In the installed iOS app
// (index.html black-translucent + launch.ts viewport-fit=cover) the root
// therefore starts under the clock and the island and ends on the home bar:
// End could not be pressed. For the meeting only, MEETING_STYLE below moves
// the root's own EDGES into the safe area -- edges, not padding: an absolute
// child whose containing block is the root itself measures top:0 from the
// root's PADDING box, so padding would not move it; a smaller root box moves
// everything that hangs off it. And the canvas goes black: the SDK's
// bootstrap paints body #fff, which showed as a white band below the root.
// Only for the meeting: the class and the <style> are put on before init()
// and taken off on any failure; after a successful join the only way out is
// leaveUrl's full reload, which leaves neither behind.
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

/** On <html> for the duration of a meeting; every rule of MEETING_STYLE is
 * scoped under it, so none can reach a screen of ours. */
export const MEETING_CLASS = 'velo-zoom-meeting'
/** id of the one <style> element the meeting adds to <head>. */
export const MEETING_STYLE_ID = 'velo-zoom-safe-area'
/** The top inset, set from useSafeArea() (the app's single source: Telegram
 * fullscreen controls, or env(safe-area-inset-top) outside Telegram). */
export const MEETING_INSET_TOP_VAR = '--velo-zoom-inset-top'

/** The meeting's stylesheet. Specificity (1,1,1) beats the SDK's
 * #zmmtg-root (1,0,0) whatever order the CDN CSS arrives in -- no
 * !important. Bottom and sides come from env() exactly as our tab bars
 * read theirs; the top falls back to env() if the variable was never set. */
export const MEETING_STYLE = `
html.${MEETING_CLASS},
html.${MEETING_CLASS} body {
  background: #000;
}
html.${MEETING_CLASS} #zmmtg-root {
  top: var(${MEETING_INSET_TOP_VAR}, env(safe-area-inset-top, 0px));
  right: env(safe-area-inset-right, 0px);
  bottom: env(safe-area-inset-bottom, 0px);
  left: env(safe-area-inset-left, 0px);
  width: auto;
  height: auto;
}
`

/** Put the meeting's safe-area style on (idempotent: one <style>, ever). */
function applyMeetingStyle(insetTop: string): void {
  const doc = host.document
  doc.documentElement.classList.add(MEETING_CLASS)
  setZoomInsetTop(insetTop)
  if (!doc.getElementById(MEETING_STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = MEETING_STYLE_ID
    style.textContent = MEETING_STYLE
    doc.head.appendChild(style)
  }
}

/** Take the meeting's safe-area style off -- nothing of it stays behind. */
function removeMeetingStyle(): void {
  const doc = host.document
  doc.documentElement.classList.remove(MEETING_CLASS)
  doc.documentElement.style.removeProperty(MEETING_INSET_TOP_VAR)
  doc.getElementById(MEETING_STYLE_ID)?.remove()
}

/** Update the meeting's top inset (the practice screen watches
 * useSafeArea() -- Telegram's insets arrive and change asynchronously). An
 * empty value removes the variable, so the env() fallback applies. */
export function setZoomInsetTop(insetTop: string): void {
  const root = host.document.documentElement
  if (insetTop) root.style.setProperty(MEETING_INSET_TOP_VAR, insetTop)
  else root.style.removeProperty(MEETING_INSET_TOP_VAR)
}

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
 * `insetTop` is the top safe-area length (useSafeArea().contentSafeTopCss).
 *
 * The meeting's safe-area style goes on before the SDK draws anything and
 * comes off again on every failure, so a failed entry leaves the practice
 * screen exactly as it was.
 */
export async function enterZoomMeeting(
  join: ZoomSdkJoinResponse,
  leaveUrl: string,
  options: { insetTop: string },
): Promise<void> {
  applyMeetingStyle(options.insetTop)
  try {
    await loadAndJoin(join, leaveUrl)
  } catch (e) {
    removeMeetingStyle()
    throw e
  }
}

async function loadAndJoin(join: ZoomSdkJoinResponse, leaveUrl: string): Promise<void> {
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

/** Test seam: forget the loaded SDK and the meeting style. */
export function _resetZoomSdkForTest(): void {
  loaded = null
  removeMeetingStyle()
}
