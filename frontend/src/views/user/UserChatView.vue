<!--
  VELO Frontend -- UserChatView (Phase 6 / T2, H-T2-UI phase «а», 2026-08-08)

  The student's side of the eternal DM with one master. Thin wrapper over the
  shared ChatThreadScreen: this view only resolves WHICH conversation and WHO
  the peer is, then hands over.

  Route: /user/profile/messages/:id (name 'user-chat', meta.hideTabBar --
  detail screen). Reached from the list AND from «Задать вопрос» on the
  master's public profile (which just opened/looked up the thread).

  Peer resolution: one GET /api/v1/chats and find the row -- the student's
  list is the local pointer set (small by construction, no pagination behind
  the ID-11 fence), each row carrying the P-1 peer block. A deep link to an
  id that is not ours lands in the not-found state: the proxy 404s every
  thread route for non-participants, and the list simply won't contain it.
-->

<template>
  <div class="user-chat">
    <div
      v-if="resolving"
      class="user-chat__center"
    >
      <VLoader size="lg" />
    </div>

    <div
      v-else-if="notFound"
      class="user-chat__center"
    >
      <VHeader
        title="Сообщения"
        show-back
        @back="router.back()"
      />
      <VEmptyState
        title="Переписка не найдена"
        description="Возможно, ссылка устарела"
      >
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton
        size="sm"
        @click="router.back()"
      >
        Назад
      </VButton>
    </div>

    <ChatThreadScreen
      v-else
      :thread-id="threadId"
      :peer="peer"
      peer-fallback="Мастер"
      @back="router.back()"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import ChatThreadScreen from '@/components/shared/ChatThreadScreen.vue'
import { listChats, type ChatPeer } from '@/api/chats'

const route = useRoute()
const router = useRouter()

const threadId = String(route.params.id ?? '')
const resolving = ref(true)
const notFound = ref(false)
const peer = ref<ChatPeer | null>(null)

onMounted(async () => {
  try {
    const { threads } = await listChats()
    const thread = threads.find((t) => t.id === threadId)
    if (!thread) {
      notFound.value = true
    } else {
      peer.value = thread.peer ?? null
    }
  } catch {
    // The thread screen has its own retry; a failed lookup only costs the
    // header name -- fall through with the role fallback.
    peer.value = null
  } finally {
    resolving.value = false
  }
})
</script>

<style scoped>
.user-chat {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.user-chat__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: 0 var(--velo-rail-pad-x, var(--space-4));
}
</style>
