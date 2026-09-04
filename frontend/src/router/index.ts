// =============================================================================
// VELO Frontend -- Router (Phase F2.2, updated F9, TD-FE-ROLE-SWITCH, WARNING-3)
// =============================================================================
//
// Diary redesign: /user/diary now points at DiaryFeedView (the unified feed +
// thread). The old DiaryView and its tab sub-components are removed.
// =============================================================================

import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useMasterStore } from '@/stores/master'
import {
  roleRedirect,
  roleGuard,
  masterStatusGuard,
  masterPendingGuard,
  masterNoProfileGuard,
  roleFreshnessGuard,
} from '@/router/guards'
import { waitUntilReady } from '@/composables/useAuth'
import type { ReadyResult } from '@/composables/useAuth'

// -- Shell layouts --
import UserShell from '@/views/shells/UserShell.vue'
import MasterShell from '@/views/shells/MasterShell.vue'
import AdminShell from '@/views/shells/AdminShell.vue'

// =============================================================================
// applyGuard: verified masters don't need to visit the apply form.
// =============================================================================
const applyGuard = async () => {
  const { timedOut }: ReadyResult = await waitUntilReady()
  const auth = useAuthStore()

  if (timedOut && auth.role === null) {
    return { path: '/auth-error' }
  }

  if (auth.role !== 'master') return true

  const masterStore = useMasterStore()
  await masterStore.fetchMyProfile()
  if (masterStore.profile?.status === 'verified') {
    return { path: '/master/dashboard' }
  }
  return true
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'root',
      beforeEnter: roleRedirect,
      component: { template: '' },
    },

    // =========================================================================
    // USER routes
    // =========================================================================
    {
      path: '/user',
      component: UserShell,
      children: [
        {
          path: 'dashboard',
          name: 'user-dashboard',
          // [FE-3] Headerless top clearance, follow-up: the dashboard's only
          // floating header was the GREETING, removed 2026-06-04 -- since then
          // nothing teleports into the island, but MobileLayout cannot tell
          // "not yet" from "never" and reserved HEADER_FALLBACK+gap = 104px of
          // phantom band above «Ближайшие практики» forever. Declaring the
          // route headerless pads by the token exactly (34px). If this screen
          // ever gains a floating header again, drop this meta.
          meta: { headerless: true },
          component: () => import('@/views/user/UserDashboardView.vue'),
        },
        {
          path: 'calendar',
          name: 'user-calendar',
          component: () => import('@/views/user/CalendarView.vue'),
        },
        {
          path: 'diary',
          name: 'user-diary',
          component: () => import('@/views/user/DiaryFeedView.vue'),
        },
        {
          path: 'diary/entry/:id',
          name: 'user-diary-entry',
          component: () => import('@/views/user/EntryView.vue'),
        },
        {
          path: 'diary/:type(checkin|feedback)/:id',
          name: 'user-diary-detail',
          component: () => import('@/views/user/DetailView.vue'),
        },
        {
          path: 'profile',
          name: 'user-profile',
          // [FE-3] Headerless hub, same contract as the dashboard ([FE-3]
          // follow-up): no VHeader ever teleports here, and the view used to
          // cancel the phantom 104px clearance with a hand-rolled
          // margin-top: calc(50px - 104px) hack. Route meta retires the hack:
          // top = --velo-fog-headerless-top (34px), identical to the dashboard
          // tab -- tab-to-tab tops no longer shift. If this screen ever gains
          // a floating header, drop this meta.
          meta: { headerless: true },
          component: () => import('@/views/user/UserProfileView.vue'),
        },
        {
          path: 'profile/language-timezone',
          name: 'user-language-timezone',
          component: () => import('@/views/user/LanguageTimezoneView.vue'),
        },
        {
          path: 'profile/edit',
          name: 'user-edit-profile',
          component: () => import('@/views/user/EditProfileView.vue'),
        },
        {
          path: 'profile/notifications',
          name: 'user-notifications',
          component: () => import('@/views/user/NotificationsView.vue'),
        },
        {
          path: 'profile/messages',
          name: 'user-messages',
          component: () => import('@/views/user/UserMessagesView.vue'),
        },
        {
          path: 'profile/messages/:id',
          name: 'user-chat',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/UserChatView.vue'),
        },
        {
          path: 'support',
          name: 'user-support',
          component: () => import('@/views/user/SupportView.vue'),
        },
        {
          path: 'practices/:id',
          name: 'practice-detail',
          component: () => import('@/views/user/PracticeDetailView.vue'),
        },
        {
          path: 'masters/:id',
          name: 'user-master-public',
          component: () => import('@/views/user/MasterPublicView.vue'),
        },
        {
          path: 'booking-confirmed/:practiceId',
          name: 'user-booking-confirmed',
          component: () => import('@/views/user/BookingConfirmedView.vue'),
          // Post-booking screen has no own tab; light up Calendar in the bar.
          // [FE-3] No VHeader ever mounts here — tell MobileLayout via meta so it
          // must not reserve header clearance (top = --velo-fog-headerless-top;
          // requirement statement: MobileLayout.vue, [FE-3] block at mainStyle).
          meta: { activeTab: '/user/calendar', headerless: true },
        },
        {
          path: 'bookings',
          name: 'user-bookings',
          component: () => import('@/views/user/MyBookingsView.vue'),
        },
        {
          // FE-19 (GT P3): "Мои группы" in the user zone means SCHOOLS
          // (curator groups) -- the master's student groups are a master-zone
          // concept a plain user never sees. Entry row: UserProfileView,
          // «Аккаунт» section.
          path: 'groups',
          name: 'user-curator-groups',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/UserCuratorGroupsView.vue'),
        },
        {
          path: 'groups/:id',
          name: 'user-curator-group',
          meta: { hideTabBar: true },
          // ONE page for both zones (TZ 6.3) -- the master zone mounts this
          // same view below; the action set keys off viewer.relation and the
          // zone only picks the back target.
          component: () => import('@/views/user/CuratorGroupPageView.vue'),
        },
        {
          path: 'checkin/:practiceId',
          name: 'user-checkin',
          component: () => import('@/views/user/CheckinView.vue'),
        },
        {
          path: 'feedback/:practiceId',
          name: 'user-feedback',
          component: () => import('@/views/user/FeedbackView.vue'),
        },
        {
          path: 'reflection/:practiceId',
          name: 'user-reflection',
          component: () => import('@/views/user/ReflectionView.vue'),
        },
        {
          path: 'practice-live/:practiceId',
          name: 'practice-live',
          component: () => import('@/views/user/PracticeLiveView.vue'),
          // [FE-48] Own navigation: the screen draws the shared VBackButton
          // pill itself (same DS element the diary uses), so the floating
          // header's clearance must NOT be reserved -- without this flag
          // MobileLayout left a dead empty block between the Telegram header
          // and the screen's own back button.
          meta: { headerless: true },
        },
        {
          path: 'ai-summary',
          name: 'user-ai-summary',
          component: () => import('@/views/user/AiSummaryView.vue'),
        },
        {
          path: 'topup',
          name: 'user-topup',
          // [FE-3] No floating header (own inline title) -- headerless contract,
          // was the phantom 104px band.
          meta: { headerless: true },
          component: () => import('@/views/user/TopupView.vue'),
        },
        {
          path: 'topup/success',
          name: 'user-topup-success',
          meta: { headerless: true },
          component: () => import('@/views/user/TopupSuccessView.vue'),
        },
        {
          path: 'topup/cancel',
          name: 'user-topup-cancel',
          meta: { headerless: true },
          component: () => import('@/views/user/TopupCancelView.vue'),
        },
        {
          path: '',
          redirect: { name: 'user-dashboard' },
        },
      ],
    },

    // =========================================================================
    // MASTER routes
    // =========================================================================
    {
      path: '/master',
      component: MasterShell,
      beforeEnter: roleGuard('master'),
      children: [
        {
          path: 'dashboard',
          name: 'master-dashboard',
          // №257 honest entry: a master with NO application is led to the
          // apply wizard; pending/rejected keep the dashboard as before.
          beforeEnter: masterNoProfileGuard,
          // HEADERLESS hub (DB-1b): no VHeader teleports here — MobileLayout
          // pads by --velo-fog-headerless-top instead of the header fallback.
          meta: { headerless: true },
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
          beforeEnter: masterStatusGuard,
          component: () => import('@/views/master/MasterPracticesView.vue'),
        },
        {
          path: 'practices/new',
          name: 'master-practice-new',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/CreatePracticeView.vue'),
        },
        {
          path: 'practices/:id',
          name: 'master-practice-edit',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/EditPracticeView.vue'),
        },
        {
          path: 'practices/:id/attendance',
          name: 'master-attendance',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/AttendanceView.vue'),
        },
        {
          path: 'practices/:id/detail',
          name: 'master-practice-detail',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterPracticeDetailView.vue'),
        },
        {
          path: 'practices/:id/roster',
          name: 'master-attendance-roster',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
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
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
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
        // uses router.back() so it returns here. Edit + language-timezone reuse the
        // role-agnostic user settings views; notifications has its own master view
        // (richer master-only design, operator В1=Б 2026-06-13).
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
          path: 'profile/language-timezone',
          name: 'master-language-timezone',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/LanguageTimezoneView.vue'),
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
        {
          path: 'finance',
          name: 'master-finance',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterFinanceView.vue'),
        },
        {
          path: 'students',
          name: 'master-students',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterStudentsView.vue'),
        },
        {
          path: 'students/:id',
          name: 'master-student-profile',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterStudentProfileView.vue'),
        },
        {
          path: 'groups',
          name: 'master-groups',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterGroupsView.vue'),
        },
        {
          path: 'groups/new',
          name: 'master-group-create',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterGroupCreateView.vue'),
        },
        {
          path: 'groups/:id',
          name: 'master-group-detail',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterGroupDetailView.vue'),
        },
        {
          path: 'summary',
          name: 'master-summary',
          beforeEnter: masterStatusGuard,
          meta: { hideTabBar: true },
          component: () => import('@/views/master/MasterSummaryView.vue'),
        },
        {
          path: '',
          redirect: { name: 'master-dashboard' },
        },
      ],
    },

    {
      // Batch-INVITE (№258): landing for the one-time master invite deeplink
      // (startapp=master_onboarding__<token>). Standalone like /master/apply;
      // applyGuard bounces verified masters to the dashboard, everyone else
      // (incl. the invited plain user) reaches the claim.
      path: '/master/invite/:token',
      name: 'master-invite',
      beforeEnter: applyGuard,
      component: () => import('@/views/master/MasterInviteClaimView.vue'),
    },
    {
      path: '/master/apply',
      name: 'master-apply',
      beforeEnter: applyGuard,
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
      component: () => import('@/views/master/GroupJoinView.vue'),
    },
    {
      // FE-18 (GT P3): landing for a SCHOOL's reusable invite deeplink
      // (startapp=curator_group_invite__<token>). Standalone like group-join,
      // no beforeEnter guard: any authenticated user may open the preview,
      // and the SERVER decides (preview can_join/reason) whether joining is
      // offered, refused, or an upgrade. The token carries no kind -- the
      // master/student flavour is resolved by GET /curator-groups/invites/{token}.
      path: '/curator-groups/join/:token',
      name: 'curator-group-join',
      component: () => import('@/views/master/CuratorGroupJoinView.vue'),
    },
    {
      path: '/master/pending',
      name: 'master-pending',
      beforeEnter: masterPendingGuard,
      component: () => import('@/views/master/MasterPendingView.vue'),
    },

    // =========================================================================
    // ADMIN routes
    // =========================================================================
    {
      path: '/admin',
      component: AdminShell,
      beforeEnter: roleGuard('admin'),
      children: [
        {
          path: 'dashboard',
          name: 'admin-dashboard',
          component: () => import('@/views/admin/AdminDashboardView.vue'),
        },
        {
          path: 'masters',
          name: 'admin-masters',
          component: () => import('@/views/admin/AdminMastersView.vue'),
        },
        {
          // All-users list + explicit make-master (PROMPT №292).
          path: 'users',
          name: 'admin-users',
          component: () => import('@/views/admin/AdminUsersView.vue'),
        },
        {
          // Batch-INVITE (№258): one-time master invite link issue screen.
          // Declared BEFORE masters/:id so the literal segment wins.
          path: 'masters/invite',
          name: 'admin-master-invite',
          component: () => import('@/views/admin/AdminMasterInviteView.vue'),
        },
        {
          path: 'masters/:id',
          name: 'admin-master-review',
          component: () => import('@/views/admin/AdminMasterReviewView.vue'),
        },
        {
          // M3: master methods change-request moderation queue.
          path: 'method-requests',
          name: 'admin-method-requests',
          component: () => import('@/views/admin/AdminMethodRequestsView.vue'),
        },
        {
          // P2: read-only practice directions/styles catalog. Editing lands with
          // the catalog backend (A4/Zod); for now it's a view of the taxonomy.
          path: 'catalog',
          name: 'admin-catalog',
          component: () => import('@/views/admin/AdminCatalogView.vue'),
        },
        {
          path: 'reports',
          name: 'admin-reports',
          component: () => import('@/views/admin/AdminReportsView.vue'),
        },
        {
          path: 'reports/:id',
          name: 'admin-report-detail',
          component: () => import('@/views/admin/AdminReportDetailView.vue'),
        },
        {
          path: 'profile',
          name: 'admin-profile',
          component: () => import('@/views/admin/AdminProfileView.vue'),
        },
        {
          path: 'metrics/check-in',
          name: 'admin-checkin-rate',
          component: () => import('@/views/admin/AdminCheckinRateView.vue'),
        },
        {
          path: 'metrics/feedback',
          name: 'admin-feedback-rate',
          component: () => import('@/views/admin/AdminFeedbackRateView.vue'),
        },
        {
          path: 'metrics/return',
          name: 'admin-return-rate',
          component: () => import('@/views/admin/AdminReturnRateView.vue'),
        },
        {
          path: 'revenue',
          name: 'admin-revenue',
          component: () => import('@/views/admin/AdminRevenueView.vue'),
        },
        {
          path: 'participants',
          name: 'admin-participants',
          component: () => import('@/views/admin/AdminParticipantsView.vue'),
        },
        {
          path: 'practices',
          name: 'admin-practices',
          component: () => import('@/views/admin/AdminPracticesView.vue'),
        },
        {
          path: 'practices/:id',
          name: 'admin-practice-detail',
          component: () => import('@/views/admin/AdminPracticeDetailView.vue'),
        },
        {
          path: 'withdrawals',
          name: 'admin-withdrawals',
          component: () => import('@/views/admin/AdminWithdrawalsView.vue'),
        },
        {
          path: 'withdrawals/:id',
          name: 'admin-withdrawal-detail',
          component: () => import('@/views/admin/AdminWithdrawalDetailView.vue'),
        },
        {
          path: 'promos',
          name: 'admin-promos',
          component: () => import('@/views/admin/AdminPromosView.vue'),
        },
        {
          // B34 (PROMPT №713): support queue, reached from the dashboard --
          // same pattern as reports (no fourth tab, see AdminSupportView's
          // own header for why).
          path: 'support',
          name: 'admin-support',
          component: () => import('@/views/admin/AdminSupportView.vue'),
        },
        {
          path: 'support/:id',
          name: 'admin-support-detail',
          component: () => import('@/views/admin/AdminSupportDetailView.vue'),
        },
        {
          path: '',
          redirect: { name: 'admin-dashboard' },
        },
      ],
    },

    // =========================================================================
    // PARKED master-web auth routes (Phase A) — DORMANT + UNLINKED.
    // Registered for the future web-auth backend (Zod E17) only. App.vue's stage
    // machine + role redirects NEVER route here and nothing links in, so they are
    // unreachable in the Telegram flow (App.vue renders StandaloneStubView for a
    // browser session, so RouterView — and these views — never mount until E17).
    // No guards, no shell; the views render transparent over the app background.
    // =========================================================================
    {
      path: '/auth/landing',
      name: 'auth-landing',
      component: () => import('@/views/auth/LandingView.vue'),
    },
    {
      path: '/auth/login',
      name: 'auth-login',
      component: () => import('@/views/auth/LoginView.vue'),
    },
    {
      path: '/auth/recover',
      name: 'auth-recover',
      component: () => import('@/views/auth/RecoverPasswordRequestView.vue'),
    },
    {
      path: '/auth/recover/reset',
      name: 'auth-recover-reset',
      component: () => import('@/views/auth/RecoverPasswordSetView.vue'),
    },

    {
      path: '/auth-error',
      name: 'auth-error',
      component: () => import('@/views/auth/LoadingErrorView.vue'),
    },

    {
      path: '/404',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/404',
    },
  ],
})

