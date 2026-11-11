// =============================================================================
// VELO Frontend -- user zone routes (/user, UserShell)
// =============================================================================
//
// Module groups (tz-whitelabel §4) are declared here and handed back by
// router/index.ts through its build-time feature gates -- the one file the
// gate literals may appear in (scripts/brand-grep.mjs). A group its gate
// folds away is never referenced, so Rollup drops it with its screens'
// dynamic imports.
//
// Instance options (FE-151) are NOT gates: their records are always
// registered and carry meta.option; with the option off router/guards.ts
// optionGuard sends a navigation into them to the 404 screen.
// =============================================================================

import type { RouteRecordRaw } from 'vue-router'

// The user shell is in the main bundle: the user zone is everyone's first
// screen. The master and admin shells are lazy (routes/master.ts,
// routes/admin.ts).
import UserShell from '@/views/shells/UserShell.vue'

/** The «ai» module's user screens: MCP tokens (BE-138) and the AI summary. */
export const AI_USER_ROUTES: RouteRecordRaw[] = [
  {
    // BE-138: personal tokens for the user's MCP clients.
    path: 'profile/ai-connections',
    name: 'user-ai-connections',
    meta: { option: 'mcp' },
    component: () => import('@/views/user/AiConnectionsView.vue'),
  },
  {
    path: 'ai-summary',
    name: 'user-ai-summary',
    component: () => import('@/views/user/AiSummaryView.vue'),
  },
]

/** The «payments» option's user screens: the top-up and its two returns. */
export const PAYMENTS_USER_ROUTES: RouteRecordRaw[] = [
  {
    path: 'topup',
    name: 'user-topup',
    // [FE-3] No floating header (own inline title) -- headerless contract,
    // was the phantom 104px band.
    meta: { option: 'payments', headerless: true },
    component: () => import('@/views/user/TopupView.vue'),
  },
  {
    path: 'topup/success',
    name: 'user-topup-success',
    meta: { option: 'payments', headerless: true },
    component: () => import('@/views/user/TopupSuccessView.vue'),
  },
  {
    path: 'topup/cancel',
    name: 'user-topup-cancel',
    meta: { option: 'payments', headerless: true },
    component: () => import('@/views/user/TopupCancelView.vue'),
  },
]

/** The module groups of the user zone that router/index.ts lets in. */
export interface UserModuleRoutes {
  ai: readonly RouteRecordRaw[]
}

