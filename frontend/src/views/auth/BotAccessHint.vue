<!--
  VELO Frontend -- Bot access hint (Standalone phase 3, item 3)

  Shown once, right after a browser sign-in that did NOT give the bot the
  right to write to the person (Telegram's own consent on its sign-in page,
  scope telegram:bot_access). Without that right booking notifications do
  not reach the person in Telegram. The hint is not stored anywhere: the
  next launch does not show it again (useAuth.ts, botAccessHint).

  It can be wrong: someone who pressed Start in the bot long ago already
  receives messages, yet Telegram reports this sign-in alone. The wording is
  conditional for that reason.
-->

<template>
  <div class="bot-hint" role="status">
    <p class="bot-hint__text">
      {{ t('auth.botHint.text') }}
    </p>
    <div class="bot-hint__actions">
      <a :href="botUrl" class="bot-hint__open" rel="noopener" @click="$emit('close')">
        {{ t('auth.botHint.open') }}
      </a>
      <button type="button" class="bot-hint__close" @click="$emit('close')">
        {{ t('auth.botHint.dismiss') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { INSTANCE } from '@/platform/instance'
defineEmits<{ close: [] }>()

// Same link and same fallback as TelegramStubView (a universal link: same
// tab, direct gesture -- see that file's header).
const botUrl = INSTANCE.telegramBotUrl
</script>

<style scoped>
.bot-hint {
  position: fixed;
  left: var(--space-5);
  right: var(--space-5);
  bottom: calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
  z-index: var(--z-popup);
  max-width: var(--velo-content-width);
  margin: 0 auto;
  padding: var(--space-4) var(--space-5);
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  box-shadow: var(--velo-shadow-glow);
  text-align: center;
}

.bot-hint__text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  line-height: 1.4;
  margin: 0 0 var(--space-4) 0;
}

.bot-hint__actions {
  display: flex;
  gap: var(--space-2);
}

.bot-hint__open,
.bot-hint__close {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--velo-size-50);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  border-radius: var(--radius-full);
  text-decoration: none;
  cursor: pointer;
}

.bot-hint__open {
  background: var(--velo-primary);
  color: var(--velo-white);
  border: none;
}

.bot-hint__close {
  background: transparent;
  color: var(--velo-text-primary);
  border: 1px solid var(--velo-glass-border);
}
</style>
