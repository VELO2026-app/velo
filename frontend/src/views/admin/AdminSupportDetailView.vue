<!--
  VELO Frontend -- AdminSupportDetailView (B34, PROMPT №713)

  One support thread: feed + reply. Page shell reused from AdminReportDetailView
  (VHeader + content sections, plain page scroll) -- no new layout, no .tmp/
  preview needed (say-so-and-proceed branch). The message bubbles/composer
  visual language is copied from ChatThreadScreen.vue's markup+CSS (a bubble
  is a bubble everywhere in this app) WITHOUT reusing that component: it is
  hardwired to api/chats.ts (a different backend contract -- DM threads, not
  admin-scoped section threads) and refactoring it to accept a pluggable API
  would be a shared-component change well past this task's minimal scope.

  DELIBERATELY NOT BUILT (scope trim, stated not silent): 12s polling like
  ChatThreadScreen has. "Read the feed, reply" does not ask for a live chat;
  a manual "Обновить" affordance covers the same need at a fraction of the
  complexity (no visibility listener, no near-bottom tracking, no timer
  teardown). Also not built: mark-read/unread tracking for admins -- see
  AdminSupportView's own header for why comms' per-participant unread-count
  has no meaning for a thread nobody has claimed yet.

  CLAIM IS WRITE-AUTHZ, MADE LEGIBLE. comms' can_post_message admits only the
  thread's client or its ASSIGNEE (no supervisor bypass) -- an admin who has
  not claimed gets comms' own 403 on a reply (forwarded, not swallowed; see
  backend/app/core/comms.py's forward_403). Rather than let that surprise the
  admin mid-type, the claim state gates the composer itself: unclaimed or
  claimed-by-someone-else hides the composer behind a notice, reusing the
  established peach warning-panel convention (ReportUserSheet.vue's
  --velo-warning-bg notice) instead of inventing new visual language.
-->

<template>
  <div class="support-detail">
    <VHeader :title="headerTitle" show-back @back="router.back()" />

    <div class="support-detail__content">
      <div v-if="loadingThread" class="support-detail__loader">
        <VLoader size="lg" />
      </div>

      <VEmptyState
        v-else-if="threadError"
        icon="warning"
        title="Ошибка загрузки"
        :description="threadError"
      >
        <VButton size="sm" variant="outline" @click="loadThread">Повторить</VButton>
      </VEmptyState>

      <template v-else-if="thread">
        <div class="support-detail__header">
          <VBadge :variant="triageBadge.variant">{{ triageBadge.label }}</VBadge>
          <span v-if="thread.title" class="support-detail__topic">{{ thread.title }}</span>
        </div>

        <!-- Claim notice: shown whenever the caller is NOT the assignee, so
             "why can't I type" is answered before it is asked. -->
        <div v-if="!canReply" class="support-detail__claim-panel">
          <p class="support-detail__claim-text">{{ claimPanelText }}</p>
          <VButton
            v-if="!thread.assignee"
            variant="primary"
            size="sm"
            :loading="claiming"
            @click="onClaim"
          >
            Взять в работу
          </VButton>
        </div>

        <!-- Feed -->
        <div v-if="loadingMessages" class="support-detail__loader">
          <VLoader size="lg" />
        </div>
        <VEmptyState
          v-else-if="messagesError"
          icon="warning"
          title="Не удалось загрузить сообщения"
          :description="messagesError"
        >
          <VButton size="sm" variant="outline" @click="loadMessages">Повторить</VButton>
        </VEmptyState>
        <template v-else>
          <div class="support-detail__feed">
            <div v-if="messages.length === 0" class="support-detail__empty">
              Сообщений пока нет.
            </div>
            <div
              v-for="m in messages"
              :key="m.id"
              class="support-detail__row"
              :class="{ 'support-detail__row--mine': m.sender === myId }"
            >
              <div
                class="support-detail__bubble"
                :class="{ 'support-detail__bubble--mine': m.sender === myId }"
              >
                <div class="support-detail__body">{{ m.body }}</div>
                <div class="support-detail__time">{{ formatTime(m.created_at) }}</div>
              </div>
            </div>
            <button type="button" class="support-detail__refresh" @click="loadMessages">
              Обновить
            </button>
          </div>

          <!-- Composer: only when the caller may actually post. -->
          <div v-if="canReply" class="support-detail__composer">
            <div class="support-detail__input">
              <VTextarea
                v-model="draft"
                placeholder="Ответ…"
                :rows="1"
                autogrow
                maxlength="4000"
                :disabled="sending"
              />
            </div>
            <VButton
              variant="primary"
              size="sm"
              :disabled="sending || !draft.trim()"
              :loading="sending"
              @click="onSend"
            >
              Отправить
            </VButton>
          </div>
        </template>
      </template>

      <div v-else class="support-detail__not-found">
        <VEmptyState
          icon="notfound"
          title="Обращение не найдено"
          description="Вернитесь к списку обращений"
        />
        <VButton variant="outline" block @click="router.back()">Назад</VButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VBadge, VButton, VTextarea, VEmptyState, VLoader } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import {
  listAdminSupportThreads,
  getAdminSupportMessages,
  sendAdminSupportReply,
  claimSupportThread,
  type SupportThread,
  type SupportMessage,
} from '@/api/support'
import { extractApiError } from '@/composables/useApiError'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const threadId = route.params.id as string
const myId = computed(() => authStore.user?.id ?? '')

