<!--
  VELO Frontend -- UserProfileView (Phase F4.2; Profile redesign Screen A)

  User profile main screen. Matches Figma node 4715:3464 (70_Profile):
    - Header: avatar, name (no email -- email is a future, separately
      collected field, NOT the Telegram username, so it is not shown here)
    - Stats row: two cards -- attended practices
      (i18n:user.screens.userProfile.practicesStat) and attended hours
      (i18n:user.screens.userProfile.hoursStat),
      both from GET /api/v1/bookings/me/stats
    - Menu sections: account, settings, help, logout

  Stats source: /bookings/me/stats returns practices_attended + hours_attended,
  computed from attended bookings only, so the two numbers stay consistent.
  B52: the same response also carries has_unread_messages, a colour-only
  indicator (no count) for the messages row's
  (i18n:user.screens.userProfile.menu.messages) dot -- one request, no
  new endpoint, no per-thread poll on this screen.

  Menu navigation: items whose target screens (Edit profile, Notifications,
  Language/Timezone, Support, Share) are built in later steps of the profile
  redesign are wired as toast stubs for now; each becomes a real route when
  its screen lands. The bookings row (i18n:user.screens.userProfile.menu.bookings)
  already has a route and navigates.

  Vector icons (currentColor) from components/icons replace the previous
  emoji glyphs, matching the mockup.

  TD-FE-ROLE-SWITCH: master/admin see a back-to-native-mode row above logout
  (i18n:user.screens.userProfile.backToMaster /
  i18n:user.screens.userProfile.backToAdmin)
  that resets uiMode and navigates to their native dashboard.

  Route: /user/profile (name: 'user-profile')
-->

<template>
  <div class="profile">
    <!-- Header -->
    <VCard class="profile__header" padding="none">
      <div class="profile__avatar">
        <VAvatar :name="displayName" :url="user?.avatar_url ?? undefined" size="lg" />
      </div>
      <h1 class="profile__name">{{ displayName }}</h1>
    </VCard>

    <!-- Stats: practices + hours -->
    <div class="profile__stats">
      <VStatCard
        class="profile__stat"
        :value="practicesAttended"
        :label="t('user.screens.userProfile.practicesStat')"
      />
      <VStatCard
        class="profile__stat"
        :value="hoursLabel"
        :label="t('user.screens.userProfile.hoursStat')"
      />
    </div>

    <!-- Menu sections -->
    <div class="profile__menus">
      <!-- Account -->
      <div class="profile__menu-section">
        <div class="profile__menu-title">{{ t('user.screens.userProfile.section.account') }}</div>
        <div class="profile__menu-list">
          <VMenuRow :label="t('user.screens.userProfile.menu.editProfile')" @click="onEditProfile">
            <template #icon><IconPen :size="20" /></template>
          </VMenuRow>
          <VMenuRow
            :label="t('user.screens.userProfile.menu.bookings')"
            @click="router.push({ name: 'user-bookings' })"
          >
            <template #icon><IconBookings :size="20" /></template>
          </VMenuRow>
          <VMenuRow
            v-if="authStore.role === 'user' && authStore.masterApplication"
            :label="t('user.screens.userProfile.masterApplication')"
            @click="router.push({ name: applicationRoute })"
          >
            <template #icon><IconPen :size="20" /></template>
          </VMenuRow>
          <VMenuRow
            :label="t('user.screens.userProfile.menu.messages')"
            :dot="hasUnreadMessages"
            @click="onMessages"
          >
            <template #icon><IconMessages :size="20" /></template>
          </VMenuRow>
          <!-- FE-19 (GT P3): the schools I belong to. The master's student
               groups are a master-zone concept a plain user never meets.
               FE-151: the row follows the «schools» instance option. -->
          <VMenuRow
            v-if="schoolsEnabled"
            :label="t('user.screens.userProfile.menu.mySchools')"
            @click="router.push({ name: 'user-my-schools' })"
          >
            <template #icon><IconGroup :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Settings -->
      <div class="profile__menu-section">
        <div class="profile__menu-title">{{ t('user.screens.userProfile.section.settings') }}</div>
        <div class="profile__menu-list">
          <VMenuRow
            :label="t('user.screens.userProfile.menu.notifications')"
            @click="onNotifications"
          >
            <template #icon><IconBell :size="20" /></template>
          </VMenuRow>
          <VMenuRow
            :label="t('user.screens.userProfile.menu.timezone')"
            @click="onTimezoneSettings"
          >
            <template #icon><IconGlobe :size="20" /></template>
          </VMenuRow>
          <!-- BE-138: tokens for the user's AI (MCP) clients. tz-whitelabel
               §4: the row follows the «ai» edition module -- an edition
               without it has neither the route nor the entry point -- and
               the «mcp» instance option (FE-151). -->
          <VMenuRow
            v-if="aiConnectionsEnabled"
            :label="t('user.screens.userProfile.menu.aiConnections')"
            @click="onAiConnections"
          >
            <template #icon><IconBrain :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Help -->
      <div class="profile__menu-section">
        <div class="profile__menu-title">{{ t('user.screens.userProfile.section.help') }}</div>
        <div class="profile__menu-list">
          <VMenuRow :label="t('user.screens.userProfile.menu.support')" @click="onSupport">
            <template #icon><IconSupport :size="20" /></template>
          </VMenuRow>
          <VMenuRow :label="t('user.screens.userProfile.menu.share')" @click="onShare">
            <template #icon><IconShare :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Return to master/admin mode (TD-FE-ROLE-SWITCH) -->
      <div
        v-if="authStore.role === 'master' || authStore.role === 'admin'"
        class="profile__menu-section"
      >
        <div class="profile__menu-list">
          <VMenuRow
            variant="primary"
            :label="
              authStore.role === 'admin'
                ? t('user.screens.userProfile.backToAdmin')
                : t('user.screens.userProfile.backToMaster')
            "
            @click="returnToNativeMode"
          />
        </div>
      </div>

      <!-- Role switch (TEST-ONLY tester tool; renders nothing for normal users) -->
      <RoleSwitchSection />

      <!-- Logout -->
      <div class="profile__menu-section">
        <div class="profile__menu-list">
          <VMenuRow
            :label="t('user.screens.userProfile.menu.logout')"
            variant="danger"
            :show-arrow="false"
            @click="onLogout"
          >
            <template #icon><IconLogout :size="20" /></template>
          </VMenuRow>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { featureEnabled } from '@/platform/features'
