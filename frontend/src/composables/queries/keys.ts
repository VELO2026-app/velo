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
// The in-house cache (composables/useQuery) keeps its own keys in
// composables/queryKeys.ts until its three screens move here.
// =============================================================================

/** Query-key factory for Pinia Colada, grouped by data domain. */
export const keys = {
  /** Practices: details and every practice list (school feeds included). */
  practices: {
    /** Prefix of every practice key. */
    root: () => ['practices'] as const,
    /** Prefix of every practice list. */
    lists: () => ['practices', 'list'] as const,
    /** `GET /schools/{id}/practices` -- the school's upcoming practices, first `limit`. */
    schoolFeed: (schoolId: string, limit: number) =>
      ['practices', 'list', { schoolId, limit }] as const,
  },
  /** Schools: the school page and, later, the school lists. */
  schools: {
    /** Prefix of every school key. */
    root: () => ['schools'] as const,
    /** `GET /schools/{id}` -- the school page payload with the viewer's relation. */
    detail: (schoolId: string) => ['schools', 'detail', schoolId] as const,
  },
  /** Bookings of the signed-in user (no Colada query yet; the root is what mutations invalidate). */
  bookings: {
    /** Prefix of every booking key. */
    root: () => ['bookings'] as const,
  },
}
