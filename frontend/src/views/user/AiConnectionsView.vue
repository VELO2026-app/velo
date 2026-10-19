<!--
  VELO Frontend -- AiConnectionsView (BE-138, MCP phase 0; BE-150 layout)
  "Подключения ИИ", three blocks top to bottom (owner ruling, BE-150):
    1. «Как подключить» -- the MCP address (<API base>/mcp, utils/
       mcpServerUrl) with «Скопировать», and how to add it in claude.ai.
       When the server has no button sign-in (oauth_connect_available false)
       the instructions are not promised; the personal token is pointed at.
       No API base configured -> no address at all (fails closed).
    2. Every connection, button-made and personal, with «Отозвать».
    3. «Для разработчиков: личный токен», collapsed by default: create (name
       + scopes, all by default -- owner ruling), the token shown ONCE with
       «Скопировать» and «Скопировать как заголовок» (Bearer <token>).
  SCOPE DESCRIPTIONS come from the list response (scope_labels, BE-148): the
  backend's SCOPE_ACTIONS is the one place they are written.
  THE TOKEN LIVES IN ONE PLACE: the local `createdToken` ref of this
  component, from the create response until the "shown once" dialog is
  closed, when it is set back to null. It never enters a Pinia store,
  localStorage or sessionStorage; the list carries only the prefix.
  COPY: navigator.clipboard.writeText on the tap (the SchoolInviteField /
  promo-code pattern). In a Telegram WebView it may be refused -- then a
  toast says so, and the text stays on screen selectable (user-select:
  all), so it can still be copied by hand.
  KILLSWITCH: the row in the profile is always shown; with MCP switched off
  the backend answers 404 not_found, and this screen says "unavailable"
  instead of the blocks. The frontend has no feature-flag source to hide
  the row with.
  Route: /user/profile/ai-connections (name: 'user-ai-connections')
-->

