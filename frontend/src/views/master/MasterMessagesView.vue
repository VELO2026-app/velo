<!--
  VELO Frontend -- MasterMessagesView (messages list, 2026-06-13;
  REAL LIST -- Phase 6 / T2, H-T2-UI phase «а», 2026-08-08; BE-163 row shape)

  Route /master/messages (from the profile hub's «Сообщения» row). The list
  comes from GET /api/v1/chats (BE-163 shape, one request): rows ordered
  last-message-first, each carrying the P-1 `peer` block -- the client may
  be nobody's student (pre-sale channel), so this is the ONLY way a name
  arrives; peer=null degrades to «Ученик». Alongside the DMs the master now
  also sees HIS own support conversation (channel `support` -- VELO logo +
  «Поддержка VELO», preview speaks the translation states via
  utils/chatRows.ts) and the DMs he opened with other masters as a client.
  The list itself is not polled (approved plan §4).
-->

<template>
  <div class="messages">
    <VHeader :title="t('masterScreens.masterMessages.title')" show-back @back="router.back()" />

    <div v-if="loading" class="messages__center">
      <VLoader size="lg" />
    </div>

    <div v-else-if="error" class="messages__center">
      <VEmptyState :title="t('chat.listLoadFailed')" :description="error">
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton size="sm" @click="load">{{ t('common.retry') }}</VButton>
    </div>

    <VEmptyState
      v-else-if="threads.length === 0"
      :title="t('masterScreens.masterMessages.empty.text')"
      :description="t('masterScreens.masterMessages.empty.hint')"
    >
      <template #icon>
        <IconMessages :size="48" />
      </template>
    </VEmptyState>

    <div v-else class="messages__list">
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

// Badges arrive WITH the rows (T-51): the list carries `unread` per thread,
// so there is no second pass and nothing to hold them in. DM rows a master
// gets are always his, so the key is there -- the `?? 0` at the call site is
// the type's optionality, not a state this screen can reach on a `chat` row.
/** BE-163: a `support` row has no peer -- its name is the support title,
 *  not the role fallback («Ученик») the null-peer degrade would paint. */
function rowFallback(thread: ChatThread): string {
  return thread.channel === 'support'
    ? t('chat.supportTitle')
    : t('masterScreens.masterMessages.peerFallback')
}

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
  void router.push({ name: 'master-chat', params: { id } })
}

onMounted(load)
</script>

<style scoped>
.messages {
  display: flex;
  flex-direction: column;
}

.messages__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) 0;
}

.messages__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
