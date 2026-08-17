<!--
  VELO Frontend -- MasterProfileView (redesigned as a menu hub, 2026-06-13)

  Master profile rebuilt to the «1 Profile» design: a clean settings hub
  (avatar + name + email header, then grouped VMenuRow sections) replacing the
  old detail screen. Route: /master/profile (tab «Я»). No masterStatusGuard --
  accessible even while pending.

  Relocations from the old screen (operator-approved 2026-06-12):
    - Payout requisites form -> MasterFinanceView (reached via «Вывод средств»).
    - Bio -> «О себе» in the edit screen.
    - Methods / experience / verified badge -> the public master profile (kept
      off the private hub).
    - Switch-to-user kept as a row; RoleSwitchSection (test-only) below it.

  Backend gaps (built per design, stubbed, recorded for Zod):
    - user.email -> shown when the backend returns it; hidden until then.
    - «Сообщения» unread count (badge) -> 0 until the messages module lands.
    - «Сообщения» / «Мои промокоды» / «Поддержка» open dedicated screens.
-->

<template>
  <div class="master-profile">
    <!-- Header: avatar + name + email -->
    <VCard class="master-profile__header" padding="none">
      <div class="master-profile__avatar">
        <VAvatar :name="displayName" :url="avatarUrl" size="xl" />
      </div>
      <h1 class="master-profile__name">{{ displayName }}</h1>
      <p v-if="userEmail" class="master-profile__email">{{ userEmail }}</p>
    </VCard>

    <!-- Menu sections -->
    <div class="master-profile__menus">
      <!-- Аккаунт -->
      <div class="master-profile__menu-section">
        <div class="master-profile__menu-title">Аккаунт</div>
        <div class="master-profile__menu-list">
          <VMenuRow label="Редактировать профиль" @click="onEditProfile">
            <template #icon><IconEdit :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Сообщения" :badge="messagesCount || undefined" @click="onMessages">
            <template #icon><IconMessages :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Мои промокоды" @click="onPromocodes">
            <template #icon><IconPromo :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Вывод средств" @click="onWithdraw">
            <template #icon><IconFinance :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Настройки -->
      <div class="master-profile__menu-section">
        <div class="master-profile__menu-title">Настройки</div>
        <div class="master-profile__menu-list">
          <VMenuRow label="Уведомления" @click="onNotifications">
            <template #icon><IconBell :size="20" /></template>
          </VMenuRow>
          <VMenuRow label="Язык/Часовой пояс" @click="onLanguageTimezone">
            <template #icon><IconGlobe :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Помощь. The single user-mode entry point is «Режим пользователя» in
           RoleSwitchSection below (a real role switch); the redundant «Открыть
           как пользователь» uiMode-preview row was removed (batch L, L8). -->
      <div class="master-profile__menu-section">
        <div class="master-profile__menu-title">Помощь</div>
        <div class="master-profile__menu-list">
          <VMenuRow label="Поддержка" @click="onSupport">
            <template #icon><IconSupport :size="20" /></template>
          </VMenuRow>
        </div>
      </div>

      <!-- Role switch (TEST-ONLY tester tool; renders nothing for normal masters) -->
      <RoleSwitchSection />

      <!-- Logout -->
      <div class="master-profile__menu-section">
        <div class="master-profile__menu-list">
          <VMenuRow
            label="Выйти"
            variant="danger"
            :show-arrow="false"
            @click="showLogoutModal = true"
          >
            <template #icon><IconLogout :size="20" /></template>
          </VMenuRow>
        </div>
      </div>
    </div>

    <!-- Log out confirmation (design «Log out») -->
    <VModal :open="showLogoutModal" @close="showLogoutModal = false">
      <div class="master-profile__logout-modal">
        <h2 class="master-profile__logout-title">Выйти из аккаунта?</h2>
        <div class="master-profile__logout-actions">
          <button type="button" class="master-profile__logout-btn" @click="onLogout">Да</button>
          <button type="button" class="master-profile__logout-btn" @click="showLogoutModal = false">
            Нет
          </button>
        </div>
      </div>
    </VModal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VAvatar, VCard, VMenuRow, VModal } from '@/components/ui'
import RoleSwitchSection from '@/components/shared/RoleSwitchSection.vue'
import {
  IconEdit,
  IconMessages,
  IconPromo,
  IconFinance,
  IconBell,
  IconGlobe,
  IconSupport,
  IconLogout,
} from '@/components/icons'
import { useMasterStore } from '@/stores/master'
import { useAuthStore } from '@/stores/auth'
import { getChatUnreadSummary } from '@/api/chats'

