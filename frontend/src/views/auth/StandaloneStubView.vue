<!--
  VELO Frontend -- Standalone Stub View (DS-6, fixed 2026-07-14)

  Shown when user opens app outside Telegram (no initData).
  Directs them to open via the bot.
  Matches 01_Welcome.png mockup style — glassmorphism buttons, pill shape.

  Two fixes on 2026-07-14:
    - target="_blank" removed. This is a universal link: on iOS Safari and
      Android Chrome the hand-off into the Telegram app is only reliable when
      the navigation happens in the SAME tab, from a direct user gesture. In a
      new tab the browser often keeps the link to itself and the user lands on
      a web page (or a blank tab) instead of the app. Unnoticeable on desktop,
      "the button is broken" on a phone.
    - The hardcoded fallback pointed at the dead t.me host AND at velo_testbot,
      which is not the production bot. It now mirrors the real default. The
      fallback only fires when VITE_TELEGRAM_BOT_URL is missing from the build.
-->

<template>
  <div class="stub velo-kbd-scroll">
    <div class="stub__logo">
      <VeloLogo :size="120" />
    </div>
    <h1 class="stub__title">VELΘ</h1>
    <p class="stub__message">Пространство для практики<br />и внутреннего развития</p>
    <a :href="botUrl" class="stub__button stub__button--primary" rel="noopener">
      Открыть в Telegram
    </a>
    <p class="stub__hint">Нажмите кнопку «Открыть VELO» в чате с ботом</p>
  </div>
</template>

<script setup lang="ts">
import { VeloLogo } from '@/components/ui'

const botUrl = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://telegram.me/veloappbot'
</script>

<style scoped>
.stub {
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

.stub__logo {
  margin-bottom: var(--space-2);
}

.stub__title {
  font-family: var(--font-body);
  font-size: var(--text-2xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-4) 0;
}

.stub__message {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-8) 0;
  max-width: 280px;
  line-height: 1.5;
}

.stub__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: var(--velo-content-width);
  height: var(--velo-size-50);
  font-family: var(--font-body);
  font-size: var(--text-base);
  text-decoration: none;
  border-radius: var(--radius-full);
  border: 1px solid var(--velo-glass-border);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
  transition: opacity var(--transition-fast);
}

.stub__button:hover {
  opacity: 0.9;
}

.stub__button--primary {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.stub__hint {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  margin: var(--space-4) 0 0 0;
  max-width: 240px;
  line-height: 1.4;
}
</style>
