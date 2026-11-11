// =============================================================================
// VELO Frontend -- the master's own account on Pinia Colada (FE-166 step 5)
// =============================================================================
//
// The master profile (`GET /masters/me`): status, confirmed methods,
// languages, balance, payout details. It used to live in stores/master.ts;
// the store keeps the onboarding flag of this session and, until the next
// step (FE-179 part 2b), the master's own practices lists.
//
// Freshness: one answer per session, as in the store -- the router guards
// read it on every master-zone navigation, and a refetch per navigation
// would put a request in front of every screen. Fetched again only where the
// screen knows it moved: the verdict screen's re-check, after an application,
// a method change request, a language edit, a withdrawal -- and for an admin,
// whose profile can flip with no role change, at most every
// ADMIN_PROFILE_TTL_MS (router/guards.ts); payout details are
// written from the answer of their own mutation (setMasterProfile).
// gcTime Infinity: the guards read it outside any component, so nothing
// holds the entry between screens; the end of a session empties it
// (queries/setup.ts, the account scope).
//
// A failed answer: the entry keeps the last profile it had (Colada keeps
// `data` on error), and the next reader -- a guard or a screen's mount --
// asks again (Colada refreshes an entry in error). "No application at all"
// is the 403 `master_profile_not_found` (№257 honest entry), keyed on the
// machine code, never on a missing profile: a network error must not send a
// real master into the apply wizard.
// =============================================================================

import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { defineQueryOptions, useQuery, useQueryCache, type QueryCache } from '@pinia/colada'
import { ApiResponseError } from '@/api/client'
import { getMyMasterProfile } from '@/api/masters'
import type { MasterProfileResponse } from '@/api/types'
import { keys } from '@/composables/queries/keys'
import { screenQueryState } from '@/composables/queries/screenState'

/**
 * Query options for my master profile (`GET /masters/me`).
 *
 * @param enabled - Whether a mounted reader fetches it on its own. Off for a
 *   screen that only reads what a guard or its own explicit fetch loaded --
 *   e.g. for an account that is not a master, where the call answers 403.
 */
export const masterProfileQuery = defineQueryOptions((enabled: boolean = true) => ({
  key: keys.masters.profile(),
  query: () => getMyMasterProfile(),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  enabled,
}))

/** Whether an error is the backend's "this account has no master application at all" (403 `master_profile_not_found`). */
export function isMasterProfileMissing(error: unknown): boolean {
  return error instanceof ApiResponseError && error.code === 'master_profile_not_found'
}

/** What the cache knows about my master profile. */
export interface MasterProfileSnapshot {
  /** The last profile received this session, or null. */
  profile: MasterProfileResponse | null
  /** The last request answered "no application at all" (see the header). */
  missing: boolean
}

/** Read my master profile from the cache, without a request. */
export function cachedMasterProfile(
  queryCache: QueryCache = useQueryCache(),
): MasterProfileSnapshot {
  const state = queryCache.get(keys.masters.profile())?.state.value
  return {
    profile: (state?.data as MasterProfileResponse | undefined) ?? null,
    missing: isMasterProfileMissing(state?.error),
  }
}

/**
 * Load my master profile outside a component (the router guards).
 *
 * @param queryCache - The Colada query cache (the active one by default).
 * @param options - `force`: ask the server even when a profile is held.
 *   Without it, a request leaves only when none has answered yet or the last
 *   one failed; one already in flight is joined.
 * @returns What the cache holds once the request settled. Never rejects: a
 *   failure is recorded on the entry (`missing` tells the one that matters).
 */
export async function loadMasterProfile(
  queryCache: QueryCache = useQueryCache(),
  { force = false }: { force?: boolean } = {},
): Promise<MasterProfileSnapshot> {
  const entry = queryCache.ensure(masterProfileQuery())
  await (force ? queryCache.fetch(entry) : queryCache.refresh(entry)).catch(() => {})
  return cachedMasterProfile(queryCache)
}

/**
 * Replace my master profile with a newer copy a mutation answered (payout
 * details saved or removed). No-op while no profile is held.
 */
export function setMasterProfile(
  queryCache: QueryCache,
  update: (profile: MasterProfileResponse) => MasterProfileResponse,
): void {
  const held = queryCache.getQueryData<MasterProfileResponse>(keys.masters.profile())
  if (held) queryCache.setQueryData(keys.masters.profile(), update(held))
}

/**
 * My master profile for a screen.
 *
 * @param enabled - See `masterProfileQuery`. When off, the screen reads what
 *   is held and fetches only through `reload()`.
 */
export function useMasterProfile(enabled: MaybeRefOrGetter<boolean> = true) {
  const query = useQuery(() => masterProfileQuery(toValue(enabled)))
  const { loading, failed } = screenQueryState(query)
  return {
    /** The profile, or null until one has answered. */
    profile: computed<MasterProfileResponse | null>(() => query.data.value ?? null),
    /** A profile has answered this session (it stays held through a later failure). */
    loaded: computed(() => query.data.value !== undefined),
    /** No profile held and a request in flight. */
    loading,
    /** No profile held and the last request failed. */
    failed,
    /** The raw error of the last request, or null (ADR: the screen turns it into text). */
    error: query.error,
    /** The last request answered "no application at all". */
    missing: computed(() => isMasterProfileMissing(query.error.value)),
    /**
     * Ask the server again, even when a profile is held (it moved: an
     * application sent, a change request, a status re-check). Resolves with
     * the entry's state; never rejects -- a failure is in `error`.
     */
    reload: () => query.refetch(),
  }
}