import { isOptionEnabled } from '@/platform/instance'
import { useUiStore } from '@/stores/ui'
import { VAvatar, VStatCard, VCard, VMenuRow } from '@/components/ui'
import RoleSwitchSection from '@/components/shared/RoleSwitchSection.vue'
import {
  IconPen,
  IconBookings,
  IconMessages,
  IconBell,
  IconGlobe,
  IconSupport,
  IconShare,
  IconLogout,
  IconGroup,
  IconBrain,
} from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useQuery } from '@pinia/colada'
import { myStatsQuery } from '@/composables/queries/stats'

const router = useRouter()
const authStore = useAuthStore()
const applicationRoute = computed(() =>
  ['cancelled_by_user', 'suspended'].includes(authStore.masterApplication?.status ?? '')
    ? 'master-apply'
    : 'master-pending',
)
const uiStore = useUiStore()
const toast = useToast()

const user = computed(() => authStore.user)

const displayName = computed(() => {
  if (!user.value) return ''
  const parts = [user.value.first_name, user.value.last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : t('user.screens.userProfile.fallback.user')
})

// -- Stats (attended practices + hours) from /bookings/me/stats --
// The dashboard's cache entry (Colada): a visit renders the last known
// numbers at once instead of 0 -> N, and refreshes them every time (the
// unread-messages dot must be current). A failed fetch keeps what is shown
// (NEW-7: the profile never breaks on it).
const statsQuery = useQuery(() => myStatsQuery(0))
// Kept alive as a tab root (TabRouterView): a return refetches quietly (the
// shown data stays). refetch, not refresh: the entry is shared with the
// dashboard and the idle prefetch, and whoever ensured it last set its
// staleTime (5 min) -- a refresh would then skip the unread dot. The first
// activation is the mount itself.
let activations = 0
onActivated(() => {
  if (activations++ > 0) void statsQuery.refetch()
})
const practicesAttended = computed(() => statsQuery.data.value?.practices_attended ?? 0)
const hoursAttended = computed(() => statsQuery.data.value?.hours_attended ?? 0)
// B52: colour indicator on the t('user.screens.userProfile.messages') row, same request, no new call.
const hasUnreadMessages = computed(() => statsQuery.data.value?.has_unread_messages ?? false)

/**
 * Hours label: integers show without a trailing ".0" (e.g. "12"), while
 * fractional values use a comma to match the Russian mockup ("9,5").
 */
const hoursLabel = computed(() => {
  const h = hoursAttended.value
  return Number.isInteger(h) ? String(h) : String(h).replace('.', ',')
})

// -- Menu actions --

function onEditProfile(): void {
  void router.push({ name: 'user-edit-profile' })
}

function onMessages(): void {
  void router.push({ name: 'user-messages' })
}

function onNotifications(): void {
  void router.push({ name: 'user-notifications' })
}

function onTimezoneSettings(): void {
  void router.push({ name: 'user-timezone' })
}

function onAiConnections(): void {
  void router.push({ name: 'user-ai-connections' })
}

// tz-whitelabel §4: the «ai» edition module owns the AI connections row;
// FE-151: the «mcp» instance option turns it on for the instance.
const aiConnectionsEnabled = featureEnabled('ai') && isOptionEnabled('mcp')
// FE-151: the «schools» instance option owns the my-schools row.
const schoolsEnabled = isOptionEnabled('schools')

function onSupport(): void {
  // User support screen (batch I): topic picker + message + honest stub submit
  // (no support backend yet — see SupportView / VELO-Backend-Tasks.md).
  void router.push({ name: 'user-support' })
}

function onShare(): void {
  toast.info(t('user.screens.userProfile.shareUnavailable'))
}

async function onLogout(): Promise<void> {
  await authStore.logout()
  void router.replace({ path: '/' })
}

/** Return to native role dashboard and reset uiMode (TD-FE-ROLE-SWITCH). */
function returnToNativeMode(): void {
  uiStore.setUiMode('default')
  if (authStore.role === 'admin') {
    void router.push({ name: 'admin-dashboard' })
  } else {
    void router.push({ name: 'master-dashboard' })
  }
}
</script>

<style scoped>
/* Rail-based insets: content respects MobileLayout's rail + fog; each surface is
   a white card (Figma 1 Profile.svg) instead of the old translucent glass-blue. */
.profile {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* [FE-3] The headerless route meta owns the top clearance now (48px token,
     see router/index.ts) -- the old hand-rolled compensation
     (margin-top: calc(50px - 104px), cancelling the phantom HEADER_FALLBACK
     band) is retired along with its 2px drift from the dashboard tab. */
}

/* Header: white profile card */
.profile__header {
  text-align: center;
  padding: var(--space-5) var(--space-4) var(--space-5);
}

.profile__avatar {
  /* Centre the avatar: VAvatar is a block flex container of fixed width, so
   * the parent's text-align cannot centre it. flex-center guarantees the
   * centre (operator 2026-06-04). */
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-3);
}

.profile__name {
  font-family: var(--font-body);
  /* Was --text-2xl (50px) — far too large for a name. Down to --text-lg (20px),
     matching the mockup. */
  font-size: var(--velo-fs-20);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

/* Stats: two white cards (shared VStatCard); each fills half the row. */
.profile__stats {
  display: flex;
  gap: var(--space-4);
}

.profile__stat {
  flex: 1;
}

/* Menu sections */
.profile__menus {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.profile__menu-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.profile__menu-title {
  font-family: var(--font-body);
  /* Figma: section labels are Marmelad 18, primary colour (not uppercase muted). */
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

/* Each menu item is its own white rounded plate (Figma: separate rows, rx15). */
.profile__menu-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* (menu rows now provided by <VMenuRow>) */
</style>
