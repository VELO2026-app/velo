<!--
  VELO Frontend -- RoleSwitchSection (production self role-switch)

  Settings section that lets an account switch its own role — a production
  feature since №256/№260 (operator ruling: theme A). The allowed set is
  CAPABILITY-DERIVED by the backend (verified master -> user/master; admin ->
  all three incl. the home_role round-trip; plain user -> empty, so no
  section renders). Renders one VMenuRow per allowed role EXCEPT the current
  one.

  Used in the three profile screens (user / master / admin). The switch
  rewrites the role server-side; we reset uiMode and navigate to the target
  role's dashboard so the whole shell (tabs, guards) re-resolves.
-->

<template>
  <div v-if="targets.length > 0" class="role-switch">
    <div class="role-switch__title">{{ t('roleSwitch.title') }}</div>
    <div class="role-switch__list">
      <VMenuRow
        v-for="target in targets"
        :key="target"
        variant="primary"
        :label="ROLE_LABEL[target]"
        @click="onSwitch(target)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VMenuRow } from '@/components/ui'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useToast } from '@/composables/useToast'
import { masterApprovedSeenKey } from '@/utils/constants'
import type { UserRole } from '@/api/types'

const router = useRouter()
const authStore = useAuthStore()
const uiStore = useUiStore()
const toast = useToast()

const ROLE_LABEL: Record<UserRole, string> = {
  get user(): string {
    return t('roleSwitch.user')
  },
  get master(): string {
    return t('roleSwitch.master')
  },
  get admin(): string {
    return t('roleSwitch.admin')
  },
}

const ROLE_DASHBOARD: Record<UserRole, string> = {
  user: 'user-dashboard',
  master: 'master-dashboard',
  admin: 'admin-dashboard',
}

// Allowed roles minus the current one — the set of switch targets.
const targets = computed<UserRole[]>(() =>
  authStore.allowedRoles.filter((r) => r !== authStore.role),
)

const switching = ref(false)

async function onSwitch(target: UserRole): Promise<void> {
  if (switching.value) return
  switching.value = true
  try {
    // MA3: a role='user' account that just gained master capability (verified
    // application) never saw "Ваша заявка одобрена!" if it self-switches from
    // here instead of landing on /master/pending naturally. Detour through it
    // ONCE — MasterPendingView's own "Войти в кабинет" (enterMasterMode) does
    // the real switchRole+dashboard-push and marks masterApprovedSeenKey, so
    // every later self-switch (here or elsewhere) goes straight through as
    // before. Admins switching INTO master mode (role !== 'user') are
    // unaffected — that's a preview, not a "freshly verified" moment.
    const userId = authStore.user?.id
    if (
      target === 'master' &&
      authStore.role === 'user' &&
      userId &&
      localStorage.getItem(masterApprovedSeenKey(userId)) !== '1'
    ) {
      await router.push({ name: 'master-pending' })
      return
    }
    await authStore.switchRole(target)
    // Drop any user-mode preview so the native shell of the new role shows.
    uiStore.setUiMode('default')
    await router.push({ name: ROLE_DASHBOARD[target] })
  } catch {
    toast.error(t('roleSwitch.failed'))
  } finally {
    switching.value = false
  }
}
</script>

<style scoped>
.role-switch {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.role-switch__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.role-switch__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
