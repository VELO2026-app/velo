// =============================================================================
// VELO Frontend -- master zone routes (/master, MasterShell, and the
// standalone master-zone screens)
// =============================================================================
//
// The shell and every screen are lazy (FE-157): a student never downloads
// them, and for a master the shell chunk loads in parallel with the first
// screen's chunk and the zone catalog (router/catalogs.ts). Every record
// that mounts a views/master screen declares meta.catalogs, directly or
// through the shell record (pinned by router/catalogs.test.ts). The records
// of an instance option (FE-151: payments, schools) carry meta.option --
// routes/user.ts explains.
//
// Access is declared in meta.requires (router/guards.ts RouteRequirement):
// the shell record requires `master-role`, the dashboard
// `master-application`, and every screen that needs an active master
// `verified-master`; screens without one stay open to a pending master. The
// standalone landings keep their own beforeEnter policies. Every shell child
// is classified in router/routes.test.ts -- a new screen must pick a side.
// =============================================================================

import type { RouteRecordRaw } from 'vue-router'
import { masterPendingGuard, masterApplyGuard } from '@/router/guards'

/**
 * The «payments» option's master surface: the finance screen (FE-112).
 *
 * @remarks The payments option is ALL of its surfaces -- the user's top-ups
 * (routes/user.ts), this screen and the admin's payout queue
 * (routes/admin.ts); each carries meta.option 'payments' (FE-151).
 */
export const PAYMENTS_MASTER_ROUTES: RouteRecordRaw[] = [
  {
    path: 'finance',
    name: 'master-finance',
    meta: { option: 'payments', requires: 'verified-master', hideTabBar: true },
    component: () => import('@/views/master/MasterFinanceView.vue'),
  },
]

