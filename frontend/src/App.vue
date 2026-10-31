<!--
  VELO Frontend -- Root Component (updated: welcome + onboarding gate, FE-39 auto-entry)

  Auth + entry flow on mount:
    1. Show LoadingView while auth initializes, while the entry stage is still
       undecided (stage === null), or while a Telegram logout is in progress
       (isLoggingOut) -- the latter keeps the stub from flashing between
       session clear and the Mini App closing.
    2. The saved session could not be checked (no answer, outside Telegram:
       restoreUnreachable) -> LoadingErrorView ("try again"); the token stays
       saved for that attempt.
    3. Not authenticated:
         in Telegram  -> TelegramStubView (initData sign-in failed or the
                         session ended -- unchanged by Standalone phase 3);
         outside      -> TelegramLoginView, the ONLY way in from a browser
                         ("Войти через Telegram"). The sign-in ends on a
                         fresh page load (useAuth.ts), so the stage below is
                         decided with the user already known.
    4. Authenticated -> a small entry state machine (stage). FE-39: the INITIAL
       stage is decided once initAuth() resolves, not hardcoded:
         onboarding_completed === true  -> 'app'   (returning user: the splash
                                         goes straight to RouterView, where
                                         roleRedirect picks the role dashboard)
         onboarding_completed === false -> 'welcome' (new user: Welcome ->
                                         onboarding carousel -> app)
         FE-81 exception: a new user arriving via a school invite deep link
         (school__ startapp) goes straight to 'app' too -- the RouterView then
         renders the invitation screen, and the join view runs the onboarding
         carousel itself after the join (FE-83), landing in the joined school
         on finish or skip (FE-84).

  Flow transitions:
    - Initial: after initAuth() resolves (decideInitialStage).
    - WelcomeView @enter:
        onboarding_completed === true  -> stage 'app'      (defensive fallback)
        onboarding_completed === false -> stage 'onboarding' (new user)
    - OnboardingView @done (completed or skipped; flag already persisted)
        -> stage 'app'

  The stage lives in component state (not the router), matching how
  LoadingView and the sign-in screens already gate access outside the router.
  A page reload re-runs auth and re-decides the stage -- a returning user
  lands directly in the app again. FE-39 supersedes the old "Welcome on
  every open" decision: Welcome is now the new-user entry screen only.

  VToast is mounted once here -- renders all toast notifications
  triggered via useToast() composable from any component. BotAccessHint is
  mounted next to it: shown once after a browser sign-in that did not give
  the bot the right to write.
-->

<template>
  <!-- Single safe-area frame around every gated screen (see AppFrame). -->
  <AppFrame>
    <!-- Stage changes crossfade (styles/motion.css «velo-stage»): the leaving
         stage is lifted out of flow and fades over the arriving one, so the
         splash dissolves into the first screen instead of cutting to it.
         Simultaneous, not out-in -- no added wait on the way in. -->
    <Transition name="velo-stage">
      <LoadingView v-if="!isReady || isLoggingOut || stage === null" />
      <LoadingErrorView v-else-if="restoreUnreachable" />
      <TelegramStubView v-else-if="!isAuthenticated && inTelegram" />
      <TelegramLoginView v-else-if="!isAuthenticated" />
      <WelcomeView v-else-if="stage === 'welcome'" @enter="onWelcomeEnter" />
      <OnboardingView v-else-if="stage === 'onboarding'" @done="stage = 'app'" />
      <RouterView v-else />
    </Transition>
  </AppFrame>
  <!-- VToast teleports to body (overlay); kept outside the frame. -->
  <VToast />
  <BotAccessHint v-if="isAuthenticated && botAccessHint" @close="botAccessHint = false" />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { firstScreenReady } from '@/router/firstScreen'
