<!--
  VELO Frontend -- ConsoleShell (FE-262)

  Layout of every /console/* route: the web admin for a computer or a
  tablet. In a large enough browser window it is the menu (ConsoleSidebar)
  plus the current screen; inside Telegram or in a small window it is
  ConsoleDeviceStub instead (utils/console/access.ts). The menu, with its
  live counters, mounts only when the console opens, so the stub asks the
  server for nothing.
-->

<template>
  <ConsoleDeviceStub v-if="block" :reason="block" />
  <div v-else class="console-shell" data-testid="console-shell">
    <ConsoleSidebar />
    <main class="console-shell__main">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ConsoleSidebar from '@/components/console/ConsoleSidebar.vue'
import ConsoleDeviceStub from '@/components/console/ConsoleDeviceStub.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { platform } from '@/platform'
import { CONSOLE_WIDE_QUERY, consoleBlock } from '@/utils/console/access'

const large = useMediaQuery(CONSOLE_WIDE_QUERY)
const block = computed(() => consoleBlock(platform.name, large.value))
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