<template>
  <div class="ai-conn">
    <VHeader :title="t('user.screens.aiConnections.title')" show-back @back="router.back()" />
    <div class="ai-conn__content">
      <VLoader v-if="state === 'loading'" />
      <p v-else-if="state === 'unavailable'" class="ai-conn__notice" data-test="unavailable">
        {{ t('user.screens.aiConnections.unavailable') }}
      </p>
      <p v-else-if="state === 'error'" class="ai-conn__notice" data-test="load-error">
        {{ t('user.screens.aiConnections.loadFailed') }}
      </p>
      <template v-else>
        <section class="ai-conn__block" data-test="connect-block">
          <h2 class="ai-conn__heading">{{ t('user.screens.aiConnections.dev.howTo') }}</h2>
          <template v-if="mcpUrl">
            <p class="ai-conn__text">{{ t('user.screens.aiConnections.dev.addressLabel') }}</p>
            <code class="ai-conn__token" data-test="mcp-url">{{ mcpUrl }}</code>
            <VButton block variant="secondary" data-test="copy-url" @click="onCopyUrl">
              <IconCopy :size="18" /> {{ t('user.screens.aiConnections.copy') }}
            </VButton>
            <p v-if="oauthAvailable" class="ai-conn__text" data-test="connect-howto">
              {{ t('user.screens.aiConnections.connectHowto') }}
            </p>
            <p v-else class="ai-conn__notice" data-test="no-button-connect">
              {{ t('user.screens.aiConnections.noButtonConnect') }}
            </p>
          </template>
          <p v-else class="ai-conn__notice" data-test="no-base-url">
            {{ t('user.screens.aiConnections.noBaseUrl') }}
          </p>
        </section>

        <section class="ai-conn__block" data-test="connections-block">
          <h2 class="ai-conn__heading">
            {{ t('user.screens.aiConnections.section.connections') }}
          </h2>
          <p v-if="tokens.length === 0" class="ai-conn__empty" data-test="empty">
            {{ t('user.screens.aiConnections.empty') }}
          </p>
          <ul v-else class="ai-conn__list">
            <li
              v-for="token in tokens"
              :key="token.id"
              class="ai-conn__item"
              :class="{ 'ai-conn__item--revoked': token.revoked_at }"
              data-test="token-row"
            >
              <div class="ai-conn__item-main">
                <div class="ai-conn__item-name">{{ token.name }}</div>
                <!-- BE-141: an OAuth connection's prefix is its refresh token's,
                     rotating and meaningless here -- say what it is instead. -->
                <div v-if="token.kind === 'personal'" class="ai-conn__item-prefix">
                  velo_pat_{{ token.prefix }}…
                </div>
                <div v-else class="ai-conn__item-prefix" data-test="oauth-kind">
                  { t('user.screens.aiConnections.oauthConnected') }
                </div>
                <div class="ai-conn__item-meta">{{ scopeSummary(token.scopes) }}</div>
                <div class="ai-conn__item-meta">
                  {{
                    t('user.screens.aiConnections.createdAt', { created: fmt(token.created_at) })
                  }}
                  {{
                    token.last_used_at
                      ? t('user.screens.aiConnections.used.at', { at: fmt(token.last_used_at) })
                      : t('user.screens.aiConnections.neverUsed')
                  }}
                </div>
                <div v-if="token.revoked_at" class="ai-conn__item-revoked">
                  {{ t('user.screens.aiConnections.revokedAt', { at: fmt(token.revoked_at) }) }}
                </div>
              </div>
              <VButton
                v-if="!token.revoked_at"
                size="sm"
                variant="danger"
                data-test="revoke"
                @click="askRevoke(token)"
              >
                {{ t('user.screens.aiConnections.revoke') }}
              </VButton>
            </li>
          </ul>
        </section>

        <section class="ai-conn__block" data-test="dev-block">
          <VAccordion :title="t('user.screens.aiConnections.devTitle')">
            <div class="ai-conn__dev" data-test="dev-body">
              <p class="ai-conn__text">
                {{ t('user.screens.aiConnections.devNote') }}
              </p>
              <VButton block data-test="open-create" @click="openCreate">{{
                t('user.screens.aiConnections.create.cta')
              }}</VButton>
            </div>
          </VAccordion>
        </section>
      </template>
    </div>
    <!-- Create, then the token shown once -- one dialog, two faces. -->
    <VModal :open="createOpen" :close-on-overlay="!createdToken" @close="closeCreate">
      <div v-if="!createdToken" class="ai-conn__form" data-test="create-form">
        <h2 class="ai-conn__title">{{ t('user.screens.aiConnections.create.title') }}</h2>
        <VInput
          v-model="name"
          :label="t('user.screens.aiConnections.form.name')"
          :placeholder="t('user.screens.aiConnections.form.namePlaceholder')"
          :maxlength="100"
        />
        <div class="ai-conn__scopes">
          <VCheckbox
            v-for="s in scopeLabels"
            :key="s.scope"
            :model-value="scopes.includes(s.scope)"
            :label="s.label"
            :data-test="`scope-${s.scope}`"
            @update:model-value="toggleScope(s.scope, $event)"
          />
        </div>
        <VButton
          block
          :disabled="!canCreate"
          :loading="creating"
          data-test="create"
          @click="onCreate"
        >
          {{ t('user.screens.aiConnections.createSubmit') }}
        </VButton>
      </div>

      <div v-else class="ai-conn__once" data-test="token-once">
        <h2 class="ai-conn__title">{{ t('user.screens.aiConnections.toast.created') }}</h2>
        <p class="ai-conn__warning">{{ t('user.screens.aiConnections.create.copyHint') }}</p>
        <code class="ai-conn__token" data-test="token-text">{{ createdToken }}</code>
        <VButton block variant="secondary" data-test="copy" @click="onCopy">
          <IconCopy :size="18" /> {{ t('user.screens.aiConnections.copy') }}
        </VButton>
        <VButton block variant="secondary" data-test="copy-header" @click="onCopyHeader">
          <IconCopy :size="18" /> {{ t('user.screens.aiConnections.copyAsHeader') }}
        </VButton>
        <VButton block data-test="done" @click="closeCreate">{{
          t('user.screens.aiConnections.create.done')
        }}</VButton>
      </div>
    </VModal>

    <VConfirmDialog
      :open="revokeTarget !== null"
      :title="t('user.screens.aiConnections.revoke.confirmTitle')"
      :message="revokeMessage"
      :confirm-label="t('user.screens.aiConnections.revoke.cta')"
      danger
      :loading="revoking"
      @confirm="onRevoke"
      @cancel="revokeTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VAccordion,
  VButton,
  VCheckbox,
  VConfirmDialog,
  VInput,
  VLoader,
  VModal,
} from '@/components/ui'
import { IconCopy } from '@/components/icons'
import { ApiResponseError } from '@/api/client'
import { createMcpToken, listMcpTokens, revokeMcpToken } from '@/api/mcpTokens'
import type { McpScope, McpScopeLabel, McpTokenItem } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { formatDate } from '@/utils/format'
import { bearerHeaderValue, mcpServerUrl } from '@/utils/mcpServerUrl'

