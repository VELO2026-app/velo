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
  /** Prefix of every revenue window (Colada matches the params object partially). */
  revenueAll: () => ['admin', 'metric', { kind: 'revenue' }] as const,
  /** `GET /admin/practices?scope=` -- the platform's practices, first page. */
  practices: (scope: string) => ['admin', 'practices', { scope }] as const,
  /** `GET /admin/practices?scope=&limit=&offset=` -- one page of the platform's practices (the web console). */
  practicesPage: (scope: string, page: number) => ['admin', 'practices', { scope, page }] as const,
  /** Prefix of every platform practices list. */
  practicesAll: () => ['admin', 'practices'] as const,
  /** `GET /admin/participants?filter=` -- the platform's users, every page loaded so far. */
  participants: (filter: string) => ['admin', 'participants', { filter }] as const,
  /** Prefix of every platform participants list. */
  participantsAll: () => ['admin', 'participants'] as const,
  /** `GET /admin/practices/{id}` -- one practice with its roster. */
  practice: (practiceId: string) => ['admin', 'practice', practiceId] as const,
  /** Prefix of every practice detail (and its attendance). */
  practiceAll: () => ['admin', 'practice'] as const,
  /**
   * `GET /admin/practices/{id}/zoom-attendance` -- the practice's meeting
   * status and attendance match. Under the practice's prefix.
   */
  practiceAttendance: (practiceId: string) =>
    ['admin', 'practice', practiceId, 'attendance'] as const,
  /** `GET /admin/taxonomy` -- the method catalog with its inactive items (the catalog editor). */
  taxonomy: () => ['admin', 'taxonomy'] as const,
  /** `GET /admin/schools` -- every school of the platform, every page loaded so far. */
  schools: () => ['admin', 'schools'] as const,
  /** `GET /admin/schools` -- one page of the web console's schools table. Under the schools prefix. */
  schoolsPage: (page: number) => ['admin', 'schools', { page }] as const,
  /** Prefix of every promo list. */
  promosAll: () => ['admin', 'promos'] as const,
  /** `GET /admin/promos?type=&is_active=` -- one tab of the promo oversight list, every page loaded so far. */
  promos: (filter: string) => ['admin', 'promos', { filter }] as const,
  /** Prefix of every page of the promo list (the web console's table). */
  promoPagesAll: () => ['admin', 'promoPages'] as const,
  /**
   * `GET /admin/promos?type=&limit=&offset=` -- one page (1-based) of one
   * tab of the promo list, the web console's table. A prefix of its own,
   * not under `promos`: those entries hold infinite-query data, and the
   * writers of that shape (markPromoInactive) must not meet a page.
   */
  promosPage: (filter: string, page: number) => ['admin', 'promoPages', { filter, page }] as const,
  /** `GET /admin/users` -- every user of the platform (any role), every page loaded so far. */
  users: () => ['admin', 'users'] as const,
  /** `GET /admin/users?role=&is_active=` -- one page of one tab of the web console's users table. Under the users prefix. */
  usersPage: (tab: string, active: string, page: number) =>
    ['admin', 'users', { tab, active, page }] as const,
  /** The total of one tab of the web console's users table (a one-row request). Under the users prefix. */
  usersCount: (tab: string, active: string) =>
    ['admin', 'users', { tab, active, count: true }] as const,
  /** `GET /admin/masters/list` -- every master with its status, counts and methods. */
  masters: () => ['admin', 'masters'] as const,
  /** `GET /admin/masters/list?status=` -- one page of one tab of the web console's masters table. Under the masters prefix. */
  mastersPage: (tab: string, page: number) => ['admin', 'masters', { tab, page }] as const,
  /** The total of one tab of the web console's masters table (a one-row request). Under the masters prefix. */
  mastersCount: (tab: string) => ['admin', 'masters', { tab, count: true }] as const,
  /** Prefix of every master's detail (and what hangs under it). */
  masterAll: () => ['admin', 'master'] as const,
  /** `GET /admin/masters/{id}` -- one master's full application / profile. */
  master: (userId: string) => ['admin', 'master', userId] as const,
  /**
   * `GET /admin/masters/{id}/revoke-preview` -- what revoking would leave
   * behind. NOT under the master's prefix: a verdict invalidates the detail,
   * and a preview refetched after the revoke would only answer 409 (the
   * master is no longer verified).
   */
  revokePreview: (userId: string) => ['admin', 'revokePreview', userId] as const,
  /** Prefix of every revoke advisory. */
  revokePreviewAll: () => ['admin', 'revokePreview'] as const,
  /** `GET /admin/masters/method-change-requests` -- pending method-change requests, every page loaded so far. */
  methodRequests: () => ['admin', 'methodRequests'] as const,
  /** Prefix of every moderation-report list. */
  reportsAll: () => ['admin', 'reports'] as const,
  /** `GET /admin/reports?status=` -- one status filter of the complaints tab, every page loaded so far. */
  reports: (status: string) => ['admin', 'reports', { status }] as const,
  /** Prefix of every report's detail. */
  reportAll: () => ['admin', 'report'] as const,
  /** `GET /admin/reports/{id}` -- one report (a deep link; the list hands its row otherwise). */
  report: (reportId: string) => ['admin', 'report', reportId] as const,
  /** `GET /admin/withdrawals` -- every payout request, every page loaded so far. */
  withdrawals: () => ['admin', 'withdrawals'] as const,
  /**
   * `GET /admin/withdrawals?status=&limit=&offset=` -- one page (1-based) of
   * one status of the payout queue, the web console's table. Under
   * `withdrawals`, so a verdict makes every page stale at once.
   */
  withdrawalsPage: (status: string, page: number) =>
    ['admin', 'withdrawals', { status, page }] as const,
  /**
   * `GET /admin/withdrawals?status=pending&limit=1` -- how many payout
   * requests wait (the dashboard's queue). Under the payouts prefix, so a
   * decision on a request makes it stale with the list.
   */
  withdrawalsPending: () => ['admin', 'withdrawals', 'pending'] as const,
  /**
   * `GET /support/tickets?status=open` -- how many support tickets are open
   * (the dashboard's queue). A key of its own, not under the ticket lists:
   * taking a ticket does not move the count.
   */
  openTickets: () => ['admin', 'support', 'openTickets'] as const,
  /** `GET /admin/users?role=admin` -- the admins a support ticket can be handed to. */
  admins: () => ['admin', 'admins'] as const,
  /** Prefix of every support ticket list. */
  supportTicketsAll: () => ['admin', 'support', 'tickets'] as const,
  /** `GET /admin/support/tickets` for one tab and filter, every page loaded so far. */
  supportTickets: (query: object) => ['admin', 'support', 'tickets', query] as const,
  /** `GET /admin/support/tickets/{id}` -- one ticket. */
  supportTicket: (ticketId: string) => ['admin', 'support', 'ticket', ticketId] as const,
  /** `GET /support/threads/{id}/messages` -- one thread's feed (a ticket, or a person's history). */
  supportMessages: (threadId: string) => ['admin', 'support', 'messages', threadId] as const,
  /** Prefix of every support stats window. */
  supportStatsAll: () => ['admin', 'support', 'stats'] as const,
  /** `GET /admin/support/stats` -- the figures of the tickets created in one window. */
  supportStats: (createdFrom: string, createdTo: string) =>
    ['admin', 'support', 'stats', { createdFrom, createdTo }] as const,
}
