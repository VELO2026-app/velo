// =============================================================================
// VELO Frontend -- pure helpers of the console people tables (FE-262)
// =============================================================================
//
// The pager's page list, a day label and the method chips of a master row.
// Kept apart from the components so they are tested without a DOM.
// =============================================================================

import type { AdminMasterListItem } from '@/api/admin'
import { getLocale } from '@/locales'
import { directionLabel, parseMethods, resolveStyleLabel } from '@/utils/methodTaxonomy'

/** One slot of the pager: a page number or a gap (an ellipsis). */
export type PagerItem = number | 'gap'

/**
 * The slots of a numbered pager: the first page, the last page and the
 * neighbours of the current one, with a gap where pages are left out.
 *
 * @param page - The current 1-based page
 * @param pages - How many pages there are
 * @returns Nothing for fewer than two pages (no pager is needed)
 */
export function pagerItems(page: number, pages: number): PagerItem[] {
  if (pages < 2) return []
  const wanted = new Set([1, pages, page - 1, page, page + 1])
  const numbers = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)
  const items: PagerItem[] = []
  numbers.forEach((n, i) => {
    const before = numbers[i - 1]
    if (before !== undefined && n - before === 2) items.push(n - 1)
    else if (before !== undefined && n - before > 2) items.push('gap')
    items.push(n)
  })
  return items
}

/** A calendar day (UTC, like every admin date) as `24 Nov 2026`. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** One chip of a master's methods: a direction (filled) or a style (muted). */
export interface MethodChip {
  label: string
  muted: boolean
}

/**
 * A master's methods as chips: the direction filled, its styles muted. A
 * method the taxonomy does not know stays as a verbatim chip, so nothing
 * vanishes (the same reading as the mobile masters card).
 */
export function methodChips(master: Pick<AdminMasterListItem, 'methods'>): MethodChip[] {
  const methods = master.methods ?? []
  if (methods.length === 0) return []
  const parsed = parseMethods(methods)
  if (parsed.directions.length === 0) return methods.map((label) => ({ label, muted: false }))
  const chips: MethodChip[] = []
  for (const dir of parsed.directions) {
    chips.push({ label: directionLabel(dir), muted: false })
    for (const style of parsed.styles[dir] ?? []) {
      chips.push({ label: resolveStyleLabel(dir, style), muted: true })
    }
  }
  if (parsed.customEnabled && parsed.customText) {
    chips.push({ label: parsed.customText, muted: false })
  }
  return chips
}
