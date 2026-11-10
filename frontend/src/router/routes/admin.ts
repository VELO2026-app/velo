// =============================================================================
// VELO Frontend -- admin zone routes (/admin, AdminShell)
// =============================================================================
//
// The shell (with the admin store and API it pulls in) and every screen are
// lazy (FE-157); the zone catalog loads before the first screen resolves
// (router/catalogs.ts). The module group is handed back by router/index.ts
// through its build-time feature gate (routes/user.ts explains why the gate
// lives there).
// =============================================================================

import type { RouteRecordRaw } from 'vue-router'
import { roleGuard } from '@/router/guards'

export const PAYMENTS_ADMIN_ROUTES: RouteRecordRaw[] = [
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
]

/** The module groups of the admin zone that router/index.ts lets in. */
export interface AdminModuleRoutes {
  payments: readonly RouteRecordRaw[]
}

/** The /admin zone: AdminShell and its screens. */
export function adminRoutes(modules: AdminModuleRoutes): RouteRecordRaw[] {
  return [
    {
      path: '/admin',
      component: () => import('@/views/shells/AdminShell.vue'),
      beforeEnter: roleGuard('admin'),
      meta: { catalogs: ['admin'] },
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
          // FE-23 (GT P4): read-only list of ALL schools incl. frozen -- the
          // only place an inactive school is visible. Entered from
          // AdminMastersView; a tap opens the curator's review page (the
          // existing revoke lever is the one moderation action for schools).
          path: 'schools',
          name: 'admin-schools',
          component: () => import('@/views/admin/AdminSchoolsView.vue'),
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
        // FE-112 (tz-whitelabel §4): the payout queue is the payments
        // module's admin surface -- cut from editions without it.
        ...modules.payments,
        {
          path: 'promos',
          name: 'admin-promos',
          component: () => import('@/views/admin/AdminPromosView.vue'),
        },
        {
          // FE-107 / BE-162 delivery 3: support statistics over a month of
          // appeals. Declared BEFORE support/:id so the literal segment wins.
          path: 'support/stats',
          name: 'admin-support-stats',
          component: () => import('@/views/admin/AdminSupportStatsView.vue'),
        },
        {
          // A support ticket's card (FE-100: the list is the tickets tab
          // (i18n:adminScreens.adminReports.tabTickets) of the moderation
          // screen (i18n:adminScreens.adminReports.moderationTab),
          // admin-reports; the deep link of the BE-172
          // signal lands here directly).
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
  ]
}
