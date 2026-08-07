<!--
  VELO Frontend -- UserMessagesView (user messaging entry, 2026-06-30;
  REAL LIST -- Phase 6 / T2, H-T2-UI phase «а», 2026-08-08)

  User ↔ master conversations, reached from Profile ▸ «Аккаунт» ▸ «Сообщения».
  Route: /user/profile/messages (name: 'user-messages').

  The honest stub is retired: the T2 chat proxy is live. The list comes from
  GET /api/v1/chats -- for a student that is the LOCAL pointer list (ID-11;
  created_at-ordered, no comms round-trip) with the P-1 `peer` block, so no
  per-row profile lookups. Per-thread unread badges are individual
  unread-count calls on mount (approved plan §4: the list itself is NOT
  polled; activity ordering/badges-in-list is behind the ID-11 trigger).

  Opening a row -> 'user-chat' (/user/profile/messages/:id). Visual restyle
  to the «3 Students» design is phase «б».
-->

<template>
  <div class="user-messages">
    <VHeader
      title="Сообщения"
      show-back
      @back="router.back()"
    />

    <div
      v-if="loading"
      class="user-messages__center"
    >
      <VLoader size="lg" />
    </div>

    <div
      v-else-if="error"
      class="user-messages__center"
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
      title="Здесь появятся ваши переписки с мастерами"
      description="Откройте профиль мастера и задайте вопрос"
    >
      <template #icon>
        <IconMessages :size="48" />
      </template>
    </VEmptyState>

    <div
      v-else
      class="user-messages__list"
    >
      <ChatListRow
        v-for="t in threads"
        :key="t.id"
        :peer="t.peer"
        peer-fallback="Мастер"
        :unread="unreadByThread[t.id] ?? 0"
        @open="openThread(t.id)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import { IconMessages } from '@/components/icons'
import ChatListRow from '@/components/shared/ChatListRow.vue'
import { getChatUnreadCount, listChats, type ChatThread } from '@/api/chats'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()

const loading = ref(true)
const error = ref<string | null>(null)
const threads = ref<ChatThread[]>([])
const unreadByThread = reactive<Record<string, number>>({})

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    threads.value = (await listChats()).threads
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
    loading.value = false
    return
  }
  loading.value = false

  // Badges arrive after the rows: a failed count silently stays 0 -- the
  // badge is a courtesy, never a reason to break the list.
  await Promise.all(
    threads.value.map(async (t) => {
      try {
        unreadByThread[t.id] = (await getChatUnreadCount(t.id)).unread
      } catch {
        unreadByThread[t.id] = 0
      }
    }),
  )
}

function openThread(id: string): void {
  router.push({ name: 'user-chat', params: { id } })
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
