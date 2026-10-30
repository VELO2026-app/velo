// =============================================================================
// VELO Frontend -- screen data that survives a reload (sessionStorage)
// =============================================================================
//
// A Telegram Mini App is reopened and reloaded often; the in-memory screen
// cache (useQuery, stores) starts empty every time, so the first visit of
// every tab drew a skeleton. A few chosen, small, non-sensitive payloads are
// mirrored here and shown at once on the next start, then revalidated in the
// background (stale-while-revalidate -- the hydrated copy always counts as
// stale).
//
// Rules:
//   - one sessionStorage key per ACCOUNT and FORMAT VERSION
//     (velo:screen-cache:v1:<user id>); another account's copy is dropped as
//     soon as the owner changes, all of it on sign-out (stores/auth.ts);
//   - opt-in per payload, never by default. Persisted: the dashboard's
//     upcoming bookings, the attended-practice stats, the default calendar
//     week, the schools list. NOT persisted: diary entries, chat messages,
//     notifications -- personal text stays in memory only;
//   - size cap: past MAX_BYTES the oldest payloads are dropped first;
//   - writes are batched (one serialization per burst of responses).
// =============================================================================

import { readSessionJson, removeSessionKeys, writeSessionString } from '@/platform/session-memo'

export const PERSIST_VERSION = 1
export const PERSIST_PREFIX = 'velo:screen-cache:'
/** Total budget for the serialized cache (sessionStorage is ~5 MB). */
export const PERSIST_MAX_BYTES = 256 * 1024
const FLUSH_DELAY_MS = 50

interface Slot {
  /** When the payload was fetched (ms). */
  at: number
  data: unknown
}

let owner: string | null = null
let slots: Record<string, Slot> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function storageKey(id: string): string {
  return `${PERSIST_PREFIX}v${PERSIST_VERSION}:${id}`
}

function load(): Record<string, Slot> {
  if (slots) return slots
  const raw = owner === null ? null : readSessionJson(storageKey(owner))
  slots = raw !== null && typeof raw === 'object' ? (raw as Record<string, Slot>) : {}
  return slots
}

function flush(): void {
  flushTimer = null
  if (owner === null || slots === null) return
  // Oldest first out until it fits the budget.
  const ordered = Object.entries(slots).sort(([, a], [, b]) => b.at - a.at)
  while (ordered.length > 0) {
    const json = JSON.stringify(Object.fromEntries(ordered))
    if (json.length <= PERSIST_MAX_BYTES && writeSessionString(storageKey(owner), json)) {
      slots = Object.fromEntries(ordered)
      return
    }
    ordered.pop()
  }
  slots = {}
  removeSessionKeys(PERSIST_PREFIX)
}

/** Whose data may be read and written (the signed-in account, or null). A
 * change of owner drops every other account's copy. */
export function setPersistOwner(id: string | null): void {
  if (id === owner) return
  owner = id
  slots = null
  removeSessionKeys(PERSIST_PREFIX, id === null ? undefined : storageKey(id))
}

/** The persisted copy of `name` for the current owner. */
export function readPersisted<T>(name: string): { data: T; at: number } | undefined {
  if (owner === null) return undefined
  const slot = load()[name]
  return slot ? { data: slot.data as T, at: slot.at } : undefined
}

/** Remember `data` under `name` for the current owner (batched write). */
export function writePersisted(name: string, data: unknown, at = Date.now()): void {
  if (owner === null) return
  load()[name] = { at, data }
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

/** Forget everything, every account (sign-out). */
export function clearPersisted(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  slots = owner === null ? null : {}
  removeSessionKeys(PERSIST_PREFIX)
}

/** Write any pending batch now (tests; page hide). */
export function flushPersisted(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flush()
}
