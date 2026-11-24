<!--
  VELO Frontend -- ConsoleShell (FE-262)

  Layout of every /console/* route: the web admin for a computer. In a wide
  browser window it is the menu (ConsoleSidebar) plus the current screen;
  inside Telegram or in a narrow window it is ConsoleDeviceStub instead
  (views/console/consoleAccess.ts). The menu lists only the modules this
  instance has (consoleNav.ts) and carries the live counters of the admin
  stats, the same query the mobile AdminShell reads.
-->

<template>
  <ConsoleDeviceStub v-if="block" :reason="block" />
  <div v-else class="console-shell" data-testid="console-shell">
    <ConsoleSidebar :groups="groups" :active="active" :badges="badges" />
    <main class="console-shell__main">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ConsoleSidebar from '@/components/console/ConsoleSidebar.vue'
import ConsoleDeviceStub from '@/components/console/ConsoleDeviceStub.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { onFailedRequest, useAdminStats } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { platform } from '@/platform'
import { isOptionEnabled } from '@/platform/instance'
import { CONSOLE_WIDE_QUERY, consoleBlock } from '@/views/console/consoleAccess'
import {
  consoleModuleOf,
  consoleNavGroups,
  type ConsoleBadgeSource,
} from '@/views/console/consoleNav'

const route = useRoute()
const wide = useMediaQuery(CONSOLE_WIDE_QUERY)
const block = computed(() => consoleBlock(platform.name, wide.value))

const groups = consoleNavGroups(isOptionEnabled)
const active = computed(() => consoleModuleOf(route.name))

const adminStats = useAdminStats()
const { pendingVerifications, pendingModeration } = adminStats
const badges = computed<Record<ConsoleBadgeSource, number>>(() => ({
  pendingVerifications: pendingVerifications.value,
  pendingModeration: pendingModeration.value,
}))
const toast = useToast()
onFailedRequest(adminStats.query, (error) =>
  toast.error(extractApiError(error, t('storeErrors.admin.dashboard'))),
)
</script>

<style scoped>
.console-shell {
  display: flex;
  height: 100%;
  min-height: 0;
}

.console-shell__main {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  background: var(--velo-glass-white-35);
}
</style>
