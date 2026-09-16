<!--
  VELO Frontend -- AdminProfileView (TD-FE-ROLE-SWITCH)

  Minimal admin profile screen. Route: /admin/profile (tab "Я").

  Sections:
    1. Profile header -- avatar, display name, admin badge.
    2. Switch to user mode -- button visible to all admins.
       Sets uiMode = 'user' and navigates to /user/profile.
    3. Logout.
-->

<template>
  <div class="admin-profile">
    <VHeader title="Профиль" show-back @back="router.back()" />

    <!-- Header -->
    <VCard class="admin-profile__header">
      <VAvatar :name="displayName" size="xl" />
      <div class="admin-profile__header-info">
        <h1 class="admin-profile__name">{{ displayName }}</h1>
        <VBadge variant="info">Администратор</VBadge>
      </div>
    </VCard>

    <!-- Switch to user mode -->
    <VCard class="admin-profile__section">
      <div class="admin-profile__section-title">РЕЖИМ ПРОСМОТРА</div>
      <p class="admin-profile__section-desc">
        Перейдите в интерфейс пользователя, чтобы просматривать каталог и бронировать практики.
      </p>
      <VButton variant="secondary" @click="switchToUserMode">
        Открыть как пользователь<IconArrowRight
          :size="18"
          :style="{ marginLeft: 'var(--space-2)', verticalAlign: 'middle' }"
        />
      </VButton>
    </VCard>

    <!-- Role switch (TEST-ONLY tester tool; renders nothing for normal admins) -->
    <RoleSwitchSection />

    <!-- Logout -->
    <VCard class="admin-profile__section">
      <VButton variant="ghost" :loading="loggingOut" @click="onLogout"> Выйти </VButton>
    </VCard>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { VAvatar, VBadge, VButton, VCard } from '@/components/ui'
import { VHeader } from '@/components/layout'
import RoleSwitchSection from '@/components/shared/RoleSwitchSection.vue'
import { IconArrowRight } from '@/components/icons'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'

const router = useRouter()
const authStore = useAuthStore()
const uiStore = useUiStore()

const loggingOut = ref(false)

const displayName = computed(() => {
  if (!authStore.user) return 'Администратор'
  const parts = [authStore.user.first_name, authStore.user.last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Администратор'
})

// -- Switch to user mode --
function switchToUserMode(): void {
  uiStore.setUiMode('user')
  void router.push({ name: 'user-profile' })
}

// -- Logout --
async function onLogout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await authStore.logout()
    void router.replace({ path: '/' })
  } finally {
    loggingOut.value = false
  }
}
</script>

<style scoped>
.admin-profile {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Header */
.admin-profile__header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.admin-profile__header-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.admin-profile__name {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  line-height: 1.2;
  word-break: break-word;
  letter-spacing: 0.02em;
}

/* Sections */
.admin-profile__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.admin-profile__section-title {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.admin-profile__section-desc {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
}
</style>
