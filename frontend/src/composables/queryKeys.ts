// =============================================================================
// VELO Frontend -- screen-data cache keys (composables/useQuery)
// =============================================================================
// One place for every key, so a mutation can invalidate exactly what it
// changed (queryCache.invalidate(prefix)) and two screens asking for the same
// data share one entry. A key starts with the resource, then narrows.
// =============================================================================

export const queryKeys = {
  /** GET /bookings/me/stats -- attended practices + hours. */
  myStats: () => ['bookings', 'me', 'stats'] as const,
  /** GET /practices/{id} -- the practice detail screen. */
  practice: (id: string) => ['practice', id] as const,
}
