<!--
  VELO Frontend -- UserProfileView (Phase F4.2; Profile redesign Screen A)

  User profile main screen. Matches Figma node 4715:3464 (70_Profile):
    - Header: avatar, name (no email -- email is a future, separately
      collected field, NOT the Telegram username, so it is not shown here)
    - Stats row: two cards -- "Практик" (attended count) and "Часов"
      (attended hours), both from GET /api/v1/bookings/me/stats
    - Menu sections: account, settings, help, logout

  Stats source: /bookings/me/stats returns practices_attended + hours_attended,
  computed from attended bookings only, so the two numbers stay consistent.
  B52: the same response also carries has_unread_messages, a colour-only
  indicator (no count) for the "Сообщения" row's dot -- one request, no
  new endpoint, no per-thread poll on this screen.

  Menu navigation: items whose target screens (Edit profile, Notifications,
  Language/Timezone, Support, Share) are built in later steps of the profile
  redesign are wired as toast stubs for now; each becomes a real route when
  its screen lands. "Мои бронирования" already has a route and navigates.

  Vector icons (currentColor) from components/icons replace the previous
  emoji glyphs, matching the mockup.

  TD-FE-ROLE-SWITCH: master/admin see a "Вернуться в режим ..." row above
  logout that resets uiMode and navigates to their native dashboard.

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
      <VStatCard class="profile__stat" :value="practicesAttended" label="Практик" />
      <VStatCard class="profile__stat" :value="hoursLabel" label="Часов" />
    </div>

    <!-- Menu sections -->
    <div class="profile__menus">
      <!-- Account -->
      <div class="profile__menu-section">
        <div class="profile__menu-title">Аккаунт</div>
        <div class="profile__menu-list">
          <VMenuRow label="Редактировать профиль" @click="onEditProfile">
            <template #icon><IconEdit :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Мои бронирования" @click="router.push({ name: 'user-bookings' })">
            <template #icon><IconBookings :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Сообщения" :dot="hasUnreadMessages" @click="onMessages">
            <template #icon><IconMessages :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Settings -->
      <div class="profile__menu-section">
        <div class="profile__menu-title">Настройки</div>
        <div class="profile__menu-list">
          <VMenuRow label="Уведомления" @click="onNotifications">
            <template #icon><IconBell :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Язык / Часовой пояс" @click="onLanguageTimezone">
            <template #icon><IconGlobe :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Help -->
      <div class="profile__menu-section">
        <div class="profile__menu-title">Помощь</div>
        <div class="profile__menu-list">
          <VMenuRow label="Поддержка" @click="onSupport">
            <template #icon><IconSupport :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Поделиться" @click="onShare">
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
                ? 'Вернуться в режим администратора'
                : 'Вернуться в режим мастера'
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
          <VMenuRow label="Выйти" variant="danger" :show-arrow="false" @click="onLogout">
            <template #icon><IconLogout :size="20" /></template>
          </VMenuRow>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { VAvatar, VStatCard, VCard, VMenuRow } from '@/components/ui'
import RoleSwitchSection from '@/components/shared/RoleSwitchSection.vue'
import {
  IconEdit,
  IconBookings,
  IconMessages,
  IconBell,
  IconGlobe,
  IconSupport,
  IconShare,
  IconLogout,
} from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { getMyStats } from '@/api/bookings'

const router = useRouter()
const authStore = useAuthStore()
const uiStore = useUiStore()
const toast = useToast()

const user = computed(() => authStore.user)

const displayName = computed(() => {
  if (!user.value) return ''
  const parts = [user.value.first_name, user.value.last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Пользователь'
})

// -- Stats (attended practices + hours) from /bookings/me/stats --
const practicesAttended = ref(0)
const hoursAttended = ref(0)
// B52: colour indicator on the "Сообщения" row, same request, no new call.
const hasUnreadMessages = ref(false)

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
  router.push({ name: 'user-edit-profile' })
}

function onMessages(): void {
  router.push({ name: 'user-messages' })
}

function onNotifications(): void {
  router.push({ name: 'user-notifications' })
}

function onLanguageTimezone(): void {
  router.push({ name: 'user-language-timezone' })
}

function onSupport(): void {
  // User support screen (batch I): topic picker + message + honest stub submit
  // (no support backend yet — see SupportView / VELO-Backend-Tasks.md).
  router.push({ name: 'user-support' })
}

function onShare(): void {
  toast.info('Поделиться будет доступно в следующем обновлении')
}

async function onLogout(): Promise<void> {
  await authStore.logout()
  router.replace({ path: '/' })
}

/** Return to native role dashboard and reset uiMode (TD-FE-ROLE-SWITCH). */
function returnToNativeMode(): void {
  uiStore.setUiMode('default')
  if (authStore.role === 'admin') {
    router.push({ name: 'admin-dashboard' })
  } else {
    router.push({ name: 'master-dashboard' })
  }
}

// -- Lifecycle --
onMounted(async () => {
  // NEW-7: wrapped in try/catch -- a stats fetch failure must not leave the
  // profile screen broken; the cards just stay at 0 until the next visit.
  try {
    const stats = await getMyStats()
    practicesAttended.value = stats.practices_attended
    hoursAttended.value = stats.hours_attended
    hasUnreadMessages.value = stats.has_unread_messages ?? false
  } catch {
    // Non-critical -- profile still renders without fresh counts.
  }
})
</script>

<style scoped>
/* Rail-based insets: content respects MobileLayout's rail + fog; each surface is
   a white card (Figma 1 Profile.svg) instead of the old translucent glass-blue. */
.profile {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* This screen is headerless (no VHeader teleports), but MobileLayout still
     reserves a fixed ~104px top clearance for a floating header (HEADER_FALLBACK
     88 + topGap 16, see MobileLayout.vue:178/188) — leaving a big empty band
     above the avatar card. Cancel that clearance and keep a 50px residual so the
     card sits just under the top fog (operator-dialed via
     .tmp/i1-profile-spacing.html). The 104px mirrors MobileLayout's headerless
     fallback. */
  margin-top: calc(50px - 104px);
}

/* Header: white profile card */
.profile__header {
  text-align: center;
  padding: var(--space-5) var(--space-4) var(--space-5);
}

.profile__avatar {
  /* Центрируем аватар: VAvatar — блочный flex-контейнер фикс-ширины, поэтому
   * text-align родителя его не центрит. flex-center гарантирует центр
   * (operator 2026-06-04). */
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-3);
}

.profile__name {
  font-family: var(--font-body);
  /* Was --text-2xl (50px) — far too large for a name. Down to --text-lg (20px),
     matching the mockup. */
  font-size: var(--text-lg);
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
  font-size: var(--text-base);
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
