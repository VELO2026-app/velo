<!--
  VELO Frontend -- Login screen outside Telegram (Standalone phase 3)

  The ONLY way into the app from a browser or the home-screen app: «Войти
  через Telegram» -> Telegram's page (the person confirms in Telegram) ->
  back to RETURN_PATH, where useAuth.ts finishes the sign-in on a fresh page
  load. The account is the one the Mini App uses for this Telegram account;
  a new person gets one on the first sign-in.

  What the screen says comes from loginNotice: why the last attempt did not
  get in (useAuth.ts, LoginNotice), worded here as a phrase -- never an error
  code. Pressing the button again clears it.

  Same look as TelegramStubView (01_Welcome.png): logo, title, pill button.
-->

<template>
  <div class="login velo-kbd-scroll">
    <div class="login__logo">
      <VeloLogo :size="120" />
    </div>
    <h1 class="login__title">VELΘ</h1>
    <p class="login__message">{{ t('auth.tagline1') }}<br />{{ t('auth.tagline2') }}</p>
    <button type="button" class="login__button" :disabled="starting" @click="onLogin">
      {{ starting ? t('auth.loginOpening') : t('auth.loginCta') }}
    </button>
    <p v-if="notice" class="login__notice" role="alert">{{ notice }}</p>
    <p v-else class="login__hint">{{ t('auth.sameAccount') }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { VeloLogo } from '@/components/ui'
import { useAuthStore } from '@/stores/auth'
import { loginNotice, loginNoticeFor, type LoginNotice } from '@/composables/useAuth'

// tz-i18n: phrases resolve per notice code from auth.notice.*.
const PHRASES: Record<LoginNotice, string> = {
  get cancelled(): string {
    return t('auth.notice.cancelled')
  },
  get foreign(): string {
    return t('auth.notice.foreign')
  },
  get expired(): string {
    return t('auth.notice.expired')
  },
  get telegram_failed(): string {
    return t('auth.notice.telegram_failed')
  },
  get not_configured(): string {
    return t('auth.notice.not_configured')
  },
  get deactivated(): string {
    return t('auth.notice.deactivated')
  },
  get rate_limited(): string {
    return t('auth.notice.rate_limited')
  },
  get unavailable(): string {
    return t('auth.notice.unavailable')
  },
  get network(): string {
    return t('auth.notice.network')
  },
}

const authStore = useAuthStore()
const starting = ref(false)
const notice = computed(() => (loginNotice.value ? PHRASES[loginNotice.value] : null))

async function onLogin(): Promise<void> {
  loginNotice.value = null
  starting.value = true
  try {
    // Leaves the page for Telegram on success; the button stays disabled
    // until the browser navigates away.
    await authStore.startBrowserLogin()
  } catch (error) {
    loginNotice.value = loginNoticeFor(error)
    starting.value = false
  }
}
</script>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Fill AppFrame's content area (it owns viewport height + safe-area once,
     app-wide). A fresh 100dvh here double-applies and makes content jump. */
  min-height: 100%;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  overflow-y: auto;
  padding: var(--space-5);
  background: transparent;
  text-align: center;
}

.login__logo {
  margin-bottom: var(--space-2);
}

.login__title {
  font-family: var(--font-body);
  font-size: var(--text-2xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-4) 0;
}

.login__message {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-8) 0;
  max-width: 280px;
  line-height: 1.5;
}

.login__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: var(--velo-content-width);
  height: var(--velo-size-50);
  font-family: var(--font-body);
  font-size: var(--text-base);
  border-radius: var(--radius-full);
  border: 1px solid var(--velo-glass-border);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
  background: var(--velo-primary);
  color: var(--velo-white);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.login__button:hover {
  opacity: 0.9;
}

.login__button:disabled {
  opacity: 0.6;
  cursor: default;
}

.login__notice,
.login__hint {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  margin: var(--space-4) 0 0 0;
  max-width: 280px;
  line-height: 1.4;
}

.login__notice {
  color: var(--velo-text-primary);
}

.login__hint {
  color: var(--velo-text-muted);
}
</style>
