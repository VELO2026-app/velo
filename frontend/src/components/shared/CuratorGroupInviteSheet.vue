<!--
  VELO Frontend -- CuratorGroupInviteSheet (schools FE-20 / GT P3)

  The curator's invite-link dialog, ONE component for BOTH link kinds (prop
  `kind`): POST /masters/me/curator-groups/{id}/invites mints (or returns)
  the reusable link; «Скопировать» uses the B2 clipboard pattern;
  «Отзыв ссылки» asks first -- revocation kills the token for everyone it
  was sent to, and that is not a tap to take by accident.

  503 bot_url_not_configured: the honest toast from errorMessages.ts and NO
  link -- a fabricated URL would look valid and resolve nowhere (the exact
  failure the backend raises to prevent).
-->

<template>
  <div class="cgi">
    <VModal :open="open" @close="emit('close')">
      <h3 class="cgi__title">{{ title }}</h3>

      <div v-if="loading" class="cgi__state">
        <VLoader size="lg" />
      </div>

      <template v-else-if="inviteUrl">
        <p class="cgi__hint">
          Ссылка многоразовая — вступить по ней может каждый, кому вы её перешлёте.
        </p>
        <p class="cgi__link">{{ inviteUrl }}</p>
        <div class="cgi__actions">
          <VButton variant="primary" block :loading="copying" @click="onCopy">
            Скопировать
          </VButton>
          <VButton variant="outline" block :disabled="revoking" @click="revokeConfirmOpen = true">
            Отозвать ссылку
          </VButton>
        </div>
      </template>

      <template v-else>
        <p class="cgi__hint">Не удалось получить ссылку.</p>
        <div class="cgi__actions">
          <VButton variant="outline" block @click="load">Повторить</VButton>
        </div>
      </template>
    </VModal>

    <VConfirmDialog
      :open="revokeConfirmOpen"
      title="Отозвать ссылку?"
      message="Прежняя ссылка перестанет работать для всех, у кого она есть. Новую можно будет создать в любой момент."
      confirm-label="Отозвать"
      danger
      :loading="revoking"
      @confirm="onRevokeConfirm"
      @close="revokeConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createCuratorGroupInvite, revokeCuratorGroupInvite } from '@/api/curatorGroups'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import VButton from '@/components/ui/VButton.vue'
import VConfirmDialog from '@/components/ui/VConfirmDialog.vue'
import VLoader from '@/components/ui/VLoader.vue'
import VModal from '@/components/ui/VModal.vue'

const props = defineProps<{
  open: boolean
  /** Which of the school's two reusable links this sheet mints. */
  kind: 'master' | 'student'
  groupId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const toast = useToast()

const loading = ref(false)
const inviteUrl = ref<string | null>(null)
const copying = ref(false)
const revoking = ref(false)
const revokeConfirmOpen = ref(false)

const title = computed(() =>
  props.kind === 'master' ? 'Ссылка для мастеров' : 'Ссылка для учеников',
)

// Mint on every open: repeat calls return the SAME url (idempotent by
// contract), so this doubles as the refresh after a revoke elsewhere.
// `immediate` covers a sheet mounted with open ALREADY true (the watch
// alone would miss it -- caught by the sheet's own test).
watch(
  () => props.open,
  (open) => {
    if (open) void load()
  },
  { immediate: true },
)

async function load(): Promise<void> {
  loading.value = true
  inviteUrl.value = null
  try {
    const res = await createCuratorGroupInvite(props.groupId, props.kind)
    inviteUrl.value = res.invite_url
  } catch (e) {
    // bot_url_not_configured and friends arrive here with their table
    // phrase via extractApiError; no link is shown either way.
    toast.error(extractApiError(e, 'Не удалось получить ссылку'))
  } finally {
    loading.value = false
  }
}

async function onCopy(): Promise<void> {
  if (copying.value || !inviteUrl.value) return
  copying.value = true
  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    toast.success('Ссылка скопирована')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось скопировать ссылку'))
  } finally {
    copying.value = false
  }
}

async function onRevokeConfirm(): Promise<void> {
  revoking.value = true
  try {
    await revokeCuratorGroupInvite(props.groupId, props.kind)
    revokeConfirmOpen.value = false
    toast.success('Ссылка отозвана')
    emit('close')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отозвать ссылку'))
  } finally {
    revoking.value = false
  }
}
</script>

<style scoped>
.cgi__title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-3);
}

.cgi__state {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0;
}

.cgi__hint {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin: 0 0 var(--space-2);
}

.cgi__link {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  word-break: break-all;
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin: 0 0 var(--space-3);
}

.cgi__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
