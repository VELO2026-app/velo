<!--
  VELO Frontend -- Recover password · request (parked Phase A master web auth)

  Unlinked /auth/recover route (G1=А). Honest no-auth stub: «Отправить код» is
  inert -> «недоступно» toast (Phase-A backend = Zod E17). Transparent over the
  classic app background. Geometry mirrors "Recover password (email).svg".
-->

<template>
  <div class="auth velo-kbd-scroll">
    <VeloLogo variant="lockup" :size="140" class="auth__logo" />
    <h1 class="auth__title">Восстановление пароля</h1>
    <p class="auth__subtitle">Введите почту</p>

    <div class="auth__form">
      <VInput v-model="email" type="email" placeholder="E-mail" autocomplete="email" />
      <VButton variant="primary" block @click="sendCode">Отправить код</VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { VInput, VButton } from '@/components/ui'
import { VeloLogo } from '@/components/ui'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const email = ref('')

// Phase-A web auth backend is not built (Zod E17): inert stub.
function sendCode(): void {
  toast.info('Восстановление пароля появится в веб-версии')
}
</script>

<style scoped>
.auth {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100%;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  overflow-y: auto;
  padding: var(--space-10) var(--velo-screen-padding) var(--space-8);
  background: transparent;
  text-align: center;
}

.auth__logo {
  margin-bottom: var(--space-5);
}

.auth__title {
  font-size: var(--text-28);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.auth__subtitle {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--space-2) 0 var(--space-5);
}

.auth__form {
  width: 100%;
  max-width: var(--velo-content-width);
  display: flex;
  flex-direction: column;
}

/* Auth CTA label is 20px in the Figma; scoped override (VButton default kept). */
.auth__form :deep(.v-btn) {
  font-size: var(--text-lg);
}
</style>
