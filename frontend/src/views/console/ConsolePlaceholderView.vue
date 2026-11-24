<!--
  VELO Frontend -- ConsolePlaceholderView (FE-262)

  The screen of a console module that has not moved to the web yet: the
  module's title in the console frame, a note that it is moving, and a way
  to the same screen in the mobile admin while that one still works. Each
  module's own screen replaces this one in its slice.
-->

<template>
  <ConsolePage
    :title="moduleKey ? t(`console.modules.${moduleKey}`) : ''"
    :crumbs="crumbs"
    testid="console-placeholder"
  >
    <div class="console-placeholder">
      <p class="console-placeholder__title">{{ t('console.placeholder.title') }}</p>
      <p class="console-placeholder__text">
        {{ legacy ? t('console.placeholder.legacy') : t('console.placeholder.soon') }}
      </p>
      <div v-if="legacy">
        <VButton variant="secondary" @click="router.push(legacy)">{{
          t('console.placeholder.open')
        }}</VButton>
      </div>
    </div>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { VButton } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import { CONSOLE_MODULES, consoleModuleOf, type ConsoleModuleKey } from '@/views/console/consoleNav'

/** Where each module lives in the mobile admin until it moves (none -- new). */
const LEGACY: Partial<Record<ConsoleModuleKey, RouteLocationRaw>> = {
  dashboard: { name: 'admin-dashboard' },
  masters: { name: 'admin-masters' },
  users: { name: 'admin-users' },
  schools: { name: 'admin-schools' },
  practices: { name: 'admin-practices' },
  catalog: { name: 'admin-catalog' },
  moderation: { name: 'admin-reports', query: { tab: 'complaints' } },
  support: { name: 'admin-reports', query: { tab: 'tickets' } },
  finance: { name: 'admin-revenue' },
  analytics: { name: 'admin-checkin-rate' },
}

const route = useRoute()
const router = useRouter()
const moduleKey = computed(() => consoleModuleOf(route.name))
const legacy = computed(() => (moduleKey.value ? LEGACY[moduleKey.value] : undefined))
const crumbs = computed(() => {
  const group = CONSOLE_MODULES.find((m) => m.key === moduleKey.value)?.group
  return group && group !== 'overview' ? t(`console.groups.${group}`) : undefined
})
</script>

<style scoped>
.console-placeholder {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 560px;
  padding: var(--space-5);
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-card-solid);
  box-shadow: var(--velo-shadow-glass);
}

.console-placeholder__title {
  margin: 0;
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-placeholder__text {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
