// =============================================================================
// @velo/ui -- small per-tab memory (sessionStorage seam, P8 batch 5)
// =============================================================================
//
// Remembers tiny UI facts for the life of the browser tab (survives a
// reload, private to the tab), e.g. how tall a block was when it last
// settled so its skeleton can reserve that height. The package's own
// window/document seam law (src/platform/dom.ts) applies: no raw storage
// access outside this module, and it NEVER throws -- storage can be
// disabled or full (private mode), and a consumer then simply has no
// memory. Deliberately NOT merged with the host application's
// platform/session-memo (the P5 ruling: the kit keeps its own seam).
// =============================================================================

/** A number remembered per tab; null when missing or unreadable. */
export function readSessionNumber(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** Remember a number for the tab's lifetime; never throws (no memory then). */
export function writeSessionNumber(key: string, value: number): void {
  try {
    window.sessionStorage.setItem(key, String(value))
  } catch {
    // No memory then -- the skeleton falls back to its default size.
  }
}
