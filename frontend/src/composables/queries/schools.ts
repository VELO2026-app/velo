// =============================================================================
// VELO Frontend -- school queries for Pinia Colada (FE-157 4F pilot)
// =============================================================================
//
// The school page (views/user/SchoolPageView.vue) reads two independent
// entries: the page payload and the practices feed. Each id has its own
// entries, so a slow answer for the previous school lands in that school's
// entry and never on the current screen -- the guard the page used to keep
// by hand (loadEpoch).
//
// staleTime: the page payload 0 -- it revalidates on every visit, the cached
// copy only removes the spinner; it carries the viewer's relation, which
// changes outside this app. The feed takes the default window (setup.ts):
// every mutation of this app that changes a practice in it -- a booking made
// or cancelled, a waitlist spot confirmed, the master's own practice
// created, edited, cancelled or deleted -- invalidates `keys.practices.root()`
// (./invalidation.ts, FE-166 step 1). What the window can still hide is
// another person's change: seats taken by others, another master's edit.
//
// Window focus (a return to Telegram): only the page payload revalidates,
// the feed does not -- Colada's default (refetch when stale) would send
// both GETs on a return after the window. The page carries the viewer's
// relation, which changes outside this screen (an invite accepted in the bot
// chat, a curator's removal); the feed's booking marks change through this
// app's own mutations, which invalidate it (./invalidation.ts).
//
// Leaving a school (forgetSchool) drops both entries: the cached copy holds
// the member relation, and a reopen would paint the member actions for a
// moment before the refetch answers.
// =============================================================================

import { computed } from 'vue'
import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  useQuery,
  useQueryCache,
  type EntryKey,
  type QueryCache,
} from '@pinia/colada'
import {
  getMySchools,
  getSchoolPage,
  getSchoolPractices,
  getSchoolAnalytics,
  getSchoolBlocks,
  getSchoolMembers,
  getSchoolRoster,
  getSchoolStudentProfile,
  getSchools,
  type SchoolAnalyticsPeriod,
} from '@/api/schools'
import { isOptionEnabled } from '@/platform/instance'
import { useAuthStore } from '@/stores/auth'
import { keys } from '@/composables/queries/keys'
import { invalidateAfter, type MutationName } from '@/composables/queries/invalidation'
import type {
  SchoolAnalyticsResponse,
  SchoolBlockedItem,
  SchoolMineItem,
  SchoolRosterItem,
} from '@/api/types'

/** Query options for the school page payload (`GET /schools/{id}`). */
export const schoolPageQuery = defineQueryOptions((schoolId: string) => ({
  key: keys.schools.detail(schoolId),
  query: () => getSchoolPage(schoolId),
  staleTime: 0,
  refetchOnWindowFocus: true,
}))

/**
 * Query options for one student's school-scoped profile (curator only,
 * `GET /masters/me/schools/{id}/students/{userId}`): practices, hours, the pending
 * master offer. Revalidates on every visit (staleTime 0): the offer and the
 * figures move outside this screen.
 */
export const schoolStudentQuery = defineQueryOptions(
  ({ schoolId, userId }: { schoolId: string; userId: string }) => ({
    key: keys.schools.student(schoolId, userId),
    query: () => getSchoolStudentProfile(schoolId, userId),
    staleTime: 0,
  }),
)

/**
 * Query options for the curator's analytics of one school for one period
 * (`GET /masters/me/schools/{id}/analytics?period=`).
 *
 * @remarks
 * Revalidates on every visit (staleTime 0): the figures move with other
 * people's visits and reviews. A period switch keeps the previous period's
 * numbers on screen while the new ones load (placeholderData), but only
 * within one school: another school's numbers under this route, even
 * briefly, are the stale-data state the screen forbids.
 */
export const schoolAnalyticsQuery = defineQueryOptions(
  ({ schoolId, period }: { schoolId: string; period: SchoolAnalyticsPeriod }) => ({
    key: keys.schools.analytics(schoolId, period),
    query: () => getSchoolAnalytics(schoolId, period),
    staleTime: 0,
    placeholderData: (
      previous: SchoolAnalyticsResponse | undefined,
      previousEntry?: { key: EntryKey },
    ) => (previousEntry?.key[2] === schoolId ? previous : undefined),
  }),
)

