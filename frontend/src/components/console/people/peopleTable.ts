// =============================================================================
// VELO Frontend -- pure helpers of the console people tables (FE-262)
// =============================================================================
//
// The pager's page list, a day label and the method chips of a master row.
// Kept apart from the components so they are tested without a DOM.
// =============================================================================

import type { ConsoleTone } from '@/utils/console/tone'
import type { AdminMasterListItem } from '@/api/admin'
import { getLocale, t } from '@/locales'
import { formatMoney } from '@/utils/format'
import {
  customMethodLabel,
  directionLabel,
  parseMethods,
  resolveStyleLabel,
} from '@/utils/methodTaxonomy'

/** What a cell shows for a value the server does not have. */
export const DASH = '—'

/** A counter as a cell shows it: the number, or a dash when the server has none. */
export function countText(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : String(n)
}

/** A payout balance in euro cents as a cell shows it, or a dash when the server has none. */
export function payoutText(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? DASH : formatMoney(cents, 'EUR', getLocale(), true)
}

/** One tab of a VSegment strip. */
export interface TabOption {
  value: string
  label: string
}

/**
 * The options of a tab strip: each tab's name, with its total after it once
 * that is known (`Under review · 2`).
 */
export function tabOptions<Tab extends string>(
  tabs: readonly Tab[],
  name: (tab: Tab) => string,
  total: (tab: Tab) => number | undefined,
): TabOption[] {
  return tabs.map((value) => {
    const n = total(value)
    return { value, label: n === undefined ? name(value) : `${name(value)} · ${n}` }
  })
}

const MASTER_STATUSES = ['pending', 'verified', 'rejected', 'suspended', 'cancelled_by_user']

/**
 * A master's verification status as every console screen words it. `suspended`
 * is a revoked master, not a blocked account. A status the console does not
 * know is shown as the server sent it.
 */
export function masterStatusLabel(status: string): string {
  return MASTER_STATUSES.includes(status) ? t(`console.masters.status.${status}`) : status
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
 * vanishes (the same reading as the mobile masters card); a bare direction
 * label the seed names reads in the live locale even with a cold catalog.
 */
export function methodChips(master: Pick<AdminMasterListItem, 'methods'>): MethodChip[] {
  const methods = master.methods ?? []
  if (methods.length === 0) return []
  const parsed = parseMethods(methods)
  if (parsed.directions.length === 0) {
    return methods.map((label) => ({ label: customMethodLabel(label), muted: false }))
  }
  const chips: MethodChip[] = []
  for (const dir of parsed.directions) {
    chips.push({ label: directionLabel(dir), muted: false })
    for (const style of parsed.styles[dir] ?? []) {
      chips.push({ label: resolveStyleLabel(dir, style), muted: true })
    }
  }
  if (parsed.customEnabled && parsed.customText) {
    chips.push({ label: parsed.custom.map(customMethodLabel).join(', '), muted: false })
  }
  return chips
}

/** The pill tone of a master's verification status. */
export function masterStatusTone(status: string): ConsoleTone {
  if (status === 'verified') return 'success'
  if (status === 'pending') return 'warning'
  if (status === 'rejected' || status === 'suspended') return 'error'
  return 'muted'
}

/** The pill tone of a user's role. */
export function roleTone(role: string): ConsoleTone {
  if (role === 'admin') return 'warning'
  if (role === 'master') return 'success'
  return 'muted'
}