const thread = ref<SupportThread | null>(null)
const loadingThread = ref(false)
const threadError = ref<string | null>(null)

const messages = ref<SupportMessage[]>([])
const loadingMessages = ref(false)
const messagesError = ref<string | null>(null)

const draft = ref('')
const sending = ref(false)
const claiming = ref(false)

const headerTitle = computed(() => thread.value?.opener?.name ?? 'Обращение')
const canReply = computed(() => !!thread.value && thread.value.assignee === myId.value)

const triageBadge = computed<{ variant: 'warning' | 'success' | 'info'; label: string }>(() => {
  const t = thread.value
  if (!t) return { variant: 'info', label: '' }
  if (t.status === 'resolved') return { variant: 'success', label: 'Решено' }
  if (t.status === 'closed') return { variant: 'info', label: 'Закрыто' }
  if (!t.assignee) return { variant: 'warning', label: 'Не взято' }
  if (t.assignee === myId.value) return { variant: 'success', label: 'У меня' }
  return { variant: 'info', label: 'Занято' }
})

const claimPanelText = computed(() => {
  if (!thread.value?.assignee) {
    return 'Обращение не закреплено. Возьмите его в работу, чтобы отвечать.'
  }
  return 'Обращение уже закреплено за другим администратором — ответить может только он.'
})

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

async function loadThread(): Promise<void> {
  const stateData = (history.state as { thread?: SupportThread }).thread
  if (stateData && stateData.id === threadId) {
    thread.value = stateData
    threadError.value = null
    return
  }
  // No (or stale) hand-off -- e.g. a direct link/refresh. There is no
  // "get one thread" endpoint (comms itself has none), so the admin list
  // is re-fetched and searched by id, same fallback MasterChatView.vue
  // uses for the DM equivalent.
  loadingThread.value = true
  threadError.value = null
  try {
    const page = await listAdminSupportThreads(100)
    thread.value = page.threads.find((t) => t.id === threadId) ?? null
  } catch (e) {
    threadError.value = extractApiError(e, 'Ошибка загрузки обращения')
  } finally {
    loadingThread.value = false
  }
}

async function loadMessages(): Promise<void> {
  loadingMessages.value = true
  messagesError.value = null
  try {
    const page = await getAdminSupportMessages(threadId)
    messages.value = [...page.messages].reverse()
  } catch (e) {
    messagesError.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loadingMessages.value = false
  }
}

async function onClaim(): Promise<void> {
  claiming.value = true
  try {
    const result = await claimSupportThread(threadId)
    if (thread.value) thread.value = { ...thread.value, assignee: result.thread.assignee }
    if (result.claimed) toast.success('Обращение закреплено за вами')
    else toast.error('Уже взято другим администратором')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось закрепить обращение'))
  } finally {
    claiming.value = false
  }
}

async function onSend(): Promise<void> {
  const body = draft.value.trim()
  if (!body || sending.value) return
  sending.value = true
  try {
    const sent = await sendAdminSupportReply(threadId, body)
    messages.value = [...messages.value, sent]
    draft.value = ''
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить ответ'))
  } finally {
    sending.value = false
  }
}

onMounted(async () => {
  await loadThread()
  await loadMessages()
})
</script>

<style scoped>
.support-detail {
  min-height: 100%;
}

.support-detail__content {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.support-detail__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.support-detail__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.support-detail__topic {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Peach warning panel, same convention as ReportUserSheet.vue's support
   notice: --velo-warning-bg, no icon, --velo-peach-500 text. */
.support-detail__claim-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  background: var(--velo-warning-bg);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
}

.support-detail__claim-text {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--velo-peach-500);
  line-height: 1.5;
}

.support-detail__feed {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.support-detail__empty {
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) 0;
}

.support-detail__row {
  display: flex;
  justify-content: flex-start;
}
.support-detail__row--mine {
  justify-content: flex-end;
}

.support-detail__bubble {
  max-width: 78%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
  word-break: break-word;
}
.support-detail__bubble--mine {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.support-detail__body {
  white-space: pre-wrap;
  font-size: var(--text-sm);
}

.support-detail__time {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  opacity: 0.6;
  text-align: right;
}

.support-detail__refresh {
  align-self: center;
  margin-top: var(--space-2);
  background: none;
  border: none;
  color: var(--velo-primary);
  font-size: var(--text-xs);
  text-decoration: underline;
  cursor: pointer;
}

.support-detail__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.support-detail__input {
  flex: 1;
  min-width: 0;
}

.support-detail__not-found {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
