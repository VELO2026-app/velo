// =============================================================================
// VELO Frontend -- admin mutation -> invalidated query keys (FE-181)
// =============================================================================
//
// The admin half of ./invalidation.ts: what each admin mutation makes stale,
// written down once per mutation, with a test per row
// (./invalidation.test.ts). Kept apart for the same reason as ./adminKeys.ts
// -- the admin zone loads lazily, ./invalidation.ts is in the startup chunk.
// A row may name user-zone prefixes too (./keys.ts) when an admin action
// changes what the admin's own user zone shows.
//
// useAdminMutation is the one way an admin screen runs a mutation: the
// request, then -- for the session it was started in only -- the row's
// invalidation.
// =============================================================================

import { useMutation, useQueryCache, type EntryKey } from '@pinia/colada'
import { adminKeys } from '@/composables/queries/adminKeys'
import { invalidateKeys } from '@/composables/queries/invalidation'
import { useQueryScopeStore } from '@/composables/queries/setup'

/** Each admin mutation and the query-key prefixes it makes stale. */
export const ADMIN_INVALIDATES = {
  /**
   * `POST /admin/taxonomy/directions`, `POST /admin/taxonomy/directions/{id}/styles`,
   * `PATCH /admin/taxonomy/directions/{id}`, `PATCH /admin/taxonomy/styles/{id}`:
   * an item added, renamed, switched off or on -- the catalog editor's tree.
   */
  changeTaxonomy: [adminKeys.taxonomy()],
  /** `PATCH /admin/promos/{id}/deactivate`: the promo turns inactive -- every tab of the promo list. */
  deactivatePromo: [adminKeys.promosAll()],
} as const satisfies Record<string, readonly EntryKey[]>

/** Name of an admin mutation that has a row in `ADMIN_INVALIDATES`. */
export type AdminMutationName = keyof typeof ADMIN_INVALIDATES

/** Options of `useAdminMutation`. */
export interface AdminMutationOptions<TVars, TData> {
  /**
   * Write the answer into the cache at once, before the invalidation's
   * refetch answers (a card that must flip under the toast).
   */
  write?: (data: TData, vars: TVars) => void
  /**
   * Whether `mutateAsync` waits for the refetches on screen (default true:
   * the control's spinner covers the list catching up). Off when the screen
   * already shows the outcome through `write`.
   */
  waitForRefetch?: boolean
}

/**
 * An admin mutation for a screen: runs `mutation`, then, when it succeeded
 * in the session it was started in, `write` and the invalidation of the
 * mutation's row.
 *
 * @remarks
 * `mutateAsync` rejects with the raw API error (the screen turns it into
 * text) and then nothing is invalidated. A session that ended while the
 * request was in flight gets nothing: its caches are already emptied
 * (queries/setup.ts).
 */
export function useAdminMutation<TVars, TData>(
  name: AdminMutationName,
  mutation: (vars: TVars) => Promise<TData>,
  { write, waitForRefetch = true }: AdminMutationOptions<TVars, TData> = {},
) {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    mutation,
    async onSuccess(data: TData, vars: TVars, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      write?.(data, vars)
      const invalidation = invalidateKeys(queryCache, ADMIN_INVALIDATES[name])
      if (waitForRefetch) await invalidation
    },
  })
}