/** The /master zone (MasterShell) and the standalone master-zone screens. */
export function masterRoutes(): RouteRecordRaw[] {
  return [
    {
      path: '/master',
      component: () => import('@/views/shells/MasterShell.vue'),
      meta: { catalogs: ['master'], requires: 'master-role' },
      children: [
        {
          path: 'dashboard',
          name: 'master-dashboard',
          // №257 honest entry: a master with NO application is led to the
          // apply wizard; pending/rejected keep the dashboard as before.
          // HEADERLESS hub (DB-1b): no VHeader teleports here — MobileLayout
          // pads by --velo-fog-headerless-top instead of the header fallback.
          meta: { requires: 'master-application', headerless: true },
          component: () => import('@/views/master/MasterDashboardView.vue'),
        },
        {
          // The bell feed (T-26, PROMPT №704). Top-level, NOT under `profile/` --
          // deliberately named 'master-inbox', not 'master-notifications': that
          // name is already the T-26 preference screen at profile/notifications.
          path: 'notifications',
          name: 'master-inbox',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterInboxView.vue'),
        },
        {
          path: 'practices',
          name: 'master-practices',
          meta: { requires: 'verified-master' },
          component: () => import('@/views/master/MasterPracticesView.vue'),
        },
        {
          path: 'practices/new',
          name: 'master-practice-new',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/CreatePracticeView.vue'),
        },
        {
          path: 'practices/:id',
          name: 'master-practice-edit',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/EditPracticeView.vue'),
        },
        {
          // Standalone F4: the master's practice screen -- ONE view for both
          // zones (TZ 6.3 pattern, as SchoolPageView): the user zone
          // mounts it as 'practice-live' below. Here the server's ladder
          // answers 'host' and the screen starts the meeting inside VELO
          // (Meeting SDK); the zone picks the back target and hides the
          // student-only actions (Check-in).
          path: 'practice-live/:practiceId',
          name: 'master-practice-live',
          meta: { requires: 'verified-master', headerless: true, hideTabBar: true },
          component: () => import('@/views/user/PracticeLiveView.vue'),
        },
        {
          path: 'practices/:id/attendance',
          name: 'master-attendance',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/AttendanceView.vue'),
        },
        {
          path: 'practices/:id/detail',
          name: 'master-practice-detail',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterPracticeDetailView.vue'),
        },
        {
          path: 'practices/:id/roster',
          name: 'master-attendance-roster',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/AttendanceRosterView.vue'),
        },
        {
          path: 'analytics',
          name: 'master-analytics',
          component: () => import('@/views/master/AnalyticsView.vue'),
        },
        {
          path: 'analytics/practice/:id',
          name: 'master-practice-reviews',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/PracticeReviewsView.vue'),
        },
        {
          path: 'profile',
          name: 'master-profile',
          // HEADERLESS hub (PE-1): no VHeader teleports here — MobileLayout
          // pads by --velo-fog-headerless-top instead of the header fallback.
          meta: { headerless: true },
          component: () => import('@/views/master/MasterProfileView.vue'),
        },
        // Master profile sub-screens reached from the master profile hub; back-nav
        // uses router.back() so it returns here. Edit + timezone reuse the
        // role-agnostic user settings views; notifications has its own master view
        // (richer master-only design, operator B1=B 2026-06-13).
        {
          path: 'profile/edit',
          name: 'master-edit-profile',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/EditProfileView.vue'),
        },
        {
          path: 'profile/notifications',
          name: 'master-notifications',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterNotificationsView.vue'),
        },
        {
          path: 'profile/timezone',
          name: 'master-timezone',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/TimezoneSettingsView.vue'),
        },
        {
          path: 'support',
          name: 'master-support',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterSupportView.vue'),
        },
        {
          path: 'messages',
          name: 'master-messages',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterMessagesView.vue'),
        },
        {
          path: 'messages/:id',
          name: 'master-chat',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterChatView.vue'),
        },
        {
          path: 'promocodes',
          name: 'master-promocodes',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterPromocodesView.vue'),
        },
        {
          path: 'promocodes/new',
          name: 'master-promocode-new',
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterNewPromocodeView.vue'),
        },
        // FE-112 (tz-whitelabel §4): the finance screen is the payments
        // module's master surface -- cut from editions without it.
        ...PAYMENTS_MASTER_ROUTES,
        {
          path: 'students',
          name: 'master-students',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterStudentsView.vue'),
        },
        {
          path: 'students/:id',
          name: 'master-student-profile',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterStudentProfileView.vue'),
        },
        {
          path: 'groups',
          name: 'master-groups',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterGroupsView.vue'),
        },
        {
          path: 'groups/new',
          name: 'master-group-create',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterGroupCreateView.vue'),
        },
        {
          path: 'groups/:id',
          name: 'master-group-detail',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterGroupDetailView.vue'),
        },
        {
          // tz-curator.md §1.2: the master zone's schools TAB HUB
          // (i18n:tabs.schools) -- the
          // sectioned schools list the dock tab lands on, same contract as
          // user-schools: the tab bar stays visible with the fourth tab
          // active, so no hideTabBar meta here.
          path: 'schools',
          name: 'master-schools',
          meta: { option: 'schools', requires: 'verified-master' },
          component: () => import('@/views/master/MasterSchoolsView.vue'),
        },
        {
          path: 'schools/new',
          name: 'master-school-create',
          meta: { option: 'schools', requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterSchoolCreateView.vue'),
        },
        {
          path: 'schools/:id',
          name: 'master-school',
          meta: { option: 'schools', requires: 'verified-master', hideTabBar: true },
          // The SAME page component the user zone mounts (TZ 6.3) -- the
          // server's viewer.relation drives the action set; this route's
          // name prefix is all the view reads to pick its back target.
          component: () => import('@/views/user/SchoolPageView.vue'),
        },
        {
          // tz-curator.md §1.11 (owner 2026-09-22): the same participants
          // screen the user zone mounts; the zone only picks navigation
          // targets.
          path: 'schools/:id/members',
          name: 'master-school-members',
          meta: { option: 'schools', requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/user/SchoolMembersView.vue'),
        },
        {
          // tz-curator.md §6 MVP: the same analytics screen the user zone
          // mounts; the zone only picks the back target.
          path: 'schools/:id/analytics',
          name: 'master-school-analytics',
          meta: { option: 'schools', requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/user/SchoolAnalyticsView.vue'),
        },
        {
          // tz-curator.md §1.11.4 (owner 2026-09-22): same student profile
          // component as the user zone; the zone picks the back target.
          path: 'schools/:schoolId/students/:userId',
          name: 'master-school-student',
          meta: { option: 'schools', requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/user/SchoolStudentProfileView.vue'),
        },
        {
          path: 'summary',
          name: 'master-summary',
          meta: { requires: 'verified-master', hideTabBar: true },
          component: () => import('@/views/master/MasterSummaryView.vue'),
        },
        {
          path: '',
          redirect: { name: 'master-dashboard' },
        },
      ],
    },

    // Standalone master-zone screens (views/master, outside MasterShell): each
    // declares the master catalog itself -- no parent record does it for them.
    {
      // Batch-INVITE (№258): landing for the one-time master invite deeplink
      // (startapp=master_onboarding__<token>). Standalone like /master/apply;
      // applyGuard bounces verified masters to the dashboard, everyone else
      // (incl. the invited plain user) reaches the claim.
      path: '/master/invite/:token',
      name: 'master-invite',
      beforeEnter: masterApplyGuard,
      meta: { catalogs: ['master'] },
      component: () => import('@/views/master/MasterInviteClaimView.vue'),
    },
    {
      path: '/master/apply',
      name: 'master-apply',
      beforeEnter: masterApplyGuard,
      meta: { catalogs: ['master'] },
      component: () => import('@/views/master/MasterApplyView.vue'),
    },
    {
      // P4 (PROMPT №593): landing for a group's reusable invite deeplink
      // (startapp=group_invite__<token>). Standalone, like /master/invite/:token
      // -- but no beforeEnter guard: unlike applyGuard's master-only bounce
      // logic, ANY authenticated user (any role) may join a group, and
      // App.vue's own auth gate (isAuthenticated) already ensures RouterView
      // -- and therefore this route -- never renders for a logged-out visitor.
      path: '/groups/join/:token',
      name: 'group-join',
      meta: { catalogs: ['master'] },
      component: () => import('@/views/master/GroupJoinView.vue'),
    },
    {
      // FE-18 (GT P3): landing for a SCHOOL's reusable invite deeplink
      // (startapp=school__<token>). Standalone like group-join,
      // no beforeEnter guard: any authenticated user may open the preview,
      // and the SERVER decides (preview can_join/reason) whether joining is
      // offered, refused, or an upgrade. The token carries no kind -- the
      // master/student flavour is resolved by GET /schools/invites/{token}.
      path: '/schools/join/:token',
      name: 'school-join',
      meta: { option: 'schools', catalogs: ['master'] },
      component: () => import('@/views/master/SchoolJoinView.vue'),
    },
    {
      // BE-59/GT-27 (owner mockup 2026-10-02): the master-offer heading
      // (i18n:masterScreens.schoolMasterOffer.invited.title) -- the
      // consent screen of the curator's master-role
      // appointment. Reached from the school.master_offered notification
      // (open_master_offer, bell + Telegram); standalone like school-join, no guard: the
      // school page and the accept endpoint decide who sees what.
      path: '/schools/:id/master-offer',
      name: 'school-master-offer',
      meta: { option: 'schools', catalogs: ['master'] },
      component: () => import('@/views/master/SchoolMasterOfferView.vue'),
    },
    {
      path: '/master/pending',
      name: 'master-pending',
      beforeEnter: masterPendingGuard,
      meta: { catalogs: ['master'] },
      component: () => import('@/views/master/MasterPendingView.vue'),
    },
  ]
}