/** Rows per page of a school roster. */
export const SCHOOL_MEMBERS_PAGE_SIZE = 20

/** Where a roster comes from: the curator's member list, the curator's removed tab, a school master's roster. */
export type SchoolMembersSource = 'members' | 'blocks' | 'roster'

/** One page of any school roster. */
type SchoolMembersPage = { items: (SchoolRosterItem | SchoolBlockedItem)[]; total: number }

/**
 * Infinite query options for one roster of a school (SchoolMembersView), for
 * one tab and one search, SCHOOL_MEMBERS_PAGE_SIZE rows per page.
 *
 * @remarks
 * Revalidates on every visit (staleTime 0): members join, leave and are
 * removed by other people. Each (school, source, tab, search) is its own
 * entry, so an answer for an older search or another tab never repaints the
 * current one.
 */
export const schoolMembersQuery = defineInfiniteQueryOptions(
  ({
    schoolId,
    source,
    kind,
    search,
    enabled,
  }: {
    schoolId: string
    source: SchoolMembersSource
    kind: 'master' | 'student' | 'blocked'
    search: string
    enabled: boolean
  }) => ({
    key: keys.schools.members(schoolId, { source, kind, search }),
    query: ({ pageParam }: { pageParam: number }): Promise<SchoolMembersPage> => {
      const window = { limit: SCHOOL_MEMBERS_PAGE_SIZE, offset: pageParam }
      if (source === 'blocks') return getSchoolBlocks(schoolId, window)
      const query = { kind: kind as 'master' | 'student', search: search || undefined, ...window }
      return source === 'roster'
        ? getSchoolRoster(schoolId, query)
        : getSchoolMembers(schoolId, query)
    },
    initialPageParam: 0,
    getNextPageParam: (last: SchoolMembersPage, pages: SchoolMembersPage[]) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < last.total ? loaded : null
    },
    staleTime: 0,
    enabled,
  }),
)

/** Query options for the first `limit` upcoming practices of a school (`GET /schools/{id}/practices`). */
export const schoolFeedQuery = defineQueryOptions(
  ({ schoolId, limit }: { schoolId: string; limit: number }) => ({
    key: keys.practices.schoolFeed(schoolId, limit),
    query: async () => (await getSchoolPractices(schoolId, limit, 0)).items,
    refetchOnWindowFocus: false,
  }),
)

/**
 * Drop every cached entry of one school: the page payload, its students' profiles,
 * and every practice list scoped to it (its feeds of any limit, a master's
 * upcoming practices in its context).
 *
 * @remarks
 * For after the viewer left the school. An entry nobody holds is removed, so
 * the next visit starts from the loader, not from the old relation. One still
 * held by a screen cannot be removed (it would keep a detached copy); it is
 * invalidated instead and refetches at once.
 */
export function forgetSchool(queryCache: QueryCache, schoolId: string): void {
  const entries = [
    ...queryCache.getEntries({ key: keys.schools.detail(schoolId) }),
    ...queryCache.getEntries({ key: ['practices', 'list', { schoolId }] }),
  ]
  for (const entry of entries) {
    if (entry.active) void queryCache.invalidate(entry)
    else queryCache.remove(entry)
  }
}

// =============================================================================
// School lists (FE-166 step 2: moved from the in-house cache)
// =============================================================================
//
// Both lists revalidate on every visit (staleTime 0): a school created or
// joined a moment ago is there on the next one; the cached copy only removes
// the spinner. Each is two parallel calls, one payload split: /mine feeds the
// rows (relation and transfer_offered ride only there), the curator list
// carries the create right. allSettled, because the two calls are NOT equal:
// /mine failing means there is no screen, while the flag call failing only
// means no «+» -- rows plus the honest no-right hint beat an error state over
// data already held.

/** Payload of a schools list screen: the rows, plus the school-create right. */
export interface SchoolsList {
  schools: SchoolMineItem[]
  canCreate: boolean
}

