// =============================================================================
// VELO Frontend -- textHighlight util (diary live search, 2026-09-09)
// =============================================================================
//
// Splits a display string into plain/hit segments around a search needle so
// the Telegram-style bolded match can be rendered as real DOM nodes -- never
// v-html (a hard project rule). The caller v-fors the segments and class-binds
// `hit`.
//
// Case-insensitive substring match, mirroring the backend's own match exactly
// (a pre-lowercased ilike over text_search): simple toLowerCase folding is
// 1:1 for the RU/EN scripts the diary writes.

export interface TextSegment {
  text: string
  hit: boolean
}

export function splitHighlight(text: string, query: string): TextSegment[] {
  const needle = query.trim()
  if (!needle || !text) return [{ text, hit: false }]

  const haystack = text.toLowerCase()
  const lower = needle.toLowerCase()
  const segments: TextSegment[] = []
  let from = 0

  for (;;) {
    const at = haystack.indexOf(lower, from)
    if (at === -1) {
      segments.push({ text: text.slice(from), hit: false })
      return segments
    }
    if (at > from) segments.push({ text: text.slice(from, at), hit: false })
    segments.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
}
