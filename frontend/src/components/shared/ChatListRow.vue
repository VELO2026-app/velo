<!--
  VELO Frontend -- ChatListRow (Phase 6 / T2, H-T2-UI phase «а»; BE-163 row)

  One conversation in the chats list, shared by both roles: avatar + peer
  name + per-thread unread badge, and -- since BE-163 feeds the row its own
  `last_message` -- the message preview and the row's display time. Built on
  VAvatar/VBadge/VeloLogo; the name falls back to the wording the parent
  supplies (peer may be null -- P-1 degrades instead of breaking).

  `support` rows swap the avatar for the VELO logo and their preview speaks
  the translation states (the parent derives the wording -- the row stays
  content-agnostic).
-->

<template>
  <button type="button" class="chat-row" @click="emit('open')">
    <VeloLogo v-if="support" :size="40" class="chat-row__logo" />
    <VAvatar v-else :name="displayName" :url="avatarUrl || ''" size="md" />
    <span class="chat-row__main">
      <span class="chat-row__name">{{ displayName }}</span>
      <span v-if="preview" class="chat-row__preview">{{ preview }}</span>
    </span>
    <span class="chat-row__aside">
      <span v-if="time" class="chat-row__time">{{ time }}</span>
      <VBadge v-if="unread > 0" variant="info" class="chat-row__badge" data-testid="chat-unread">
        {{ unread }}
      </VBadge>
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { VAvatar, VBadge, VeloLogo } from '@/components/ui'
import type { ChatPeer } from '@/api/chats'

const props = defineProps<{
  peer?: ChatPeer | null
  peerFallback: string
  unread?: number
  /** BE-163: the row is the caller's own support conversation -- the VELO
   *  logo stands in for the (always null) peer avatar. */
  support?: boolean
  /** Newest-message preview, already worded by the parent (translation
   *  states included). Empty/absent = no second line. */
  preview?: string | null
  /** Row display time, pre-formatted by the parent. */
  time?: string | null
}>()

const emit = defineEmits<{ open: [] }>()

const displayName = computed(() => props.peer?.name || props.peerFallback)
const avatarUrl = computed(() => props.peer?.avatar_url ?? '')
const unread = computed(() => props.unread ?? 0)
</script>

<style scoped>
.chat-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  cursor: pointer;
  text-align: left;
}

/* The logo rides where the avatar would -- same 40px plate (VeloLogo sizes
   in px), never squashed by the row's flex competition. */
.chat-row__logo {
  flex-shrink: 0;
}

.chat-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--velo-text-primary);
  font-size: var(--text-md, 16px);
}

.chat-row__preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--velo-text-secondary);
  font-size: var(--text-sm, 14px);
}

.chat-row__aside {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
}

.chat-row__time {
  color: var(--velo-text-muted);
  font-size: var(--text-xs, 12px);
}

.chat-row__badge {
  flex-shrink: 0;
}
</style>
