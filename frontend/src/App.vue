<!--
  VELO Frontend -- Root Component (updated: welcome + onboarding gate)

  Auth + entry flow on mount:
    1. Show LoadingView while auth initializes, or while a Telegram logout is
       in progress (isLoggingOut) -- the latter keeps the stub from flashing
       between session clear and the Mini App closing.
    2. If standalone (no Telegram) / not authenticated -> StandaloneStubView
    3. Authenticated -> a small entry state machine (stage):
         'welcome'    -> WelcomeView (shown on every app open, for everyone)
         'onboarding' -> OnboardingView (new users only: onboarding_completed=false)
         'app'        -> RouterView (the actual app)

  Flow transitions:
    - WelcomeView @enter:
        onboarding_completed === true  -> stage 'app'      (returning user)
        onboarding_completed === false -> stage 'onboarding' (new user)
    - OnboardingView @done (completed or skipped; flag already persisted)
        -> stage 'app'
    - WelcomeView @create-account: standalone/browser build only (F10).
      Inside Telegram the button is hidden, so this is a harmless stub.

  The stage lives in component state (not the router), matching how
  LoadingView/StandaloneStubView already gate access outside the router.
  A page reload re-runs auth and starts again at 'welcome' -- intended:
  per product, Welcome shows on every open.

  VToast is mounted once here -- renders all toast notifications
  triggered via useToast() composable from any component.
-->

<template>
  <!-- Single safe-area frame around every gated screen (see AppFrame). -->
  <AppFrame>
    <LoadingView v-if="!isReady || isLoggingOut" />
    <StandaloneStubView v-else-if="isStandalone || !isAuthenticated" />
    <template v-else>
      <WelcomeView
        v-if="stage === 'welcome'"
        @enter="onWelcomeEnter"
        @create-account="onCreateAccount"
      />
      <OnboardingView v-else-if="stage === 'onboarding'" @done="stage = 'app'" />
      <RouterView v-else />
    </template>
  </AppFrame>
  <!-- VToast teleports to body (overlay); kept outside the frame. -->
  <VToast />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAuth } from '@/composables/useAuth'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useBackgroundStabilizer } from '@/composables/useBackgroundStabilizer'
import { useKeyboardDismiss } from '@/composables/useKeyboardDismiss'
import { startRoleFreshnessPoll } from '@/composables/useRoleFreshness'
import { VToast } from '@/components/ui'
import AppFrame from '@/components/layout/AppFrame.vue'
import LoadingView from '@/views/auth/LoadingView.vue'
import StandaloneStubView from '@/views/auth/StandaloneStubView.vue'
import WelcomeView from '@/views/auth/WelcomeView.vue'
import OnboardingView from '@/views/auth/OnboardingView.vue'

const { isReady, isAuthenticated, isStandalone, isLoggingOut, initAuth } = useAuth()
const authStore = useAuthStore()
const toast = useToast()

// Pin the fixed photo-background against the iOS/Telegram keyboard viewport
// shift (the "dancing background"). Mounted once here, on the app root.
useBackgroundStabilizer()

// GLOBAL tap-to-dismiss keyboard (batch L, B1): one app-level owner replacing
// the per-view dismissKeyboardOnBlank copies. Installed once here.
useKeyboardDismiss()

/** Entry stage after a successful auth. Starts at the welcome screen. */
type EntryStage = 'welcome' | 'onboarding' | 'app'
const stage = ref<EntryStage>('welcome')

/**
 * "Войти" on the welcome screen. New users go through the onboarding
 * carousel; returning users (onboarding already completed) go straight
 * to the app.
 */
function onWelcomeEnter(): void {
  const completed = authStore.user?.onboarding_completed ?? false
  stage.value = completed ? 'app' : 'onboarding'
}

/**
 * "Создать аккаунт" -- standalone/browser build only (F10). The button is
 * hidden inside Telegram, so this stub only fires in the browser build.
 */
function onCreateAccount(): void {
  toast.info('Регистрация будет доступна в браузерной версии')
}

onMounted(() => {
  initAuth()
  // T21-4/T21-5 (ПРОМТ №546): foreground-only poll so a role/master-
  // application change is picked up even if the session never navigates
  // again while parked on one screen. Safe to start before auth resolves --
  // each tick's fetchMe() already no-ops without a session token.
  startRoleFreshnessPoll()
})
</script>
