// =============================================================================
// VELO Frontend -- small per-tab memory (sessionStorage seam)
// =============================================================================
//
// Remembers tiny UI facts for the life of the Telegram webview tab (survives a
// reload, private to the tab), e.g. how many rows a block had last time so its
// skeleton can be drawn in that size. Never throws: storage can be disabled or
// full (private mode), and the app then simply has no memory.
// =============================================================================

import { host } from './host'

export function readSessionNumber(key: string): number | null {
  try {
    const raw = host.sessionStorage.getItem(key)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export function writeSessionNumber(key: string, value: number): void {
  try {
    host.sessionStorage.setItem(key, String(value))
  } catch {
    // No memory then -- the skeleton falls back to its default size.
  }
}

/** A JSON value from sessionStorage, or null (missing, unreadable, corrupt). */
export function readSessionJson(key: string): unknown {
  try {
    const raw = host.sessionStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** Store a pre-serialized JSON string; false when storage refused it. */
export function writeSessionString(key: string, value: string): boolean {
  try {
    host.sessionStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** Remove every key starting with `prefix`, except `keep`. */
export function removeSessionKeys(prefix: string, keep?: string): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < host.sessionStorage.length; i++) {
      const key = host.sessionStorage.key(i)
      if (key !== null && key.startsWith(prefix) && key !== keep) doomed.push(key)
    }
    for (const key of doomed) host.sessionStorage.removeItem(key)
  } catch {
    // Nothing to clean then.
  }
}