// =============================================================================
// Global guard (P-1): redirect master/admin away from /user/dashboard only.
// =============================================================================
let authInitialized = false

router.beforeEach(async (to) => {
  if (!authInitialized) {
    const { timedOut }: ReadyResult = await waitUntilReady()
    authInitialized = true
    if (timedOut) {
      console.warn('[router] auth initialization timed out on first navigation')
    }
  }

  // T21-4/T21-5 (PROMPT №546): keeps role/master-application state fresh
  // across in-app navigation (debounced inside), and catches an unseen
  // rejection verdict on ANY route -- not just a fresh app boot landing on
  // '/', which is all roleRedirect's own rejection branch ever covered.
  // See guards.ts for the full reasoning; kept as a separate exported guard
  // (like every other guard here) so it's directly testable.
  const freshnessResult = await roleFreshnessGuard(to)
  if (freshnessResult !== true) return freshnessResult

  const auth = useAuthStore()

  if (to.name !== 'user-dashboard' && to.path !== '/user' && to.path !== '/user/') {
    return true
  }

  if (auth.role === 'master' || auth.role === 'admin') {
    const uiStore = useUiStore()
    if (uiStore.uiMode === 'user') return true

    return auth.role === 'admin' ? { path: '/admin/dashboard' } : { path: '/master/dashboard' }
  }

  return true
})

export default router