/**
 * Query options for the user zone's schools tab (SchoolsView): the schools I
 * participate in, plus the create right. Persisted across reloads.
 *
 * @remarks
 * The flag lives on the master surface, which answers 403 outside master
 * mode (FE-93), so it is only dialed there -- anywhere else false is the
 * honest «+». The curated rows /mine still returns (relation is
 * role-independent) belong to the master hub's curator tab and would 403
 * their way through this zone's screens, so they are dropped here.
 */
export const userSchoolsQuery = defineQueryOptions((role: string) => ({
  key: keys.schools.mine('participant', role),
  query: async (): Promise<SchoolsList> => {
    const [mineRes, listRes] = await Promise.allSettled([
      getMySchools(),
      role === 'master' ? getSchools() : Promise.resolve(null),
    ])
    if (mineRes.status === 'rejected') throw mineRes.reason
    return {
      schools: mineRes.value.items.filter((g) => g.relation !== 'curator'),
      canCreate:
        listRes.status === 'fulfilled' && listRes.value
          ? (listRes.value.can_create_schools ?? false)
          : false,
    }
  },
  staleTime: 0,
  // No role = no session (the moment of a logout, before the redirect): the
  // reactive key moves to role '' and must not send an anonymous GET.
  enabled: role !== '',
  meta: { persist: true },
}))

/** Query options for the master's schools hub (MasterSchoolsView): every school of mine, plus the create right. */
export const masterSchoolsQuery = defineQueryOptions(() => ({
  key: keys.schools.mine('master-hub'),
  query: async (): Promise<SchoolsList> => {
    const [mineRes, listRes] = await Promise.allSettled([getMySchools(), getSchools()])
    if (mineRes.status === 'rejected') throw mineRes.reason
    return {
      schools: mineRes.value.items,
      canCreate:
        listRes.status === 'fulfilled' ? (listRes.value.can_create_schools ?? false) : false,
    }
  },
  staleTime: 0,
}))

// =============================================================================
// The schools hub: does this account see the Schools tab? (FE-166 step 5)
// =============================================================================
//
// One small piece of server truth the SHELLS need before any school screen
// mounts (tz-curator.md §1.2; this used to be stores/schoolsHub.ts).
//
// THE TAB FOLLOWS MEMBERSHIP (owner 2026-09-22, FE-88), not curatorship:
//   - USER zone: >= 1 JOINED school (FE-93: master / student memberships;
//     the curated rows /mine still answers -- relation is role-independent
//     -- are the master list's curator section
//     (i18n:masterScreens.masterSchools.tab.curator), so a curator switched
//     to user mode counts their participations only). /schools/mine is a
//     user surface, so EVERY authenticated account is probed.
//   - MASTER zone: the same membership (any relation), OR the admin-issued
//     right to found a school (can_create_schools, BE-18). A right holder
//     with zero schools keeps their entrance -- the empty hub with its create
//     CTA (i18n:masterScreens.masterSchools.create) is exactly their screen.
//
// The facts ride TWO queries: GET /schools/mine (memberships; everyone) and
// GET /masters/me/schools (the founding right; only IN MASTER MODE with
// master capability -- the surface requires the current role, so the probe
// waits for it instead of burning a 403 per shell mount). With the instance
// option `schools` off (FE-151) neither runs.
//
// Fail-closed: until a probe has answered once, it reads as "no schools" /
// "no right"; a failed probe is retried by the next shell mount (Colada
// refetches an entry in error), and a failed refresh keeps the last answer.
// Freshness: like the store before it, one answer per session (staleTime
// Infinity) while a shell holds it -- a mount of another consumer (a
// practice card, the other zone's shell) asks nothing; an entry nobody holds
// for gcTime is dropped and asked again by the next shell. Every membership
// change made in this app -- a join, an accepted master offer, a leave, an
// accepted transfer -- goes through membershipChanged (below); one made
// elsewhere (an invite accepted in the bot) shows from the next session.

/** Query options for every school I belong to, any relation (`GET /schools/mine` items). */
export const mySchoolsQuery = defineQueryOptions(() => ({
  key: keys.schools.mine('all'),
  query: async (): Promise<SchoolMineItem[]> => (await getMySchools()).items,
  enabled: isOptionEnabled('schools'),
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
}))

