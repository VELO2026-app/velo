<!--
  VELO Frontend -- Loading View (DS-6)

  Displayed while auth initialization is in progress.
  Uses the SAME white mandala as WelcomeView (logo-white.svg, large) so the
  loading -> welcome transition is seamless: no blue-mandala flash before the
  white one (the default `logo.svg` is the colored/blue variant). The white
  logo already contains the VELΘ wordmark, so there is no separate title.
  Spinner stays as the loading cue.
-->

<template>
  <div class="loading velo-kbd-scroll">
    <!-- A11Y-AUDIT-20260810 P1: no visible title (the logo carries the wordmark) --
         sr-only heading so screen-reader users navigating by heading still get a
         page label for this screen. -->
    <h1 class="velo-sr-only">Загрузка</h1>
    <div class="loading__logo">
      <VeloLogo variant="white" :size="440" spin />
    </div>
    <!-- Fixed-height area below the logo, mirroring WelcomeView's, so the centered
         logo sits at the SAME Y and does not jump on the loading -> welcome swap. -->
    <div class="loading__below">
      <div class="loading__spinner" />
    </div>
  </div>
</template>

<script setup lang="ts">
import VeloLogo from '@/components/ui/VeloLogo.vue'
</script>

<style scoped>
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Fill AppFrame's content area (it owns viewport height + safe-area once,
     app-wide). A fresh 100dvh here double-applies and makes the logo jump. */
  min-height: 100%;
  background: transparent;
  /* The white logo is intentionally larger than the viewport (Figma bleed,
     same as WelcomeView). Clip horizontal overflow so it bleeds symmetrically
     instead of producing a horizontal scrollbar. ROOT-LOCK: overflow-y:auto so
     this owns its own scroll (html/body/#app no longer absorb overflow). */
  overflow-x: hidden;
  overflow-y: auto;
}

.loading__logo {
  /* Match WelcomeView: let the oversized logo bleed without being squeezed, and
     use the same gap to the area below so the logo Y matches WelcomeView. */
  flex-shrink: 0;
  margin-bottom: var(--space-4);
}

.loading__below {
  /* Same fixed height as WelcomeView's .welcome__below -> identical logo Y, no jump. */
  min-height: 137px;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.loading__spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--velo-border-light);
  border-top-color: var(--velo-primary);
  border-radius: var(--radius-full);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
