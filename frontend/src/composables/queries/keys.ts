// =============================================================================
// VELO Frontend -- Pinia Colada query keys, one factory per domain (FE-157 4F)
// =============================================================================
//
// Every Colada key is built here, never inline in a screen: a mutation can
// only invalidate what it can name, and two screens share an entry only when
// they build the same key. Shape: [domain, kind, params?]
//
//   - domain -- what the data IS (practices, schools, bookings), not the
//     screen that shows it: the school page's feed is a practice list, so a
//     mutation that changes practices reaches it through `practices`;
//   - kind -- 'detail' for one entity by id, 'list' for a collection;
//   - params -- the id, or ONE object with every request parameter (Colada
//     sorts object keys when hashing and matches objects partially, so
//     `['practices', 'list', { schoolId }]` covers every limit of that school).
//
// Invalidation is by prefix: `keys.practices.root()` covers every practice
// detail and list. The mutation -> keys map lives in ./invalidation.ts.
//
// =============================================================================

/** Query-key factory for Pinia Colada, grouped by data domain. */
export const keys = {
  /** Practices: details and every practice list (school feeds included). */
  practices: {
    /** Prefix of every practice key. */
    root: () => ['practices'] as const,
    /** Prefix of every practice list. */
    lists: () => ['practices', 'list'] as const,
    /** `GET /practices/{id}` -- one practice (the detail screen and its flow views). */
    detail: (practiceId: string) => ['practices', 'detail', practiceId] as const,
    /**
     * `GET /practices` for one calendar week: the range, the facets and the
     * master scope (composables/queries/calendar.ts).
     */
    calendarWeek: (params: object) => ['practices', 'list', { calendar: params }] as const,
    /** `GET /schools/{id}/practices`, every page -- the stacked school calendar's whole feed. */
    schoolUpcoming: (schoolId: string) => ['practices', 'list', { schoolId, all: true }] as const,
    /** `GET /schools/{id}/practices` -- the school's upcoming practices, first `limit`. */
    schoolFeed: (schoolId: string, limit: number) =>
      ['practices', 'list', { schoolId, limit }] as const,
    /**
     * `GET /practices?master_id=` -- a master's next scheduled practices as their
     * public page lists them, in one school's context or none (`schoolId` '').
     */
    masterUpcoming: (masterId: string, schoolId: string) =>
      ['practices', 'list', { masterId, schoolId }] as const,
    /** Prefix of both lists of the signed-in master's own practices. */
    mineAll: () => ['practices', 'list', { own: true }] as const,
    /**
     * `GET /masters/me/practices?bucket=` every page loaded so far: `upcoming`
     * (draft / scheduled / live, nearest first) or `past` (completed, most
     * recent first).
     */
    mine: (bucket: 'upcoming' | 'past') => ['practices', 'list', { own: true, bucket }] as const,
  },
  /** Schools: the school page and, later, the school lists. */
  schools: {
    /** Prefix of every school key. */
    root: () => ['schools'] as const,
    /** Prefix of every school LIST (the hub, the tabs' lists, the create right) -- not the school pages. */
    lists: () => ['schools', 'list'] as const,
    /** `GET /schools/{id}` -- the school page payload with the viewer's relation. */
    detail: (schoolId: string) => ['schools', 'detail', schoolId] as const,
    /**
     * `GET /masters/me/schools/{id}/students/{userId}` -- one student's
     * school-scoped profile (curator only). Under the school's detail prefix
     * on purpose, so dropping a school (forgetSchool) drops it too -- which
     * means `getEntries({ key: detail(id) })` returns these entries as well:
     * never read their data as a school page.
     */
    student: (schoolId: string, userId: string) =>
      ['schools', 'detail', schoolId, 'student', userId] as const,
    /**
     * `GET /masters/me/schools/{id}/analytics?period=` -- the curator's
     * analytics of one school for one period. Under the school's detail
     * prefix like `student`, for the same reason.
     */
    analytics: (schoolId: string, period: string) =>
      ['schools', 'detail', schoolId, 'analytics', { period }] as const,
    /**
     * `GET /schools/mine` (+ the create right) as one screen shows it: the user
     * zone's schools tab for a role, or the master's schools hub.
     */
    mine: (view: 'participant' | 'master-hub' | 'all', role = '') =>
      ['schools', 'list', 'mine', { view, role }] as const,
    /** `GET /masters/me/schools` read for one fact: the admin-issued right to found a school (BE-18). */
    createRight: () => ['schools', 'list', 'createRight'] as const,
  },
  /** Masters: the signed-in master's own account, and other masters' public pages. */
  masters: {
    /** Prefix of every master key. */
    root: () => ['masters'] as const,
    /** `GET /masters/me` -- my master profile: status, methods, balance, payout details. */
    profile: () => ['masters', 'me', 'profile'] as const,
    /** `GET /masters/{id}` -- a master's public page. */
    public: (masterId: string) => ['masters', 'public', masterId] as const,
  },
  /** The signed-in master's student groups (custom ones and the two system groups). */
  groups: {
    /** Prefix of every group key. */
    root: () => ['groups'] as const,
    /** `GET /masters/me/groups` -- every group with its name, description and count. */
    list: () => ['groups', 'list'] as const,
    /** `GET /masters/me/groups/{id}/members?search=` -- one group's members for one search. */
    members: (groupId: string, search: string) =>
      ['groups', 'members', { groupId, search }] as const,
  },
  /** The user-zone bell. */
  notifications: {
    /** Prefix of every notification key. */
    root: () => ['notifications'] as const,
    /** The unread badge riding `GET /notifications` (no separate unread endpoint exists). */
    unread: () => ['notifications', 'unread'] as const,
  },
  /** Bookings of the signed-in user and what is derived from them. */
  bookings: {
    /** Prefix of every booking key. */
    root: () => ['bookings'] as const,
    /**
     * `GET /bookings/me/stats` -- attended practices, hours, the unread dot.
     * Under the bookings root on purpose: every booking mutation can move
     * these numbers, so it refetches them too (./invalidation.ts).
     */
    myStats: () => ['bookings', 'stats'] as const,
    /** `GET /bookings/me` -- every booking of mine, page by page (newest booked first). */
    list: () => ['bookings', 'list'] as const,
    /** `GET /bookings/me/upcoming` -- confirmed and not ended, soonest first (the dashboard). */
    upcoming: () => ['bookings', 'upcoming'] as const,
  },
}
