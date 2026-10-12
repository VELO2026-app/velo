<!--
  VELO Frontend -- AiConnectionsView (BE-138, MCP phase 0)

  "Подключения ИИ": the user's personal tokens for MCP clients (Claude
  Desktop, Claude Code, Cursor, ...). Create (name + scopes, all three by
  default -- owner ruling), show the token ONCE with «Скопировать», list with
  last use, revoke with a confirmation.

  THE TOKEN LIVES IN ONE PLACE: the local `createdToken` ref of this
  component, from the create response until the "shown once" dialog is
  closed, when it is set back to null. It never enters a Pinia store,
  localStorage or sessionStorage; the list carries only the prefix.

  COPY: navigator.clipboard.writeText on the tap (the SchoolInviteField /
  promo-code pattern). In a Telegram WebView it may be refused -- then a
  toast says so, and the token stays on screen as selectable text
  (user-select: all), so it can still be copied by hand.

  KILLSWITCH: the row in the profile is always shown; with MCP switched off
  the backend answers 404 not_found, and this screen says "unavailable"
  instead of a list. The frontend has no feature-flag source to hide the
  row with.

  Route: /user/profile/ai-connections (name: 'user-ai-connections')
-->

<template>
  <div class="ai-conn">
    <VHeader title="Подключения ИИ" show-back @back="router.back()" />

    <div class="ai-conn__content">
      <p class="ai-conn__intro">
        Личный токен даёт вашей нейросети (Claude, Cursor и другим клиентам MCP) доступ к вашему
        Дневнику и практикам. Не передавайте токен другим людям; ненужный -- отзовите.
      </p>

      <VLoader v-if="state === 'loading'" />

      <p v-else-if="state === 'unavailable'" class="ai-conn__notice" data-test="unavailable">
        Подключения ИИ сейчас недоступны.
      </p>

      <p v-else-if="state === 'error'" class="ai-conn__notice" data-test="load-error">
        Не удалось загрузить токены. Попробуйте позже.
      </p>

      <template v-else>
        <VButton block data-test="open-create" @click="openCreate">Создать токен</VButton>

        <p v-if="tokens.length === 0" class="ai-conn__empty" data-test="empty">Токенов пока нет.</p>

        <ul v-else class="ai-conn__list">
          <li
            v-for="t in tokens"
            :key="t.id"
            class="ai-conn__item"
            :class="{ 'ai-conn__item--revoked': t.revoked_at }"
            data-test="token-row"
          >
            <div class="ai-conn__item-main">
              <div class="ai-conn__item-name">{{ t.name }}</div>
              <div class="ai-conn__item-prefix">velo_pat_{{ t.prefix }}…</div>
              <div class="ai-conn__item-meta">{{ scopeSummary(t.scopes) }}</div>
              <div class="ai-conn__item-meta">
                Создан {{ fmt(t.created_at) }} ·
                {{ t.last_used_at ? `использован ${fmt(t.last_used_at)}` : 'ещё не использовался' }}
              </div>
              <div v-if="t.revoked_at" class="ai-conn__item-revoked">
                Отозван {{ fmt(t.revoked_at) }}
              </div>
            </div>
            <VButton
              v-if="!t.revoked_at"
              size="sm"
              variant="danger"
              data-test="revoke"
              @click="askRevoke(t)"
            >
              Отозвать
            </VButton>
          </li>
        </ul>
      </template>
    </div>

    <!-- Create, then the token shown once -- one dialog, two faces. -->
    <VModal :open="createOpen" :close-on-overlay="!createdToken" @close="closeCreate">
      <div v-if="!createdToken" class="ai-conn__form" data-test="create-form">
        <h2 class="ai-conn__title">Новый токен</h2>
        <VInput
          v-model="name"
          label="Название"
          placeholder="Например, Claude дома"
          :maxlength="100"
        />
        <div class="ai-conn__scopes">
          <VCheckbox
            v-for="s in SCOPES"
            :key="s.value"
            :model-value="scopes.includes(s.value)"
            :label="s.label"
            :data-test="`scope-${s.value}`"
            @update:model-value="toggleScope(s.value, $event)"
          />
        </div>
        <VButton
          block
          :disabled="!canCreate"
          :loading="creating"
          data-test="create"
          @click="onCreate"
        >
          Создать
        </VButton>
      </div>

      <div v-else class="ai-conn__once" data-test="token-once">
        <h2 class="ai-conn__title">Токен создан</h2>
        <p class="ai-conn__warning">Скопируйте токен сейчас -- больше мы его не покажем.</p>
        <code class="ai-conn__token" data-test="token-text">{{ createdToken }}</code>
        <VButton block variant="secondary" data-test="copy" @click="onCopy">
          <IconCopy :size="18" /> Скопировать
        </VButton>
        <VButton block data-test="done" @click="closeCreate">Готово</VButton>
      </div>
    </VModal>

    <VConfirmDialog
      :open="revokeTarget !== null"
      title="Отозвать токен?"
      :message="revokeMessage"
      confirm-label="Отозвать"
      danger
      :loading="revoking"
      @confirm="onRevoke"
      @cancel="revokeTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VCheckbox, VConfirmDialog, VInput, VLoader, VModal } from '@/components/ui'
