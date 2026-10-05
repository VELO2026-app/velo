<!--
  VELO Frontend -- LoadingErrorView (WARNING-3)

  Shown when waitUntilReady() times out before auth.role is set.
  This happens when the network stalls or the Telegram SDK freezes
  during initAuth() -- typically on a bad mobile connection.

  The user sees a recoverable error with a retry button (full reload)
  instead of landing on /user/dashboard with null role and broken state.

  Route: /auth-error (name: 'auth-error')
  No auth guard -- must be reachable before auth completes.
-->

<template>
  <div class="auth-error velo-kbd-scroll">
    <div class="auth-error__card">
      <div class="auth-error__icon">⏱️</div>

      <h1 class="auth-error__title">Не удалось загрузить</h1>

      <p class="auth-error__body">
        Соединение заняло слишком много времени. Проверьте интернет и попробуйте снова.
      </p>

      <VButton variant="primary" size="lg" block @click="onRetry"> Попробовать снова </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { host } from '@/platform/host'
import { VButton } from '@/components/ui'

/**
 * Full page reload re-runs initAuth() from scratch.
 * This is intentional -- we don't call initAuth() directly here
 * because the platform SDK state may be partially initialized.
 */
function onRetry(): void {
  host.location.reload()
}
</script>

<style scoped>
.auth-error {
  /* Fill AppFrame's content area (it owns viewport height + safe-area once,
     app-wide). A fresh 100dvh here double-applies and makes content jump. */
  min-height: 100%;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: transparent;
}

.auth-error__card {
  width: 100%;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-8);
  background: var(--velo-glass-blue-15);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-md);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  text-align: center;
}

.auth-error__icon {
  font-size: 48px;
}

.auth-error__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.auth-error__body {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin: 0;
}
</style>
