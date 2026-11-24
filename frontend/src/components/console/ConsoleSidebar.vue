<!--
  VELO Frontend -- ConsoleSidebar (FE-262)

  The web console's left menu: the instance mark, the module groups
  (views/console/consoleNav.ts -- only the modules this instance has), and
  at the bottom the way back to the user mode, the mobile admin (until the
  console replaces it) and who is signed in. A module's live counter shows
  as a pill next to it. Colours and sizes are skin tokens only.
-->

<template>
  <aside class="console-sidebar" data-testid="console-sidebar">
    <div class="console-sidebar__brand">
      <VeloLogo :size="36" />
      <div class="console-sidebar__brand-text">
        <span class="console-sidebar__brand-name">{{ t('common.brandName') }}</span>
        <span class="console-sidebar__brand-sub">{{ t('console.brand') }}</span>
      </div>
    </div>

    <nav class="console-sidebar__nav" :aria-label="t('console.navLabel')">
      <div v-for="group in groups" :key="group.key" class="console-sidebar__group">
        <p v-if="group.key !== 'overview'" class="console-sidebar__caption">
          {{ t(`console.groups.${group.key}`) }}
        </p>
        <RouterLink
          v-for="module in group.modules"
          :key="module.key"
          :to="{ name: consoleRouteName(module.key) }"
          class="console-sidebar__item"
          :class="{ 'console-sidebar__item--active': module.key === active }"
          :aria-current="module.key === active ? 'page' : undefined"
          :data-testid="`console-nav-${module.key}`"
        >
          <component :is="module.icon" class="console-sidebar__icon" aria-hidden="true" />
          <span class="console-sidebar__label">{{ t(`console.modules.${module.key}`) }}</span>
          <span v-if="module.badge && badges[module.badge] > 0" class="console-sidebar__count">
            {{ badges[module.badge] }}
          </span>
        </RouterLink>
      </div>
    </nav>

    <div class="console-sidebar__footer">
      <RouterLink
        :to="{ name: 'user-dashboard' }"
        class="console-sidebar__item console-sidebar__item--quiet"
      >
        <IconUserMode class="console-sidebar__icon" aria-hidden="true" />
        <span class="console-sidebar__label">{{ t('console.userMode') }}</span>
      </RouterLink>
      <RouterLink
        :to="{ name: 'admin-dashboard' }"
        class="console-sidebar__item console-sidebar__item--quiet"
      >
        <IconHome class="console-sidebar__icon" aria-hidden="true" />
        <span class="console-sidebar__label">{{ t('console.mobileAdmin') }}</span>
      </RouterLink>
      <div class="console-sidebar__me">
        <VAvatar :name="meName" :url="meAvatar" size="sm" />
        <div class="console-sidebar__me-text">
          <span class="console-sidebar__me-name">{{ meName }}</span>
          <span class="console-sidebar__me-role">{{ t('console.role') }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VAvatar, VeloLogo } from '@/components/ui'
import { IconHome, IconUserMode } from '@/components/icons'
import { useAuthStore } from '@/stores/auth'
import {
  consoleRouteName,
  type ConsoleBadgeSource,
  type ConsoleModuleKey,
  type ConsoleNavGroup,
} from '@/views/console/consoleNav'

defineProps<{
  /** The menu groups to show (already filtered for this instance). */
  groups: readonly ConsoleNavGroup[]
  /** The module of the current screen, highlighted in the menu. */
  active: ConsoleModuleKey | null
  /** Live counters by source; 0 shows nothing. */
  badges: Record<ConsoleBadgeSource, number>
}>()

const auth = useAuthStore()
const meName = computed(() => {
  const user = auth.user
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ')
  return name || t('console.role')
})
const meAvatar = computed(() => auth.user?.avatar_url ?? undefined)
</script>

<style scoped>
.console-sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 248px;
  flex: 0 0 auto;
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-5) var(--space-4) var(--space-4);
  overflow: hidden;
  background: var(--velo-glass-white-70);
  border-right: 1px solid var(--velo-border-light);
}

.console-sidebar__brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2) var(--space-3);
}

.console-sidebar__brand-text,
.console-sidebar__me-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.console-sidebar__brand-name {
  font-size: var(--velo-fs-20);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-sidebar__brand-sub,
.console-sidebar__me-role,
.console-sidebar__caption {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.console-sidebar__nav {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 0;
  overflow-y: auto;
}

.console-sidebar__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
}

.console-sidebar__caption {
  margin: 0;
  padding: var(--space-3) var(--space-3) var(--space-1);
}

.console-sidebar__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--velo-radius-12);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-decoration: none;
  transition: background var(--velo-dur-fast) var(--velo-ease-out);
}

.console-sidebar__item:hover {
  background: var(--velo-bg-subtle);
}

.console-sidebar__item:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.console-sidebar__item--active,
.console-sidebar__item--active:hover {
  background: var(--velo-primary);
  color: var(--velo-on-accent);
}

.console-sidebar__item--quiet {
  color: var(--velo-text-secondary);
}

.console-sidebar__icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.console-sidebar__label {
  flex: 1 1 auto;
  min-width: 0;
}

.console-sidebar__count {
  min-width: 20px;
  padding: 0 var(--space-1);
  box-sizing: border-box;
  border-radius: var(--velo-radius-pill);
  background: var(--velo-pink-300);
  color: var(--velo-on-accent);
  font-size: var(--velo-fs-12);
  text-align: center;
}

.console-sidebar__item--active .console-sidebar__count {
  background: var(--velo-on-accent);
  color: var(--velo-primary);
}

.console-sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  padding-top: var(--space-2);
  border-top: 1px solid var(--velo-border-light);
}

.console-sidebar__me {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
}

.console-sidebar__me-name {
  overflow: hidden;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
