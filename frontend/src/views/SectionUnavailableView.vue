<!--
  VELO Frontend -- "Section unavailable" (FE-163, PM-22 p.13)

  Where a navigation into a switched-off instance option lands (deep link,
  notification, old link): one screen with a home button, instead of the
  generic 404.
-->

<template>
  <div class="not-found velo-kbd-scroll">
    <IconLock :size="64" class="not-found__icon" />
    <h1 class="not-found__title">{{ t('auth.sectionUnavailable.title') }}</h1>
    <p class="not-found__text">{{ t('auth.sectionUnavailable.text') }}</p>
    <button class="not-found__btn" @click="router.push('/')">{{ t('common.backHome') }}</button>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { useRouter } from 'vue-router'
import { IconLock } from '@/components/icons'
const router = useRouter()
</script>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Fill AppFrame's stable height — never dvh (collapses on keyboard). Canon §2. */
  min-height: 100%;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  overflow-y: auto;
  text-align: center;
  padding: var(--space-5);
  background: transparent;
}
.not-found__icon {
  margin-bottom: var(--space-4);
  color: var(--velo-text-muted);
}
.not-found__title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-32);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-bottom: var(--space-2);
}
.not-found__text {
  font-family: var(--font-body);
  font-size: var(--velo-fs-20);
  color: var(--velo-text-muted);
  margin-bottom: var(--space-5);
}
.not-found__btn {
  padding: var(--space-3) var(--space-5);
  background: var(--velo-primary);
  color: var(--velo-white);
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}
.not-found__btn:hover {
  opacity: 0.9;
}
</style>
