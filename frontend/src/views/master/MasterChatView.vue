<!--
  VELO Frontend -- MasterChatView (chat thread; honesty-cleanup 2026-07-12;
  REAL THREAD -- Phase 6 / T2, H-T2-UI phase «а», 2026-08-08)

  The master's side of the DM. Thin wrapper over the shared ChatThreadScreen
  (same component the student uses): resolves the peer from the comms
  operator list, hands over threadId + display props.

  Route /master/messages/:id (name 'master-chat', meta.hideTabBar), reached
  from MasterMessagesView. A deep link to a foreign/unknown id: the list
  won't contain it -> not-found state here, and the proxy 404s every thread
  route anyway (membership is checked against the local pointer, ID-11).
-->

<template>
  <div class="chat">
    <div v-if="resolving" class="chat__center">
      <VLoader size="lg" />
    </div>

    <div v-else-if="notFound" class="chat__center">
      <VHeader :title="t('masterScreens.masterChat.title')" show-back @back="router.back()" />
      <VEmptyState
        :title="t('masterScreens.masterChat.notFound')"
        :description="t('masterScreens.masterChat.notFoundHint')"
      >
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="router.back()">{{ t('ui.back') }}</VButton>
    </div>

    <ChatThreadScreen
      v-else
      :thread-id="threadId"
      :peer="peer"
      :peer-fallback="peerFallback"
      :support="isSupport"
      @back="router.back()"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import ChatThreadScreen from '@/components/shared/ChatThreadScreen.vue'
import { chatRowFor, listChats, type ChatPeer } from '@/api/chats'

const route = useRoute()
const router = useRouter()

const threadId = String(route.params.id ?? '')
const resolving = ref(true)
const notFound = ref(false)
const peer = ref<ChatPeer | null>(null)
/** BE-163: the row's `channel` is the screen's identity -- a `support`
 *  thread is titled «Поддержка VELO», never the role fallback («Ученик»). */
const isSupport = ref(false)

const peerFallback = computed(() =>
  isSupport.value ? t('chat.supportTitle') : t('masterScreens.masterChat.peerFallback'),
)

onMounted(async () => {
  try {
    const { threads } = await listChats()
    // BE-162: an old ticket's id opens the support row too (thread_ids).
    const thread = chatRowFor(threads, threadId)
    if (!thread) {
      notFound.value = true
    } else {
      peer.value = thread.peer ?? null
      isSupport.value = thread.channel === 'support'
    }
  } catch {
    peer.value = null
  } finally {
    resolving.value = false
  }
})
</script>

<style scoped>
/* Fill-mode screen (MasterShell routes master-chat into MobileLayout `fill`
   mode, which zeroes the shared rail) -- ChatThreadScreen supplies its own
   rail padding, this wrapper only stretches. */
.chat {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: 0 var(--velo-rail-pad-x, var(--space-4));
}
</style>
