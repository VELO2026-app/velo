<!--
  VELO Frontend -- ConsoleDeviceStub (FE-262)

  What the web console shows where it does not open (views/console/
  consoleAccess.ts): inside Telegram, or in a browser window narrower than a
  computer screen. It names the reason, gives the console link (open it in
  the browser from Telegram, or copy it) and the way back to the user mode.
  Same look as the sign-in stubs: logo, title, pill buttons.
-->

<template>
  <div class="console-stub velo-kbd-scroll" data-testid="console-stub" :data-reason="reason">
    <div class="console-stub__card">
      <VeloLogo :size="64" />
      <h1 class="console-stub__title">{{ t('console.stub.title') }}</h1>
      <p class="console-stub__text">
        {{ reason === 'telegram' ? t('console.stub.telegram') : t('console.stub.narrow') }}
      </p>
      <p class="console-stub__link" data-testid="console-stub-link">{{ consoleUrl }}</p>
      <VButton v-if="reason === 'telegram'" block @click="platform.openLink(consoleUrl)">
        {{ t('console.stub.openBrowser') }}
      </VButton>
      <VButton :variant="reason === 'telegram' ? 'secondary' : 'primary'" block @click="copy">
        {{ copied ? t('console.stub.copied') : t('console.stub.copy') }}
      </VButton>
      <VButton variant="secondary" block @click="router.push({ name: 'user-dashboard' })">
        {{ t('console.stub.userMode') }}
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { VButton, VeloLogo } from '@/components/ui'
import { platform } from '@/platform'
import { host } from '@/platform/host'
import type { ConsoleBlock } from '@/views/console/consoleAccess'

defineProps<{
  /** Why the console does not open here. */
  reason: ConsoleBlock
}>()

const router = useRouter()
const consoleUrl = new URL('/console', host.location.origin).toString()
const copied = ref(false)

async function copy(): Promise<void> {
  try {
    await host.navigator.clipboard.writeText(consoleUrl)
    copied.value = true
  } catch {
    // No clipboard (an old WebView, a denied permission): the link stays
    // on screen to copy by hand.
    copied.value = false
  }
}
</script>

<style scoped>
.console-stub {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  box-sizing: border-box;
  padding: var(--space-5);
  overflow-y: auto;
}

.console-stub__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  max-width: 360px;
  box-sizing: border-box;
  padding: var(--space-6) var(--space-5);
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-card-solid);
  box-shadow: var(--velo-shadow-glass);
  text-align: center;
}

.console-stub__title {
  margin: 0;
  font-size: var(--velo-fs-22);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-stub__text {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.console-stub__link {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow-wrap: anywhere;
  border-radius: var(--velo-radius-12);
  background: var(--velo-bg-subtle);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}
</style>
