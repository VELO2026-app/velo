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

  FE-108: a support appeal deleted with its spam ticket (30 days past the
  verdict) leaves a delivered `open_thread__<id>` notification pointing at
  an id the list no longer carries -- that same not-found state becomes the
  «Этой переписки больше нет» screen. "Deleted with the ticket" and "never
  the caller's" are indistinguishable by design (the backend's 404 never
  says which), so the screen says neither -- it only says the conversation
  is not there to open.
-->

<template>
  <div class="user-chat">
    <div v-if="resolving" class="user-chat__center">
      <VLoader size="lg" />
    </div>

    <div v-else-if="notFound" class="user-chat__center">
      <VHeader :title="t('user.screens.userChat.title')" show-back @back="router.back()" />
      <VEmptyState
        :title="t('user.screens.userChat.gone')"
        :description="t('user.screens.userChat.goneHint')"
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

    <!-- FE-107: the support row asks «Как мы помогли?» -- the sheet is
         self-contained (the pending queue, the POST, the queue's advance);
         this wrapper only gates it on the row being support and names the
         ticket a ?rate=1 deep link brought with it. -->
    <SupportRatingSheet :active="isSupport" :preferred-ticket-id="preferredRatingTicket" />
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
import SupportRatingSheet from '@/components/shared/SupportRatingSheet.vue'
import { chatRowFor, listChats, type ChatPeer } from '@/api/chats'

const route = useRoute()
const router = useRouter()

const threadId = String(route.params.id ?? '')
const resolving = ref(true)
const notFound = ref(false)
const peer = ref<ChatPeer | null>(null)
/** BE-163: the row's `channel` is the screen's identity -- a `support`
 *  thread is titled «Поддержка VELO», never the role fallback («Мастер»). */
const isSupport = ref(false)

/** FE-107: a bell row / Telegram button named THIS ticket (`?rate=1` -- the
 *  id it travels with is the route's own). Without the flag the sheet asks
 *  on its own whenever something waits; the id is then no one's. */
const preferredRatingTicket = computed(() => (route.query.rate === '1' ? threadId : null))

const peerFallback = computed(() =>
  isSupport.value ? t('chat.supportTitle') : t('user.screens.userChat.peerFallback'),
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
