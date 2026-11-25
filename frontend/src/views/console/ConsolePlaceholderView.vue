<!--
  VELO Frontend -- ConsolePlaceholderView (FE-262, FE-272)

  The screen of a console module that has no screen yet (today: settings):
  the module's title in the console frame and a note that it comes in a
  later version.
-->

<template>
  <ConsolePage
    :title="moduleKey ? t(`console.modules.${moduleKey}`) : ''"
    :crumbs="crumbs"
    testid="console-placeholder"
  >
    <ConsoleCard :title="t('console.placeholder.title')" class="console-placeholder">
      <p class="console-placeholder__text">{{ t('console.placeholder.soon') }}</p>
    </ConsoleCard>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import { CONSOLE_MODULES, consoleModuleOf, groupHasCaption } from '@/utils/console/modules'

const route = useRoute()
const moduleKey = computed(() => consoleModuleOf(route.name))
const crumbs = computed(() => {
  const group = CONSOLE_MODULES.find((m) => m.key === moduleKey.value)?.group
  return group && groupHasCaption(group) ? t(`console.groups.${group}`) : undefined
})
</script>

<style scoped>
.console-placeholder {
  max-width: 560px;
}

.console-placeholder__text {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