/** <API base>/mcp, or null when no base is configured (fails closed). */
const mcpUrl = mcpServerUrl(import.meta.env.VITE_API_BASE_URL)

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const state = ref<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
const tokens = ref<McpTokenItem[]>([])
/** Scope descriptions, in canonical order, from the list response (BE-148). */
const scopeLabels = ref<McpScopeLabel[]>([])
/** The server lets an AI client connect with the button (BE-150). */
const oauthAvailable = ref(false)

const createOpen = ref(false)
const name = ref('')
const scopes = ref<McpScope[]>([])
const creating = ref(false)
/** The token string, between the create response and closing the dialog. */
const createdToken = ref<string | null>(null)

const revokeTarget = ref<McpTokenItem | null>(null)
const revoking = ref(false)

const canCreate = computed(() => name.value.trim().length > 0 && scopes.value.length > 0)
const revokeMessage = computed(() =>
  revokeTarget.value
    ? t('user.screens.aiConnections.revokeConfirmText', { name: revokeTarget.value.name })
    : '',
)

function fmt(iso: string): string {
  return formatDate(iso, authStore.user?.timezone ?? 'UTC')
}

function allScopes(): McpScope[] {
  return scopeLabels.value.map((s) => s.scope)
}

function scopeSummary(list: McpScope[]): string {
  return scopeLabels.value
    .filter((s) => list.includes(s.scope))
    .map((s) => s.label)
    .join('; ')
}

function toggleScope(value: McpScope, on: boolean): void {
  scopes.value = on
    ? allScopes().filter((v) => v === value || scopes.value.includes(v))
    : scopes.value.filter((v) => v !== value)
}

async function load(): Promise<void> {
  try {
    const res = await listMcpTokens()
    tokens.value = res.items
    scopeLabels.value = res.scope_labels
    oauthAvailable.value = res.oauth_connect_available
    state.value = 'ready'
  } catch (e) {
    state.value = e instanceof ApiResponseError && e.status === 404 ? 'unavailable' : 'error'
  }
}

function openCreate(): void {
  name.value = ''
  scopes.value = allScopes()
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
    toast.error(extractApiError(e, t('user.screens.aiConnections.toast.createFailed')))
  } finally {
    creating.value = false
  }
}

async function copy(text: string, done: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error(t('user.screens.aiConnections.toast.copyFailedHint', { what }))
  }
}

async function onCopy(): Promise<void> {
  if (!createdToken.value) return
  await copy(
    createdToken.value,
    t('user.screens.aiConnections.toast.copied'),
    t('user.screens.aiConnections.copy.entityToken'),
  )
}

/** For clients where the header value is typed whole (BE-150). */
async function onCopyHeader(): Promise<void> {
  if (!createdToken.value) return
  await copy(
    bearerHeaderValue(createdToken.value),
    t('user.screens.aiConnections.copy.headerValue'),
    t('user.screens.aiConnections.copy.entityToken'),
  )
}

async function onCopyUrl(): Promise<void> {
  if (!mcpUrl) return
  await copy(
    mcpUrl,
    t('user.screens.aiConnections.toast.addressCopied'),
    t('user.screens.aiConnections.copy.entityAddress'),
  )
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
    toast.success(t('user.screens.aiConnections.toast.revoked'))
    revokeTarget.value = null
  } catch (e) {
    toast.error(extractApiError(e, t('user.screens.aiConnections.toast.revokeFailed')))
  } finally {
    revoking.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ai-conn__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ai-conn__heading {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.ai-conn__text {
  margin: 0;
  color: var(--velo-text-secondary);
}

.ai-conn__dev {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ai-conn__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}

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
