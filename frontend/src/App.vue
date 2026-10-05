<!--
  VELO Frontend -- Root Component (updated: welcome + onboarding gate, FE-39 auto-entry)

  Auth + entry flow on mount:
    1. Show LoadingView while auth initializes, while the entry stage is still
       undecided (stage === null), or while a Telegram logout is in progress
       (isLoggingOut) -- the latter keeps the stub from flashing between
       session clear and the Mini App closing.
    2. If standalone (no Telegram) / not authenticated -> StandaloneStubView
    3. Authenticated -> a small entry state machine (stage). FE-39: the INITIAL
       stage is decided once initAuth() resolves, not hardcoded:
         onboarding_completed === true  -> 'app'   (returning user: the splash
                                         goes straight to RouterView, where
                                         roleRedirect picks the role dashboard)
         onboarding_completed === false -> 'welcome' (new user: Welcome ->
                                         onboarding carousel -> app)

  Flow transitions:
    - Initial: after initAuth() resolves (decideInitialStage).
    - WelcomeView @enter:
        onboarding_completed === true  -> stage 'app'      (defensive fallback)
        onboarding_completed === false -> stage 'onboarding' (new user)
    - OnboardingView @done (completed or skipped; flag already persisted)
        -> stage 'app'
    - WelcomeView @create-account: standalone/browser build only (F10).
      Inside Telegram the button is hidden, so this is a harmless stub.

  The stage lives in component state (not the router), matching how
  LoadingView/StandaloneStubView already gate access outside the router.
  A page reload re-runs auth and re-decides the stage -- a returning user
  lands directly in the app again. FE-39 supersedes the old "Welcome on
  every open" decision: Welcome is now the new-user entry screen only.

  VToast is mounted once here -- renders all toast notifications
  triggered via useToast() composable from any component.
-->

<template>
  <!-- Single safe-area frame around every gated screen (see AppFrame). -->
  <AppFrame>
    <LoadingView v-if="!isReady || isLoggingOut || stage === null" />
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
import { useViewportGeometry } from '@/composables/useViewportGeometry'
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

// PROMPT №657: the ONE live viewport/keyboard reader -- --velo-vvh,
// --velo-vv-offset, html.is-keyboard-open, and the reactive refs every other
// consumer (composer position, tab bar, autogrow, the debug panel) now reads
// instead of touching window.visualViewport / the tma.js viewport SDK
// themselves. See the file's own header for what this replaces.
useViewportGeometry()

// GLOBAL tap-to-dismiss keyboard (batch L, B1): one app-level owner replacing
// the per-view dismissKeyboardOnBlank copies. Installed once here.
useKeyboardDismiss()

/**
 * Entry stage after a successful auth. Null until initAuth() resolves and
 * picks the initial stage; while null the gate keeps showing the splash
 * (LoadingView), so no frame renders an empty app or the wrong screen.
 */
type EntryStage = 'welcome' | 'onboarding' | 'app'
const stage = ref<EntryStage | null>(null)

/**
 * FE-39: pick the entry stage once auth is ready. A returning user
 * (onboarding already completed) skips Welcome entirely -- the splash
 * transitions straight into the app, where the router's roleRedirect sends
 * them to their role dashboard (or consumes a pending deep link). New users
 * still land on Welcome first; a missing flag falls back to 'welcome',
 * never to the dashboard.
 */
function decideInitialStage(): EntryStage {
  return authStore.user?.onboarding_completed ? 'app' : 'welcome'
}

/**
 * "Войти" on the welcome screen. New users go through the onboarding
 * carousel; returning users (onboarding already completed) go straight
 * to the app. Since FE-39 Welcome is the NEW-user entry only, so the
 * completed branch here is a defensive fallback, not a reachable path.
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
  // FE-39: once initAuth() resolves, decide whether the splash hands off to
  // the app directly (returning user) or to the Welcome screen (new user).
  void initAuth().then(() => {
    stage.value = decideInitialStage()
  })
  // T21-4/T21-5 (PROMPT №546): foreground-only poll so a role/master-
  // application change is picked up even if the session never navigates
  // again while parked on one screen. Safe to start before auth resolves --
  // each tick's fetchMe() already no-ops without a session token.
  startRoleFreshnessPoll()
})
</script>
