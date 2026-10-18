<!--
  VELO Frontend -- TopupCancelView (Phase F5)

  Shown when user cancels Stripe checkout (clicks browser back
  or Stripe cancel button).

  Route: /user/topup/cancel (name: 'user-topup-cancel')
-->

<template>
  <div class="topup-result">
    <IconClose :size="64" class="topup-result__icon" />
    <h1 class="topup-result__title">{{ t('user.screens.topupCancel.title') }}</h1>
    <p class="topup-result__text">{{ t('user.screens.topupCancel.text') }}</p>
    <div class="topup-result__actions">
      <VButton variant="primary" size="lg" block @click="router.push({ name: 'user-topup' })">
        Попробовать снова
      </VButton>
      <VButton variant="ghost" block @click="router.push({ name: 'user-dashboard' })">
        На главную
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { useRouter } from 'vue-router'
import { VButton } from '@/components/ui'
import { IconClose } from '@/components/icons'

const router = useRouter()
</script>

<style scoped>
.topup-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  text-align: center;
  padding: var(--space-5);
}

.topup-result__icon {
  margin-bottom: var(--space-4);
  color: var(--velo-text-muted);
}

.topup-result__title {
  font-family: var(--font-body);
  font-size: var(--text-2xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-2);
}

.topup-result__text {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-8);
  line-height: 1.5;
}

.topup-result__actions {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
