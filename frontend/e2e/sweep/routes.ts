/**
 * The sweep table (FE-161): every NAMED route of the router, keyed by name --
 * either visited (under which roles, with which parameters) or skipped with
 * a reason. src/router/sweep-coverage.test.ts fails when a route has no row,
 * when a row's path drifts from the router's, or when a parameter has no
 * source -- so a new screen cannot fall out of the sweep.
 *
 * Roles are the seeded people of frontend/e2e/stack/seed/e2e.json:
 *   student = ada, master = mira (school curator), admin = root;
 *   cara and ben are students for the screens ada cannot see in their normal
 *   state (cara waits on a waitlist; ben has an attended practice without a
 *   review).
 * Parameters name keys of `e2e/.state/params.json`, collected by
 * e2e/stack/stack.setup.ts.
 *
 * Pure data: imported by the vitest coverage test as well as by Playwright.
 */
import type { CrashAllowance } from '../support/crashes'

/**
 * Every value the setup (e2e/stack/stack.setup.ts) writes to params.json. A
 * row may only name these (the coverage test checks it), and the setup must
 * fill every one of them (it checks itself).
 */
export const PARAM_KEYS = [
  'masterUserId',
  'studentUserId',
  'practiceUpcomingId',
  'practicePastId',
  'schoolId',
  'schoolInviteToken',
  'checkinId',
  'diaryEntryId',
  'chatThreadId',
  'supportTicketId',
  'reportId',
  'waitlistId',
  'groupId',
  'groupInviteToken',
  'masterInviteToken',
] as const

/** A key of params.json. */
export type ParamKey = (typeof PARAM_KEYS)[number]

/** Who opens a screen. */
export type SweepRole = 'student' | 'master' | 'admin' | 'cara' | 'ben'

/** A route the sweep opens. */
export interface SweepVisit {
  /** The route's full path, exactly as the router has it. */
  path: string
  roles: SweepRole[]
  /** Route parameter -> key in params.json, or `=literal`. */
  params?: Record<string, ParamKey | `=${string}`>
  /** The URL the screen settles on, for a route that redirects by design. */
  lands?: RegExp | ((role: SweepRole) => RegExp)
  /** Signals this screen produces by design; each with its reason. */
  allow?: (role: SweepRole) => CrashAllowance[]
}

/** A route the sweep does not open, and why. */
export interface SweepSkip {
  path: string
  skip: string
}

export type SweepRow = SweepVisit | SweepSkip

/** The zone each role's home is in. */
const ZONE: Record<SweepRole, string> = {
  student: 'user',
  cara: 'user',
  ben: 'user',
  master: 'master',
  admin: 'admin',
}

const S: SweepRole[] = ['student']
const M: SweepRole[] = ['master']
const A: SweepRole[] = ['admin']