/**
 * Query options for the right to found a school (BE-18).
 *
 * @param onMasterSurface - In master mode with master capability: only then
 *   does `/masters/me/schools` answer (403 otherwise).
 */
export const schoolCreateRightQuery = defineQueryOptions((onMasterSurface: boolean) => ({
  key: keys.schools.createRight(),
  query: async (): Promise<boolean> => (await getSchools()).can_create_schools ?? false,
  enabled: isOptionEnabled('schools') && onMasterSurface,
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
}))

/**
 * The USER-zone tab condition over the /mine answer. FE-93: in user mode only
 * JOINED schools count; in master mode any relation does. The answer does
 * not depend on the role, so a role switch recomputes it -- no re-probe.
 */
export function hasSchoolsFor(
  mine: readonly SchoolMineItem[] | undefined,
  role: string | null,
): boolean {
  if (!mine) return false
  if (role === 'master') return mine.length > 0
  return mine.some((g) => g.relation !== 'curator')
}

/** Whether the signed-in account may read the master surface (role master + capability). */
function onMasterSurface(auth: ReturnType<typeof useAuthStore>): boolean {
  return auth.role === 'master' && auth.allowedRoles.includes('master')
}

/**
 * Load the hub's facts outside a component (the first-screen gate, the idle
 * prefetch): ensure both entries and refresh them if stale. Never rejects --
 * a failed probe leaves the tab hidden (fail-closed).
 */
export async function ensureSchoolsHub(queryCache: QueryCache = useQueryCache()): Promise<void> {
  const auth = useAuthStore()
  if (!isOptionEnabled('schools')) return
  const probes: Promise<unknown>[] = [queryCache.refresh(queryCache.ensure(mySchoolsQuery()))]
  if (onMasterSurface(auth)) {
    probes.push(queryCache.refresh(queryCache.ensure(schoolCreateRightQuery(true))))
  }
  await Promise.allSettled(probes)
}

/**
 * A membership of this account changed: invalidate the mutation's row
 * (./invalidation.ts), THEN re-read the hub -- in this order, so the re-read
 * sees the stale mark. A screen outside the shells (the join and master-offer
 * routes) awaits it before navigating, so the shell it lands in shows the
 * Schools tab at once; a screen inside a shell may fire and forget (the shell
 * holds the hub, which the invalidation refetches anyway). Never rejects.
 */
export async function membershipChanged(
  queryCache: QueryCache,
  mutation: Extract<
    MutationName,
    'joinSchool' | 'acceptSchoolMasterOffer' | 'leaveSchool' | 'acceptSchoolTransfer'
  >,
): Promise<void> {
  await invalidateAfter(queryCache, mutation)
  await ensureSchoolsHub(queryCache)
}

/** The user-zone tab condition from the cache, outside a component (the idle prefetch). */
export function cachedHasSchools(queryCache: QueryCache): boolean {
  return hasSchoolsFor(
    queryCache.getQueryData<SchoolMineItem[]>(keys.schools.mine('all')),
    useAuthStore().role,
  )
}

/** My schools, any relation ([] until the probe answers) -- for a screen that needs only them (a curator check). */
export function useMySchools() {
  const mine = useQuery(() => mySchoolsQuery())
  return computed<SchoolMineItem[]>(() => mine.data.value ?? [])
}

/**
 * The schools hub for a shell: my schools, the tab conditions per zone, the
 * create right.
 */
export function useSchoolsHub() {
  const auth = useAuthStore()
  const mine = useQuery(() => mySchoolsQuery())
  const right = useQuery(() => schoolCreateRightQuery(onMasterSurface(auth)))
  return {
    /** Schools I belong to, any relation ([] until the probe answers). */
    mine: computed<SchoolMineItem[]>(() => mine.data.value ?? []),
    /** The user-zone tab condition (fail-closed). */
    hasSchools: computed(() => hasSchoolsFor(mine.data.value, auth.role)),
    /** The founding right (false until the master-surface probe answers). */
    canCreate: computed(() => right.data.value ?? false),
  }
}
