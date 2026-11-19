// =============================================================================
// VELO Frontend -- Pinia Colada query keys of the admin zone (FE-181)
// =============================================================================
//
// The admin half of ./keys.ts, kept apart for one reason: the admin zone
// loads lazily, and ./keys.ts is part of the startup chunk every user pays
// for. Only admin modules import this one. Same rules as ./keys.ts -- every
// admin key is built here, shape [domain, kind, params?], invalidation by
// prefix.
//
// The admin views (`/admin/*`) answer with their own payloads, shaped for
// oversight, never the user zone's entities -- so they live under one domain
// of their own, and a user-zone mutation never reaches them.
// =============================================================================

/** Query-key factory for the admin zone. */
export const adminKeys = {
  /** Prefix of every admin key. */
  root: () => ['admin'] as const,
  /**
   * `GET /admin/stats` plus the count of reports awaiting moderation: the
   * shell's tab badges, the dashboard's banners, the lists' "all" badges.
   */
  stats: () => ['admin', 'stats'] as const,
  /** `GET /admin/stats/overview` -- the dashboard's stat cards for one period window. */
  overview: (period: string, offset: number) => ['admin', 'overview', { period, offset }] as const,
  /**
   * One engagement metric or the revenue (`GET /admin/metrics/{kind}`,
   * `GET /admin/revenue`) for one period window -- any screen showing the
   * same figures for the same window shares the entry.
   */
  metric: (kind: 'checkin' | 'feedback' | 'return' | 'revenue', period: string, offset: number) =>
    ['admin', 'metric', { kind, period, offset }] as const,
  /** `GET /admin/practices?scope=` -- the platform's practices, first page. */
  practices: (scope: string) => ['admin', 'practices', { scope }] as const,
  /** `GET /admin/participants?filter=` -- the platform's users, every page loaded so far. */
  participants: (filter: string) => ['admin', 'participants', { filter }] as const,
}
