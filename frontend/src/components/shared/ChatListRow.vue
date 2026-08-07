<!--
  VELO Frontend -- ChatListRow (Phase 6 / T2, H-T2-UI phase «а»)

  One conversation in the chats list, shared by both roles: avatar + peer
  name + per-thread unread badge. Built on VAvatar/VBadge; the name falls
  back to the role wording the parent supplies (peer may be null -- P-1
  degrades instead of breaking).
-->

<template>
  <button
    type="button"
    class="chat-row"
    @click="emit('open')"
  >
    <VAvatar
      :name="displayName"
      :url="avatarUrl || ''"
      size="md"
    />
    <span class="chat-row__name">{{ displayName }}</span>
    <VBadge
      v-if="unread > 0"
      variant="info"
      class="chat-row__badge"
      data-testid="chat-unread"
    >
      {{ unread }}
    </VBadge>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { VAvatar, VBadge } from '@/components/ui'
import type { ChatPeer } from '@/api/chats'

const props = defineProps<{
  peer?: ChatPeer | null
  peerFallback: string
  unread?: number
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

.chat-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--velo-text-primary);
  font-size: var(--text-md, 16px);
}

.chat-row__badge {
  flex-shrink: 0;
}
</style>
