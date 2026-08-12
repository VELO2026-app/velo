<!--
  VELO Frontend -- Welcome View (onboarding 01_Welcome)

  First screen shown to every authenticated user on each app open
  (per product decision: Welcome always, for everyone).

  In Telegram the user is already authenticated via initData, so:
    - "Войти" is effectively a "continue" button -> emits `enter`.
      App.vue then routes new users into the onboarding carousel and
      returning users straight to the dashboard.
    - "Создать аккаунт" is meaningless inside Telegram (the account already
      exists) -- it is only relevant for the standalone/browser build (F10),
      so it is hidden unless isStandalone is true.

  Style mirrors StandaloneStubView (glass pill buttons, slogan). Logo uses the
  white mandala variant at a large size to match Figma 01_Welcome; the wordmark
  is part of the logo, so there is no separate text heading.

  Telegram safe area (2026-05): when launched from the chat list ("Открыть")
  Telegram opens the Mini App in fullscreen, drawing its own Close/menu controls
  ON TOP of our content (no native header). The content safe-area inset
  (--tg-content-safe-area-inset-top, set live by the SDK) tells us how far down
  to push so the logo clears those controls. Launched from inside the chat the
  inset is 0 (Telegram draws its own header), so the same expression is a no-op
  there. Verified on device: fullscreen inset = 46px, in-chat inset = 0px.
-->

<template>
  <div class="welcome velo-kbd-scroll">
    <!-- A11Y-AUDIT-20260810 P1: no visible title (the logo carries the wordmark) --
         sr-only heading so screen-reader users navigating by heading still get a
         page label for this screen. -->
    <h1 class="velo-sr-only">Добро пожаловать</h1>
    <div class="welcome__logo">
      <!-- White mandala variant, large -- matches Figma 01_Welcome.
           The logo already contains the VELO wordmark, so no text heading. -->
      <VeloLogo variant="white" :size="440" spin />
    </div>
    <!-- Fixed-height area below the logo (mirrors LoadingView's), so the
         centered logo lands at the SAME vertical position on both screens and
         does not jump on the loading -> welcome transition. -->
    <div class="welcome__below">
      <p class="welcome__message">Пространство для практики<br />и внутреннего развития</p>

      <div class="welcome__actions">
        <button
          type="button"
          class="welcome__button welcome__button--primary"
          @click="$emit('enter')"
        >
          Войти
        </button>

        <!-- Standalone/browser only: account creation has no meaning in Telegram. -->
        <button
          v-if="isStandalone"
          type="button"
          class="welcome__button welcome__button--glass"
          @click="$emit('create-account')"
        >
          Создать аккаунт
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import VeloLogo from '@/components/ui/VeloLogo.vue'
import { useAuth } from '@/composables/useAuth'

defineEmits<{
  /** "Войти" tapped -- continue into the app (carousel or dashboard). */
  enter: []
  /** "Создать аккаунт" tapped -- standalone build only (F10). */
  'create-account': []
}>()

const { isStandalone } = useAuth()
</script>

<style scoped>
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Fill the height AppFrame gives us, NOT a fresh 100dvh. AppFrame already
     owns the viewport height AND the Telegram safe-area inset (applied once,
     app-wide). Re-declaring 100dvh + the inset here double-applied both and made
     the centered logo jump when dvh resolved / the inset arrived after paint.
     Mirror MobileLayout: height 100%, no own safe-area. */
  min-height: 100%;
  padding: var(--space-5);
  background: transparent;
  text-align: center;
  /* Logo is intentionally larger than the viewport (matches Figma bleed).
     Clip horizontal overflow so it bleeds past the edges symmetrically
     instead of producing a horizontal scrollbar. ROOT-LOCK: overflow-y:auto so
     this owns its own scroll (html/body/#app no longer absorb overflow). */
  overflow-x: hidden;
  overflow-y: auto;
}

.welcome__logo {
  margin-bottom: var(--space-4);
  /* Allow the logo to exceed content width without being squeezed by flex. */
  flex-shrink: 0;
}

.welcome__below {
  /* Fixed-height region below the logo, IDENTICAL on WelcomeView and LoadingView,
     so the vertically-centered logo lands at the same Y on both -> no jump on the
     loading -> welcome transition. 137px = message (2 lines @ line-height 1.5 = 54)
     + margin-bottom (33) + primary button (50); all CSS-fixed values, so the height
     is font-independent as long as the message stays two lines.
     The optional standalone "Создать аккаунт" button can exceed this; min-height
     lets it grow there (standalone has no LoadingView jump to worry about). */
  min-height: 137px;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.welcome__message {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-8) 0;
  max-width: 280px;
  line-height: 1.5;
}

.welcome__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  max-width: var(--velo-content-width);
}

.welcome__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: var(--velo-size-50);
  font-family: var(--font-body);
  font-size: var(--text-base);
  cursor: pointer;
  border-radius: var(--radius-full);
  border: 1px solid var(--velo-glass-border);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
  transition: opacity var(--transition-fast);
}

.welcome__button:hover {
  opacity: 0.9;
}

.welcome__button:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.welcome__button--primary {
  background: var(--velo-primary);
  color: var(--velo-white);
}

/* Glass variant: transparent fill, primary-colored label (matches mockup). */
.welcome__button--glass {
  background: var(--velo-glass-white-01);
  color: var(--velo-text-primary);
}
</style>
