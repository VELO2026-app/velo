// =============================================================================
// VELO Frontend -- Browser sign-in: the mark and the return (Standalone F3)
// =============================================================================
//
// Outside Telegram the person signs in with "Log In With Telegram":
//   start    -> the backend hands out Telegram's URL and a `state`; this
//               browser keeps { state, mark } (the MARK is random, made
//               here) and goes to Telegram;
//   return   -> Telegram sends the browser back to RETURN_PATH with `code`
//               and `state` (or `error`); the app reads them ONCE, wipes them
//               from the address bar, and completes the sign-in only if this
//               browser holds a mark for that very state.
//
// WHY THE MARK (login CSRF): a return link made by someone else -- their own
// Telegram account, stopped at the return -- must not sign THIS browser into
// THEIR account. Such a link arrives in a browser with no mark (or a mark for
// another state) and is refused here, without a request; the backend checks
// the same mark again before it exchanges the code
// (backend/app/modules/auth/browser_login.py).
//
// WHERE THE MARK LIVES: localStorage. The person leaves for the Telegram app
// and comes back; a new tab or window of the same browser must still find it
// (sessionStorage is per tab). It is one-time: taken (read and removed) at
// the first return, whatever the outcome.
//
// WHY THE ADDRESS IS WIPED: the code and state stay in the address bar and in
// history otherwise -- every reload would re-read an already used state, and
// the person would see "the link is out of date" on each open.
// =============================================================================

import { host } from './host'

/** Where Telegram sends the browser back. The same literal is RETURN_PATH in
 *  backend/app/modules/auth/browser_login.py and the Redirect URI registered
 *  in BotFather. */
export const RETURN_PATH = '/auth/telegram/return'

/** localStorage key of the started sign-in's mark. */
export const LOGIN_MARK_KEY = 'velo:login-mark'

/** What Telegram put on the return address. */
export interface LoginReturn {
  code: string | null
  state: string | null
  error: string | null
}

/** A started sign-in, as this browser remembers it. */
export interface LoginMark {
  state: string
  mark: string
}

/** 32 random bytes, base64url -- 43 characters, within the backend's bounds. */
export function newMark(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Remember the sign-in this browser is about to start. */
export function rememberLoginMark(
  mark: LoginMark,
  storage: () => Storage = () => host.localStorage,
): void {
  try {
    storage().setItem(LOGIN_MARK_KEY, JSON.stringify(mark))
  } catch {
    // Unwritable storage: the return will find no mark and be refused --
    // the safe direction.
  }
}

/** The remembered sign-in, removed as it is read. Garbage reads as none. */
export function takeLoginMark(storage: () => Storage = () => host.localStorage): LoginMark | null {
  let raw: string | null
  try {
    raw = storage().getItem(LOGIN_MARK_KEY)
    storage().removeItem(LOGIN_MARK_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as LoginMark).state === 'string' &&
      typeof (value as LoginMark).mark === 'string' &&
      (value as LoginMark).state &&
      (value as LoginMark).mark
    ) {
      return { state: (value as LoginMark).state, mark: (value as LoginMark).mark }
    }
  } catch {
    // Not JSON: no mark.
  }
  return null
}

/**
 * Read the return from Telegram, if this page IS one, and wipe it from the
 * address bar (history.replaceState -- no reload, no new history entry).
 * Null when the page is not RETURN_PATH or carries none of code / state /
 * error.
 */
export function takeLoginReturn(win: Window = host): LoginReturn | null {
  const { pathname, search } = win.location
  if (pathname !== RETURN_PATH) return null
  const params = new URLSearchParams(search)
  const found: LoginReturn = {
    code: params.get('code') || null,
    state: params.get('state') || null,
    error: params.get('error') || null,
  }
  if (!found.code && !found.state && !found.error) return null
  // The router owns history.state; keep it, change only the address.
  win.history.replaceState(win.history.state, '', '/')
  return found
}
