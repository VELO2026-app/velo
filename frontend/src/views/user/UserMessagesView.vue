<!--
  VELO Frontend -- UserMessagesView (user messaging entry, 2026-06-30;
  REAL LIST -- Phase 6 / T2, H-T2-UI phase «а», 2026-08-08; BE-163 row shape)

  User conversations, reached from Profile ▸ «Аккаунт» ▸ «Сообщения».
  Route: /user/profile/messages (name: 'user-messages').

  The list comes from GET /api/v1/chats (BE-163 shape): one request, rows
  ordered last-message-first by the backend -- the view does not sort. Each
  row carries the P-1 `peer` block (no per-row profile lookups), the row's
  own `unread` (T-51 -- the backend fetches the whole page's counts in one
  call), `last_message` for the preview line and `channel`: a `support` row
  renders the VELO logo + «Поддержка VELO» and its preview speaks the
  translation states (utils/chatRows.ts). The list is not polled (approved
  plan §4).

  Opening a row -> 'user-chat' (/user/profile/messages/:id).
-->

<template>
  <div class="user-messages">
    <VHeader :title="t('user.screens.userMessages.title')" show-back @back="router.back()" />

    <div v-if="loading" class="user-messages__center">
      <VLoader size="lg" />
    </div>

    <div v-else-if="error" class="user-messages__center">
      <VEmptyState :title="t('chat.listLoadFailed')" :description="error">
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="load">{{ t('common.retry') }}</VButton>
    </div>

    <VEmptyState
      v-else-if="threads.length === 0"
      :title="t('user.screens.userMessages.empty.text')"
      :description="t('user.screens.userMessages.empty.hint')"
    >
      <template #icon>
        <IconMessages :size="48" />
      </template>
    </VEmptyState>

    <div v-else class="user-messages__list">
      <ChatListRow
        v-for="thread in threads"
        :key="thread.id"
        :peer="thread.peer"
        :peer-fallback="rowFallback(thread)"
        :unread="thread.unread ?? 0"
        :support="thread.channel === 'support'"
        :preview="chatRowPreview(thread)"
        :time="chatRowTime(thread)"
        @open="openThread(thread.id)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import ChatListRow from '@/components/shared/ChatListRow.vue'
import { listChats, type ChatThread } from '@/api/chats'
import { chatRowPreview, chatRowTime } from '@/utils/chatRows'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()

const loading = ref(true)
const error = ref<string | null>(null)
const threads = ref<ChatThread[]>([])

/** BE-163: a `support` row has no peer -- its name is the support title,
 *  not the role fallback («Мастер») the null-peer degrade would paint. */
function rowFallback(thread: ChatThread): string {
  return thread.channel === 'support'
    ? t('chat.supportTitle')
    : t('user.screens.userMessages.peerFallback')
}

// Badges arrive WITH the rows (T-51): the list carries `unread` per thread,
// so the second pass of per-thread calls is gone. If comms is unreachable
// the backend says so (502) and the screen offers a retry -- no badge beats
// a false one.
async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    threads.value = (await listChats()).threads
  } catch (e) {
    error.value = extractApiError(e, t('common.tryAgain'))
  }
  loading.value = false
}

function openThread(id: string): void {
  void router.push({ name: 'user-chat', params: { id } })
}

onMounted(load)
</script>

<style scoped>
.user-messages {
  display: flex;
  flex-direction: column;
}

.user-messages__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) 0;
}

.user-messages__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
