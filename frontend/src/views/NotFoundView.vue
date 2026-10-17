<!--
  VELO Frontend -- 404 Not Found (Phase F2.2)
-->

<template>
  <div class="not-found velo-kbd-scroll">
    <IconSearch :size="64" class="not-found__icon" />
    <h1 class="not-found__title">404</h1>
    <p class="not-found__text">{{ t('auth.notFoundText') }}</p>
    <button class="not-found__btn" @click="router.push('/')">{{ t('auth.notFoundHome') }}</button>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { useRouter } from 'vue-router'
import { IconSearch } from '@/components/icons'
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
  font-size: var(--text-2xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-bottom: var(--space-2);
}
.not-found__text {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-muted);
  margin-bottom: var(--space-5);
}
.not-found__btn {
  padding: var(--space-3) var(--space-5);
  background: var(--velo-primary);
  color: var(--velo-white);
  font-family: var(--font-body);
  font-size: var(--text-sm);
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
