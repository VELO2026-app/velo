// =============================================================================
// VELO Frontend -- the master's own account on Pinia Colada (FE-166 step 5)
// =============================================================================
//
// Two things that used to live in stores/master.ts (the store now keeps only
// client state: the onboarding flag of this session): the master profile and
// the master's own practices (further down).
//
// The master profile (`GET /masters/me`): status, confirmed methods,
// languages, balance, payout details.
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
import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryCache,
  type QueryCache,
} from '@pinia/colada'
import { ApiResponseError } from '@/api/client'
import { getMyMasterProfile, getMyPractices } from '@/api/masters'
import type {
  MasterProfileResponse,
  PaginatedPracticesResponse,
  PracticeResponse,
} from '@/api/types'
import { invalidateAfter } from '@/composables/queries/invalidation'
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

// =============================================================================
// The master's own practices: two lists, upcoming and past (T22-3/T22-5)
// =============================================================================
//
// TWO independent lists, not one: upcoming (draft / scheduled / live,
// nearest first) and past (completed, most recent first) are different
// questions to the server over disjoint status sets, so one shared cursor
// could never answer both -- its page 1 was the furthest-future rows (PROMPT
// №561). Each list loads when a screen needs it: the practices list's past
// tab only once it is opened, the analytics screen only the past.
//
// Under `keys.practices.root()`: every change to a practice made in this app
// -- the master's own create / edit / publish / cancel / delete
// (myPracticesChanged), a booking taken or cancelled -- invalidates them
// (./invalidation.ts). Seats, check-ins and statuses also move by other
// hands (a student's booking, the autofinalize worker): the default staleness
// window covers a revisit, and the dashboard asks again on every mount
// (FE-53, `refetchOnMount: 'always'`). A refetch reloads every page loaded
// so far (Colada infinite queries).

/** Practices per page of `GET /masters/me/practices`. */
export const MY_PRACTICES_PAGE_SIZE = 20

/** One of the master's own practice lists. */
export type MyPracticesBucket = 'upcoming' | 'past'

/** Infinite query options for one list of my practices (`GET /masters/me/practices?bucket=`). */
export const myPracticesQuery = defineInfiniteQueryOptions((bucket: MyPracticesBucket) => ({
  key: keys.practices.mine(bucket),
  query: ({ pageParam }: { pageParam: number }) =>
    getMyPractices(bucket, MY_PRACTICES_PAGE_SIZE, pageParam),
  initialPageParam: 0,
  getNextPageParam: (last: PaginatedPracticesResponse) => {
    const next = last.offset + last.items.length
    return next < last.total ? next : null
  },
}))

/** Options of a screen's reader of one practices list. */
export interface UseMyPracticesOptions {
  /** Whether the list loads (default true): the past tab passes "is it open". */
  enabled?: MaybeRefOrGetter<boolean>
  /** `'always'`: ask the server on every mount, even within the staleness window (the dashboard, FE-53). */
  refetchOnMount?: 'always'
}

/**
 * One list of my practices for a screen: the loaded practices flattened, the
 * total, and the loading / error state (queries/screenState.ts).
 *
 * @remarks
 * `error` is the raw error of the last request (ADR: the screen turns it into
 * text); `failed` is true only when there is nothing to show. `loadMore()`
 * rejects with the error of a failed next page and keeps the list.
 */
export function useMyPractices(bucket: MyPracticesBucket, options: UseMyPracticesOptions = {}) {
  const query = useInfiniteQuery(() => ({
    ...myPracticesQuery(bucket),
    enabled: toValue(options.enabled ?? true),
    ...(options.refetchOnMount ? { refetchOnMount: options.refetchOnMount } : {}),
  }))
  const { loading, failed } = screenQueryState(query)
  return {
    practices: computed<PracticeResponse[]>(
      () => query.data.value?.pages.flatMap((page) => page.items) ?? [],
    ),
    /** The server's total for the list (0 until the first page answers). */
    total: computed(() => query.data.value?.pages.at(-1)?.total ?? 0),
    loading,
    failed,
    error: query.error,
    /** Any request of the list in flight (first page, next page, refetch). */
    fetching: computed(() => query.asyncStatus.value === 'loading'),
    hasMore: query.hasNextPage,
    // cancelRefetch false: a tap during a refetch (a practice just changed)
    // waits for it instead of cancelling it and gluing the old page 1 to a
    // new page 2.
    loadMore: () => query.loadNextPage({ throwOnError: true, cancelRefetch: false }),
    /** Ask again now, keeping the list on screen. Never rejects. */
    refetch: () => query.refetch(),
  }
}

/**
 * One of my practices from the lists already loaded, without a request --
 * the placeholder a practice screen paints before its own fetch answers.
 */
export function cachedMyPractice(
  queryCache: QueryCache,
  practiceId: string,
): PracticeResponse | undefined {
  for (const entry of queryCache.getEntries({ key: keys.practices.mineAll() })) {
    const data = entry.state.value.data as { pages: PaginatedPracticesResponse[] } | undefined
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((p) => p.id === practiceId)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * One of my practices changed in this app (created, edited, published,
 * cancelled, deleted): invalidate `INVALIDATES.changePractice` -- every
 * practice list (a school feed shows it too) and detail -- and refetch my own
 * lists at once, even with no screen showing them, so the list the screen
 * navigates back to is already current (they are small, and a cancelled
 * practice must not flash back). Resolves when every refetch settled; never
 * rejects.
 */
export async function myPracticesChanged(queryCache: QueryCache): Promise<void> {
  const invalidation = invalidateAfter(queryCache, 'changePractice')
  // invalidateAfter refetched the lists on screen; these are the others.
  const offScreen = queryCache
    .getEntries({ key: keys.practices.mineAll() })
    // Only a list some screen has loaded: one never opened (the past tab
    // nobody switched to) stays unasked -- its first reader loads it.
    .filter((entry) => !entry.active && entry.options && entry.state.value.data !== undefined)
    .map((entry) => queryCache.fetch(entry))
  await Promise.allSettled([invalidation, ...offScreen])
}
