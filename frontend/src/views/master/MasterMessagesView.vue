<!--
  VELO Frontend -- MasterMessagesView (messages list, 2026-06-13;
  REAL LIST -- Phase 6 / T2, H-T2-UI phase «а», 2026-08-08)

  Master ↔ student conversations. Route /master/messages (from the profile
  hub's «Сообщения» row). The honest stub is retired: the T2 chat proxy is
  live. The list is the comms operator-scoped one (activity-ordered,
  authoritative) passed through GET /api/v1/chats, each thread enriched with
  the P-1 `peer` block -- the client may be nobody's student (pre-sale
  channel), so this is the ONLY way a name arrives. peer=null degrades to
  «Ученик». Unread badges are per-thread unread-count calls on mount; the
  list itself is not polled (approved plan §4). Restyle -- phase «б».
-->

<template>
  <div class="messages">
    <VHeader
      title="Сообщения"
      show-back
      @back="router.back()"
    />

    <div
      v-if="loading"
      class="messages__center"
    >
      <VLoader size="lg" />
    </div>

    <div
      v-else-if="error"
      class="messages__center"
    >
      <VEmptyState
        title="Не удалось загрузить"
        :description="error"
      >
        <template #icon>
          <IconMessages :size="48" />
        </template>
      </VEmptyState>
      <VButton
        size="sm"
        @click="load"
      >
        Повторить
      </VButton>
    </div>

    <VEmptyState
      v-else-if="threads.length === 0"
      title="Здесь появятся переписки с учениками"
      description="Ученики пишут вам со страницы вашего профиля"
    >
      <template #icon>
        <IconMessages :size="48" />
      </template>
    </VEmptyState>

    <div
      v-else
      class="messages__list"
    >
      <ChatListRow
        v-for="t in threads"
        :key="t.id"
        :peer="t.peer"
        peer-fallback="Ученик"
        :unread="t.unread ?? 0"
        @open="openThread(t.id)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import ChatListRow from '@/components/shared/ChatListRow.vue'
import { listChats, type ChatThread } from '@/api/chats'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()

const loading = ref(true)
const error = ref<string | null>(null)
const threads = ref<ChatThread[]>([])

// Badges arrive WITH the rows (T-51): the list carries `unread` per thread,
// so there is no second pass and nothing to hold them in. A row without the
// key is one this master takes no part in -- an unclaimed support thread in
// the shared pool -- and it renders with no badge rather than a zero.
async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    threads.value = (await listChats()).threads
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  }
  loading.value = false
}

function openThread(id: string): void {
  router.push({ name: 'master-chat', params: { id } })
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
