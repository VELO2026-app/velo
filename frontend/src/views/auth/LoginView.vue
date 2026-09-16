<!--
  VELO Frontend -- Login (parked Phase A master web auth)

  Unlinked /auth/login route (G1=А): present in the router but never reached by
  App.vue's stage machine or role redirects. Live reachability arrives with the
  web-auth backend (Zod E17). Inside Telegram this is dead code.

  Honest no-auth stub: fields render, every submit is inert -> «недоступно» toast
  (no Phase-A endpoint exists yet). Built 100% from DS over the classic app
  background (transparent view, #app::before fog), mirroring WelcomeView.
  Geometry mirrors the master-web Figma (2 Login.svg).
-->

<template>
  <div class="auth velo-kbd-scroll">
    <VeloLogo variant="lockup" :size="140" class="auth__logo" />
    <h1 class="auth__title">С возвращением!</h1>
    <p class="auth__subtitle">Вход для мастеров</p>

    <div class="auth__form">
      <VInput v-model="email" type="email" placeholder="E-mail" autocomplete="email" />
      <VInput
        v-model="password"
        type="password"
        placeholder="Пароль"
        autocomplete="current-password"
      />
      <button type="button" class="auth__forgot" @click="goRecover">Забыли пароль?</button>

      <VButton variant="primary" block @click="submitLogin">Войти</VButton>

      <p class="auth__or">или</p>

      <div class="auth__socials">
        <VButton variant="ghost" block @click="socialUnavailable">Войти через Google</VButton>
        <VButton variant="ghost" block @click="socialUnavailable">Войти через Apple</VButton>
      </div>
    </div>

    <button type="button" class="auth__back" aria-label="Назад" @click="goBack">
      <IconArrowRight :size="20" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { VInput, VButton } from '@/components/ui'
import { VeloLogo } from '@/components/ui'
import { IconArrowRight } from '@/components/icons'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

const email = ref('')
const password = ref('')

// Phase-A web auth backend is not built (Zod E17): submits are inert stubs that
// surface a «недоступно» toast instead of calling a missing endpoint.
function submitLogin(): void {
  toast.info('Вход для мастеров появится в веб-версии')
}
function socialUnavailable(): void {
  toast.info('Вход через соцсети появится в веб-версии')
}
function goRecover(): void {
  void router.push({ name: 'auth-recover' })
}
function goBack(): void {
  router.back()
}
</script>

<style scoped>
.auth {
  position: relative;
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

/* Marmelad single-weight 400 (Figma renders the title un-stroked, unlike the
   app's faux-bold h1 default). */
.auth__title {
  font-size: var(--text-xl);
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

.auth__forgot {
  align-self: flex-end;
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: calc(-1 * var(--space-2)) 0 var(--space-5);
}

.auth__or {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--space-4) 0;
}

.auth__socials {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Auth CTA labels are 20px in the master-web Figma (vs VButton's app-wide
   --text-sm default). Scoped override only — VButton's default is untouched. */
.auth__form :deep(.v-btn) {
  font-size: var(--text-lg);
}

/* Back pill: composed locally (no DS back-button). 63×35 are the Figma's
   intrinsic dimensions for this control; radius/surface/glow are tokens. */
.auth__back {
  position: absolute;
  left: var(--velo-screen-padding);
  bottom: var(--space-8);
  width: 63px;
  height: 35px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--velo-glass-white-25);
  border: 1px solid var(--velo-glass-border);
  box-shadow: var(--velo-shadow-glow);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: var(--velo-text-primary);
}

.auth__back :deep(svg) {
  transform: rotate(180deg);
}
</style>
