// =============================================================================
// VELO Frontend -- Method chips: stored method string -> icon + short label
// (FE-61/62/63/64)
// =============================================================================
//
// A stored `methods` entry is ONE flat «Направление — Вид» string (the
// methodTaxonomy.ts SEP vocabulary). A chip renders it as icon + SHORT label:
//
//   «Медитация — Медитация молчания» -> [meditation icon] Молчания
//   «Йога — Кундалини-йога»          -> [yoga icon]       Кундалини
//   «Дыхательные практики»           -> [breathwork icon] Дыхательные практики
//   «Мой уникальный метод»           -> [dots fallback]   Мой уникальный метод
//
// The style labels embed the direction word by design («Медитация молчания»,
// «Кундалини-йога»), so the old raw-string pill read the word twice —
// «Медитация — Медитация молчания» (FE-64). shortStyleLabel() strips the
// direction word from the style label; when nothing survives, the style WAS
// the direction and the direction label stands alone.
//
// The icon is the DIRECTION's artwork — the ready icon set has no per-style
// glyphs — the same DIRECTION_ICON mapping the practice cards use. A string
// the taxonomy does not know (custom «Свой вариант», legacy free text, a
// catalog-only entry while the catalog cache is cold) keeps its verbatim text
// under the neutral IconDots fallback: an invented icon would claim a skill
// the set cannot name. Priming the taxonomy catalog (admin screens already
// do) extends recognition to catalog rows with no change here.
// =============================================================================

import type { Component } from 'vue'
import { DIRECTION_ICON, DIRECTION_ICON_FALLBACK } from '@/utils/displayHelpers'
import { directionLabel, parseMethods, resolveStyleLabel } from '@/utils/methodTaxonomy'

export interface MethodChip {
  icon: Component
  label: string
}

/**
 * «Кундалини-йога» -> «Кундалини», «Медитация молчания» -> «Молчания».
 * Case-insensitive containment, separator residue trimmed; a style that is
 * exactly the direction word collapses back to the direction label. A style
 * without the direction word inside («Виньяса») passes through untouched —
 * so does a word-stem overlap («Круги» / «Женский круг»): only the full
 * direction label is stripped, never a guess at a stem.
 */
export function shortStyleLabel(direction: string, style: string): string {
  const dir = direction.trim()
  const full = style.trim()
  if (!dir) return full
  if (!full.toLowerCase().includes(dir.toLowerCase())) return full
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = full
    .replace(new RegExp(escaped, 'gi'), '')
    .replace(/^[\s—–-]+/, '')
    .replace(/[\s—–-]+$/, '')
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : dir
}

/** One stored method string -> the chip's icon + short label. */
export function methodChipFor(method: string): MethodChip {
  const parsed = parseMethods([method])
  const dir = parsed.directions[0]
  if (!dir) {
    return { icon: DIRECTION_ICON_FALLBACK, label: parsed.customText || method }
  }
  const icon: Component = DIRECTION_ICON[dir] ?? DIRECTION_ICON_FALLBACK
  const styleValue = parsed.styles[dir]?.[0]
  if (!styleValue) {
    return { icon, label: directionLabel(dir) }
  }
  return { icon, label: shortStyleLabel(directionLabel(dir), resolveStyleLabel(dir, styleValue)) }
}