export const SWEEP: Record<string, SweepRow> = {
  // --- public -----------------------------------------------------------------
  root: {
    path: '/',
    roles: ['student', 'master', 'admin'],
    // Each role to ITS zone's dashboard.
    lands: (role) => new RegExp(`/${ZONE[role]}/dashboard$`),
  },
  'auth-error': {
    path: '/auth-error',
    roles: S,
    allow: () => [{ reason: 'the auth-error screen IS an error state', screen: ['screen-error'] }],
  },
  'not-found': {
    path: '/404',
    roles: S,
    allow: () => [{ reason: 'the 404 screen IS the not-found state', screen: ['not-found'] }],
  },

  // Where a navigation into a switched-off instance option lands (FE-163).
  'section-unavailable': { path: '/unavailable', roles: S },

  // --- user zone (ada) ---------------------------------------------------------
  'user-dashboard': { path: '/user/dashboard', roles: S },
  'user-calendar': { path: '/user/calendar', roles: S },
  'user-calendar-master': {
    path: '/user/calendar/master/:masterId',
    roles: S,
    params: { masterId: 'masterUserId' },
  },
  'user-calendar-school': {
    path: '/user/calendar/school/:schoolId',
    roles: S,
    params: { schoolId: 'schoolId' },
  },
  'user-diary': { path: '/user/diary', roles: S },
  'user-diary-entry': { path: '/user/diary/entry/:id', roles: S, params: { id: 'diaryEntryId' } },
  'user-diary-detail': {
    path: '/user/diary/:type(checkin|feedback)/:id',
    roles: S,
    params: { type: '=checkin', id: 'checkinId' },
  },
  'user-diary-activity-new': { path: '/user/diary/activity/new', roles: S },
  'user-profile': { path: '/user/profile', roles: S },
  'user-timezone': { path: '/user/profile/timezone', roles: S },
  'user-edit-profile': { path: '/user/profile/edit', roles: S },
  'user-notifications': { path: '/user/profile/notifications', roles: S },
  'user-messages': { path: '/user/profile/messages', roles: S },
  'user-chat': { path: '/user/profile/messages/:id', roles: S, params: { id: 'chatThreadId' } },
  'user-support': { path: '/user/support', roles: S },
  'practice-detail': {
    path: '/user/practices/:id',
    roles: S,
    params: { id: 'practiceUpcomingId' },
  },
  'user-master-public': { path: '/user/masters/:id', roles: S, params: { id: 'masterUserId' } },
  'user-booking-confirmed': {
    path: '/user/booking-confirmed/:practiceId',
    roles: S,
    params: { practiceId: 'practiceUpcomingId' },
  },
  'user-bookings': { path: '/user/bookings', roles: S },
  'user-inbox': { path: '/user/notifications', roles: S },
  'user-my-schools': { path: '/user/my-schools', roles: S },
  'user-schools': { path: '/user/schools', roles: S },
  'user-school': { path: '/user/schools/:id', roles: S, params: { id: 'schoolId' } },
  'user-checkin': {
    path: '/user/checkin/:practiceId',
    roles: S,
    params: { practiceId: 'practiceUpcomingId' },
  },
  'waitlist-confirm': { path: '/user/waitlist/:id', roles: ['cara'], params: { id: 'waitlistId' } },
  'user-feedback': {
    path: '/user/feedback/:practiceId',
    roles: ['ben'],
    params: { practiceId: 'practicePastId' },
  },
  'user-reflection': {
    path: '/user/reflection/:practiceId',
    roles: S,
    params: { practiceId: 'practicePastId' },
  },
  'practice-live': {
    path: '/user/practice-live/:practiceId',
    roles: S,
    params: { practiceId: 'practiceUpcomingId' },
  },
  'user-ai-connections': { path: '/user/profile/ai-connections', roles: S },
  'user-ai-summary': { path: '/user/ai-summary', roles: S },
  'user-topup': { path: '/user/topup', roles: S },
  'user-topup-success': { path: '/user/topup/success', roles: S },
  'user-topup-cancel': { path: '/user/topup/cancel', roles: S },

  // --- master zone (mira) --------------------------------------------------------
  'master-dashboard': { path: '/master/dashboard', roles: M },
  'master-inbox': { path: '/master/notifications', roles: M },
  'master-practices': { path: '/master/practices', roles: M },
  'master-practice-new': { path: '/master/practices/new', roles: M },
  'master-practice-edit': {
    path: '/master/practices/:id',
    roles: M,
    params: { id: 'practiceUpcomingId' },
  },
  'master-practice-live': {
    path: '/master/practice-live/:practiceId',
    roles: M,
    params: { practiceId: 'practiceUpcomingId' },
  },
  'master-attendance': {
    path: '/master/practices/:id/attendance',
    roles: M,
    params: { id: 'practicePastId' },
  },
  'master-practice-detail': {
    path: '/master/practices/:id/detail',
    roles: M,
    params: { id: 'practicePastId' },
  },
  'master-attendance-roster': {
    path: '/master/practices/:id/roster',
    roles: M,
    params: { id: 'practicePastId' },
  },
  'master-analytics': { path: '/master/analytics', roles: M },
  'master-practice-reviews': {
    path: '/master/analytics/practice/:id',
    roles: M,
    params: { id: 'practicePastId' },
  },
  'master-profile': { path: '/master/profile', roles: M },
  'master-edit-profile': { path: '/master/profile/edit', roles: M },
  'master-notifications': { path: '/master/profile/notifications', roles: M },
  'master-timezone': { path: '/master/profile/timezone', roles: M },
  'master-support': { path: '/master/support', roles: M },
  'master-messages': { path: '/master/messages', roles: M },
  'master-chat': { path: '/master/messages/:id', roles: M, params: { id: 'chatThreadId' } },
  'master-promocodes': { path: '/master/promocodes', roles: M },
  'master-promocode-new': { path: '/master/promocodes/new', roles: M },
  'master-finance': { path: '/master/finance', roles: M },
  'master-students': { path: '/master/students', roles: M },
  'master-student-profile': {
    path: '/master/students/:id',
    roles: M,
    params: { id: 'studentUserId' },
  },
  'master-groups': { path: '/master/groups', roles: M },
  'master-group-create': { path: '/master/groups/new', roles: M },
  'master-group-detail': { path: '/master/groups/:id', roles: M, params: { id: 'groupId' } },
  'master-schools': { path: '/master/schools', roles: M },
  'master-school-create': { path: '/master/schools/new', roles: M },
  'master-school': { path: '/master/schools/:id', roles: M, params: { id: 'schoolId' } },
  'master-school-members': {
    path: '/master/schools/:id/members',
    roles: M,
    params: { id: 'schoolId' },
  },
  'master-school-analytics': {
    path: '/master/schools/:id/analytics',
    roles: M,
    params: { id: 'schoolId' },
  },
  'master-school-student': {
    path: '/master/schools/:schoolId/students/:userId',
    roles: M,
    params: { schoolId: 'schoolId', userId: 'studentUserId' },
  },
  'master-summary': { path: '/master/summary', roles: M },
  // Outside the master shell: the onboarding doors.
  'master-apply': { path: '/master/apply', roles: ['cara'] },
  // A verified master sees the "approved, enter the workspace" state.
  'master-pending': { path: '/master/pending', roles: M },
  // Claims the one-time token on mount (setup mints one per run), then
  // replaces to the application form.
  'master-invite': {
    path: '/master/invite/:token',
    roles: ['cara'],
    params: { token: 'masterInviteToken' },
    lands: /\/master\/apply$/,
  },
  // Joins on mount (idempotent: ada stays a member), then lands home.
  'group-join': {
    path: '/groups/join/:token',
    roles: S,
    params: { token: 'groupInviteToken' },
    lands: /\/user\/dashboard$/,
  },
  'school-join': {
    path: '/schools/join/:token',
    roles: ['cara'],
    params: { token: 'schoolInviteToken' },
  },
  'school-master-offer': {
    path: '/schools/:id/master-offer',
    roles: S,
    params: { id: 'schoolId' },
  },

  // --- admin zone (root) ----------------------------------------------------------
  'admin-dashboard': { path: '/admin/dashboard', roles: A },
  'admin-masters': { path: '/admin/masters', roles: A },
  'admin-users': { path: '/admin/users', roles: A },
  'admin-master-invite': { path: '/admin/masters/invite', roles: A },
  'admin-master-review': { path: '/admin/masters/:id', roles: A, params: { id: 'masterUserId' } },
  'admin-schools': { path: '/admin/schools', roles: A },
  'admin-method-requests': { path: '/admin/method-requests', roles: A },
  'admin-catalog': { path: '/admin/catalog', roles: A },
  'admin-reports': { path: '/admin/reports', roles: A },
  'admin-report-detail': { path: '/admin/reports/:id', roles: A, params: { id: 'reportId' } },
  'admin-profile': { path: '/admin/profile', roles: A },
  'admin-checkin-rate': { path: '/admin/metrics/check-in', roles: A },
  'admin-feedback-rate': { path: '/admin/metrics/feedback', roles: A },
  'admin-return-rate': { path: '/admin/metrics/return', roles: A },
  'admin-revenue': { path: '/admin/revenue', roles: A },
  'admin-participants': { path: '/admin/participants', roles: A },
  'admin-practices': { path: '/admin/practices', roles: A },
  'admin-practice-detail': {
    path: '/admin/practices/:id',
    roles: A,
    params: { id: 'practicePastId' },
  },
  'admin-promos': { path: '/admin/promos', roles: A },
  'admin-support-stats': { path: '/admin/support/stats', roles: A },
  'admin-support-detail': {
    path: '/admin/support/:id',
    roles: A,
    params: { id: 'supportTicketId' },
  },
  'admin-withdrawals': { path: '/admin/withdrawals', roles: A },
  // No get-by-id endpoint: the screen reads history.state from the list and a
  // deep link is sent back to the list -- which is what the sweep checks.
  'admin-withdrawal-detail': {
    path: '/admin/withdrawals/:id',
    roles: A,
    params: { id: '=00000000-0000-4000-8000-000000000000' },
    lands: /\/admin\/withdrawals$/,
  },
}

/**
 * The path of a visit with its parameters filled from `params`. A parameter
 * source starting with `=` is a literal value. Null when a value is missing.
 */
export function fillPath(row: SweepVisit, params: Record<string, string>): string | null {
  let missing = false
  const path = row.path.replace(/:(\w+)(\([^)]*\))?/g, (_m, name: string) => {
    const source = row.params?.[name]
    const value = source?.startsWith('=') ? source.slice(1) : source ? params[source] : undefined
    if (!value) missing = true
    return encodeURIComponent(value ?? '')
  })
  return missing ? null : path
}