import { useAuth, isSchoolInviteStartParam } from '@/composables/useAuth'
import { useAuthStore } from '@/stores/auth'
import {
  applyUserLanguage,
  availableLocales,
  clearLocaleHint,
  loadLocale,
  setLocale,
} from '@/locales'
import { INSTANCE } from '@/platform/instance'
import { platform } from '@/platform'
import { useBackgroundStabilizer } from '@/composables/useBackgroundStabilizer'
import { useViewportGeometry } from '@/composables/useViewportGeometry'
import { useKeyboardDismiss } from '@/composables/useKeyboardDismiss'
import { startRoleFreshnessPoll } from '@/composables/useRoleFreshness'
import { VToast } from '@/components/ui'
import AppFrame from '@/components/layout/AppFrame.vue'
import LoadingView from '@/views/auth/LoadingView.vue'
import LoadingErrorView from '@/views/auth/LoadingErrorView.vue'
import TelegramStubView from '@/views/auth/TelegramStubView.vue'
import TelegramLoginView from '@/views/auth/TelegramLoginView.vue'
import BotAccessHint from '@/views/auth/BotAccessHint.vue'
import WelcomeView from '@/views/auth/WelcomeView.vue'
import OnboardingView from '@/views/auth/OnboardingView.vue'

const { isReady, isAuthenticated, isLoggingOut, restoreUnreachable, botAccessHint, initAuth } =
  useAuth()
const authStore = useAuthStore()
const router = useRouter()
const inTelegram = platform.name === 'telegram'

// tz-i18n 0.3: the server owns the language (User.language, normalized by
// the backend to en/de/es/ru); the UI follows it the moment the user record
// arrives or changes (profile edit, phase-5 switcher).
watch(
  () => authStore.user?.language,
  (language) => {
    // Logout (user -> null): drop the boot hint and return to the default
    // locale -- a signed-out device must not keep the personal language.
    if (language == null) {
      clearLocaleHint()
      void setLocale(INSTANCE.defaultLocale)
      return
    }
    applyUserLanguage(language)
  },
)

// Prefetch the other catalog locales shortly after mount (tz-i18n phase 5):
// warms the lazy chunk cache in the background so a switch is an instant
// same-frame flip, not a network wait. loadLocale, NEVER setLocale -- warming
// must not switch: a setLocale loop over availableLocales() ended every mount
// on the last locale (en), silently reverting the UI to English two seconds
// in. A plain timeout -- idle enough not to compete with the boot requests,
// soon enough to warm before a tap.
onMounted(() => {
  setTimeout(() => {
    for (const locale of availableLocales()) void loadLocale(locale)
  }, 2000)
})

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
 *
 * FE-81: the one exception is a school invite deep link. The router has
 * already navigated to the standalone invitation screen, so the gate opens
 * the app around it: the user sees «Вас пригласили в школу» BEFORE any
 * onboarding, and the join view runs the carousel after the join (FE-83),
 * landing in the joined school on finish or skip (FE-84).
 */
function decideInitialStage(): EntryStage {
  if (authStore.user?.onboarding_completed) return 'app'
  if (isSchoolInviteStartParam()) return 'app'
  return 'welcome'
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

onMounted(() => {
  // FE-39: once initAuth() resolves, decide whether the splash hands off to
  // the app directly (returning user) or to the Welcome screen (new user).
  // First-screen gate (router/firstScreen.ts): a returning user's splash
  // hands over only once the route is resolved and the first screen's data,
  // dock and insets are in (capped) -- the screen paints once, finished.
  void initAuth().then(async () => {
    const next = decideInitialStage()
    if (next === 'app' && isAuthenticated.value) await firstScreenReady(router)
    stage.value = next
  })
  // T21-4/T21-5 (PROMPT №546): foreground-only poll so a role/master-
  // application change is picked up even if the session never navigates
  // again while parked on one screen. Safe to start before auth resolves --
  // each tick's fetchMe() already no-ops without a session token.
  startRoleFreshnessPoll()
})
</script>