/** The /user zone: UserShell and its screens, with the enabled modules' groups. */
export function userRoutes(modules: UserModuleRoutes): RouteRecordRaw[] {
  return [
    {
      path: '/user',
      component: UserShell,
      children: [
        {
          path: 'dashboard',
          name: 'user-dashboard',
          // [FE-3] Headerless top clearance RETIRED (owner, 2026-09-08): the
          // screen has a floating header again -- VHeader
          // (i18n:user.screens.userDashboard.headerTitle) with the
          // notification bell in its action slot teleports into the island,
          // so the route must NOT declare headerless (per the [FE-3] contract
          // in MobileLayout's mainStyle) or the feed would underlap the
          // header. The fog (user-dashboard sits in UserShell's FOG_ROUTES)
          // dissolves scrolling content under the island.
          component: () => import('@/views/user/UserDashboardView.vue'),
        },
        {
          path: 'calendar',
          name: 'user-calendar',
          component: () => import('@/views/user/CalendarView.vue'),
        },
        {
          // The MASTER's practice calendar (owner 2026-09-30): the
          // upcoming-practices row (i18n:user.screens.masterPublic.sections.upcoming)
          // on the master's public profile lands here. Stacked
          // (not the tab hub) so the floating island's back control is honest.
          path: 'calendar/master/:masterId',
          name: 'user-calendar-master',
          component: () => import('@/views/user/CalendarView.vue'),
        },
        {
          // Owner 2026-10-01: the upcoming tab
          // (i18n:user.screens.schoolPage.tabs.upcoming) on the school page opens
          // the calendar scoped to that school. Stacked (not the tab hub) so
          // the floating island's back control is honest; mirrors
          // user-calendar-master above.
          path: 'calendar/school/:schoolId',
          name: 'user-calendar-school',
          meta: { option: 'schools' },
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
          // FE-70: hand-entered activity that happened outside velo. A diary
          // route by shell contract (no tab bar, fill layout) but NOT a feed
          // citizen -- it owns its header/scroll/footer like the other diary
          // screens. Static segment sits above the dynamic :type sibling in
          // matching rank, so no declaration-order hazard.
          path: 'diary/activity/new',
          name: 'user-diary-activity-new',
          component: () => import('@/views/user/ExternalActivityCreateView.vue'),
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
          path: 'profile/timezone',
          name: 'user-timezone',
          component: () => import('@/views/user/TimezoneSettingsView.vue'),
        },
        // tz-whitelabel §4: the «ai» module's screens, when the edition has it.
        ...modules.ai,
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
          meta: {
            preload: (to) =>
              import('@/stores/practices').then(({ prefetchPractice }) =>
                prefetchPractice(String(to.params.id)),
              ),
          },
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
          // FE-11: the bell feed (user-zone mirror of the master's T-26
          // inbox). Top-level, NOT under `profile/` -- deliberately named
          // 'user-inbox', not 'user-notifications': that name is already the
          // preference screen at profile/notifications (NotificationsView).
          path: 'notifications',
          name: 'user-inbox',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/UserInboxView.vue'),
        },
        {
          // FE-19 (GT P3): the user zone's my-schools screen
          // (i18n:user.screens.userMySchools.title) -- the schools I
          // belong to. The master's student groups are a master-zone
          // concept a plain user never sees. Entry row: UserProfileView,
          // account section (i18n:user.screens.userProfile.section.account).
          path: 'my-schools',
          name: 'user-my-schools',
          meta: { option: 'schools', hideTabBar: true },
          component: () => import('@/views/user/UserMySchoolsView.vue'),
        },
        {
          // tz-curator.md §1.2-1.4: the schools TAB HUB (i18n:tabs.schools,
          // curator flow) --
          // the tab bar's own screen: empty state with the create button
          // (i18n:user.screens.schools.create.title) or the
          // flat schools list. Reached from the dock tab and nowhere else;
          // tab visibility itself is the schoolsHub store's decision.
          path: 'schools',
          name: 'user-schools',
          meta: { option: 'schools' },
          component: () => import('@/views/user/SchoolsView.vue'),
        },
        {
          path: 'schools/:id',
          name: 'user-school',
          meta: { option: 'schools', hideTabBar: true },
          // ONE page for both zones (TZ 6.3) -- the master zone mounts this
          // same view below; the action set keys off viewer.relation and the
          // zone only picks the back target.
          component: () => import('@/views/user/SchoolPageView.vue'),
        },
        {
          // FE-93 (owner 2026-10-03): the curator-management screens
          // (participants / analytics / student profile) exist ONLY in the
          // master zone -- in user mode a curator reads the school page as
          // an ordinary member. The user zone keeps the school list and
          // this page for the school's students.
          path: 'checkin/:practiceId',
          name: 'user-checkin',
          component: () => import('@/views/user/CheckinView.vue'),
        },
        {
          // Links (3 October): the spot-freed screen
          // (i18n:user.screens.waitlistConfirm.leadLine) -- the
          // waitlist.spot_available
          // notification (bell + Telegram confirm_waitlist__<id>) lands here.
          path: 'waitlist/:id',
          name: 'waitlist-confirm',
          meta: { hideTabBar: true },
          component: () => import('@/views/user/WaitlistConfirmView.vue'),
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
        // FE-151: the «payments» option's top-up screens (meta.option).
        ...PAYMENTS_USER_ROUTES,
        {
          path: '',
          redirect: { name: 'user-dashboard' },
        },
      ],
    },
  ]
}
