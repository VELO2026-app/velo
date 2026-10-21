<!--
  VELO Frontend -- TopupSuccessView (Phase F5)

  Shown after successful Stripe checkout (or stub topup).
  Refreshes balance from API, shows updated balance, link to dashboard.

  Route: /user/topup/success (name: 'user-topup-success')
-->

<template>
  <div class="topup-result">
    <IconSuccess :size="64" class="topup-result__icon" />
    <h1 class="topup-result__title">{{ t('user.screens.topupSuccess.title') }}</h1>
    <p class="topup-result__text">{{ t('user.screens.topupSuccess.balanceLabel') }}</p>
    <div class="topup-result__balance">
      <VLoader v-if="loading" size="sm" />
      <span v-else>{{ balanceStore.formattedBalance }}</span>
    </div>
    <div class="topup-result__actions">
      <VButton variant="primary" size="lg" block @click="router.push({ name: 'user-dashboard' })">
        {{ t('common.backHome') }}
      </VButton>
      <VButton variant="ghost" block @click="router.push({ name: 'user-topup' })">
        {{ t('user.screens.topupSuccess.topupAgain') }}
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VButton, VLoader } from '@/components/ui'
import { IconSuccess } from '@/components/icons'
import { useBalanceStore } from '@/stores/balance'

const router = useRouter()
const balanceStore = useBalanceStore()
const loading = ref(true)

onMounted(async () => {
  // Refresh balance from API to show actual amount after topup.
  await balanceStore.refresh()
  loading.value = false
})
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
  color: var(--velo-teal-700);
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
  margin: 0 0 var(--space-3);
}

.topup-result__balance {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  color: var(--velo-primary);
  margin-bottom: var(--space-8);
  min-height: var(--velo-size-40);
  display: flex;
  align-items: center;
}

.topup-result__actions {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