import { IconCopy } from '@/components/icons'
import { ApiResponseError } from '@/api/client'
import { createMcpToken, listMcpTokens, revokeMcpToken } from '@/api/mcpTokens'
import type { McpScope, McpTokenItem } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { formatDate } from '@/utils/format'

const SCOPES: { value: McpScope; label: string }[] = [
  { value: 'read', label: 'Читать календарь, практики и Дневник' },
  { value: 'diary:write', label: 'Сохранять записи в Дневник' },
  { value: 'bookings:write', label: 'Записываться на практики и отменять запись' },
]

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const state = ref<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
const tokens = ref<McpTokenItem[]>([])

const createOpen = ref(false)
const name = ref('')
const scopes = ref<McpScope[]>(SCOPES.map((s) => s.value))
const creating = ref(false)
/** The token string, between the create response and closing the dialog. */
const createdToken = ref<string | null>(null)

const revokeTarget = ref<McpTokenItem | null>(null)
const revoking = ref(false)

const canCreate = computed(() => name.value.trim().length > 0 && scopes.value.length > 0)
const revokeMessage = computed(() =>
  revokeTarget.value
    ? `Нейросеть с токеном «${revokeTarget.value.name}» сразу потеряет доступ. Отменить это нельзя.`
    : '',
)

function fmt(iso: string): string {
  return formatDate(iso, authStore.user?.timezone ?? 'UTC')
}

function scopeSummary(list: McpScope[]): string {
  return SCOPES.filter((s) => list.includes(s.value))
    .map((s) => s.label)
    .join('; ')
}

function toggleScope(value: McpScope, on: boolean): void {
  scopes.value = on
    ? SCOPES.map((s) => s.value).filter((v) => v === value || scopes.value.includes(v))
    : scopes.value.filter((v) => v !== value)
}

async function load(): Promise<void> {
  try {
    tokens.value = (await listMcpTokens()).items
    state.value = 'ready'
  } catch (e) {
    state.value = e instanceof ApiResponseError && e.status === 404 ? 'unavailable' : 'error'
  }
}

function openCreate(): void {
  name.value = ''
  scopes.value = SCOPES.map((s) => s.value)
  createdToken.value = null
  createOpen.value = true
}

function closeCreate(): void {
  createOpen.value = false
  createdToken.value = null
}

async function onCreate(): Promise<void> {
  if (!canCreate.value || creating.value) return
  creating.value = true
  try {
    const res = await createMcpToken(name.value.trim(), scopes.value)
    createdToken.value = res.token
    tokens.value = [res.item, ...tokens.value]
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось создать токен'))
  } finally {
    creating.value = false
  }
}

async function onCopy(): Promise<void> {
  if (!createdToken.value) return
  try {
    await navigator.clipboard.writeText(createdToken.value)
    toast.success('Токен скопирован')
  } catch {
    toast.error('Не удалось скопировать -- выделите токен и скопируйте вручную')
  }
}

function askRevoke(t: McpTokenItem): void {
  revokeTarget.value = t
}

async function onRevoke(): Promise<void> {
  const target = revokeTarget.value
  if (!target || revoking.value) return
  revoking.value = true
  try {
    const updated = await revokeMcpToken(target.id)
    tokens.value = tokens.value.map((t) => (t.id === updated.id ? updated : t))
    toast.success('Токен отозван')
    revokeTarget.value = null
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отозвать токен'))
  } finally {
    revoking.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ai-conn__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}

.ai-conn__intro,
.ai-conn__notice,
.ai-conn__empty {
  margin: 0;
  color: var(--velo-text-secondary);
}

.ai-conn__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-conn__item {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
}

.ai-conn__item--revoked {
  opacity: 0.6;
}

.ai-conn__item-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ai-conn__item-name {
  font-weight: 600;
}

.ai-conn__item-prefix {
  font-family: monospace;
  overflow-wrap: anywhere;
}

.ai-conn__item-meta,
.ai-conn__item-revoked {
  font-size: 13px;
  color: var(--velo-text-secondary);
}

.ai-conn__form,
.ai-conn__once {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ai-conn__title {
  margin: 0;
  font-size: 18px;
}

.ai-conn__scopes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ai-conn__warning {
  margin: 0;
  font-weight: 600;
}

/* Selectable as a whole: the manual-copy fallback when the clipboard is
   refused (Telegram WebView). */
.ai-conn__token {
  display: block;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-subtle);
  font-family: monospace;
  overflow-wrap: anywhere;
  user-select: all;
  -webkit-user-select: all;
}
</style>