const router = useRouter()
const masterStore = useMasterStore()
const authStore = useAuthStore()

const displayName = computed(
  () => masterStore.profile?.display_name ?? authStore.user?.first_name ?? 'Мастер',
)
const avatarUrl = computed(() => authStore.user?.avatar_url ?? undefined)

// Forward-looking: email isn't captured by the backend yet (the edit screen
// stubs it). Shown when the backend starts returning user.email; hidden now. -> Zod.
const userEmail = computed(
  () => (authStore.user as { email?: string | null } | null | undefined)?.email ?? '',
)

// «Сообщения» unread badge -- ONE call since T-51 (was: list every thread,
// then one unread-count request per thread, on every hub open). Loaded lazily
// on mount and silent on failure (the badge is a courtesy, the hub must
// render regardless of the chat proxy's health).
//
// THE NUMBER MEANS SOMETHING SLIGHTLY DIFFERENT NOW, and the owner signed off
// on the shift. It is «my unread, in whatever role I hold»:
//   - GONE: unread sitting in the UNCLAIMED support queue. Those threads are
//     visible to every operator, so their counts used to land in this sum --
//     a master's own badge lighting up over a queue that is nobody's yet.
//   - ADDED: threads where this master is himself the client (a master may
//     open a chat with another master).
// For a row on one's OWN profile, «mine» is the correct reading of both.
//
// T-53 removed the support pool from the chat LIST as well (it was a privacy
// leak), so it is now absent from both this number and that screen. Do not
// read that as «the two agree»: a thread where the master is himself the
// client counts HERE and never shows up in that list, because comms scopes an
// operator's list by assignee. That gap is the approved meaning above, not a
// bug to reconcile.
const messagesCount = ref(0)

async function loadMessagesCount(): Promise<void> {
  try {
    messagesCount.value = (await getChatUnreadSummary()).unread_messages
  } catch {
    messagesCount.value = 0
  }
}

// -- Menu actions --
function onEditProfile(): void {
  router.push({ name: 'master-edit-profile' })
}
function onMessages(): void {
  router.push({ name: 'master-messages' })
}
function onPromocodes(): void {
  router.push({ name: 'master-promocodes' })
}
function onWithdraw(): void {
  router.push({ name: 'master-finance' })
}
function onNotifications(): void {
  router.push({ name: 'master-notifications' })
}
function onLanguageTimezone(): void {
  router.push({ name: 'master-language-timezone' })
}
function onSupport(): void {
  router.push({ name: 'master-support' })
}
const showLogoutModal = ref(false)

async function onLogout(): Promise<void> {
  await authStore.logout()
  router.replace({ path: '/' })
}

// -- Lifecycle: load the master profile (display_name) for verified masters. --
onMounted(async () => {
  if (authStore.role === 'master') {
    void loadMessagesCount() // fire-and-forget: never blocks the profile
    await masterStore.fetchMyProfile()
  }
})
</script>

<style scoped>
.master-profile {
  /* F-5 rail sync: MobileLayout supplies the 24px screen rail; vertical only.
     Top padding dropped (operator PR-1, 2026-06-30): the header card now sits
     directly under the shell's top clearance instead of an extra space-4 gap. */
  padding: 0 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Header: white profile card, centred (Figma 1 Profile.svg). */
.master-profile__header {
  text-align: center;
  padding: var(--space-5) var(--space-4);
}

.master-profile__avatar {
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-3);
}

.master-profile__name {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.master-profile__email {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: var(--space-1) 0 0;
}

/* Menu sections. */
.master-profile__menus {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.master-profile__menu-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.master-profile__menu-title {
  font-family: var(--font-body);
  /* Figma: section labels are Marmelad 18, primary colour (not uppercase muted). */
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.master-profile__menu-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* -- Log out confirmation modal (design «Log out») -- */
.master-profile__logout-modal {
  text-align: center;
}

.master-profile__logout-title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-4);
}

.master-profile__logout-actions {
  display: flex;
  border-top: 1px solid var(--velo-glass-blue-30);
}

.master-profile__logout-btn {
  flex: 1;
  padding: var(--space-3);
  background: transparent;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  cursor: pointer;
}

.master-profile__logout-btn:first-child {
  border-right: 1px solid var(--velo-glass-blue-30);
}
</style>
