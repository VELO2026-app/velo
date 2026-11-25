<!--
  VELO Frontend -- MasterInviteModal (FE-262)

  The "Invite a master" dialog of the console masters list: one button mints
  a one-time link (POST /admin/masters/invite) and the dialog shows it with a
  copy button. The link is generic -- it works for whoever opens it first --
  and each press mints a fresh one, replacing the shown link.

  Error contract: `bot_url_not_configured` (503) is a server setup gap, told
  with its own message; any other failure gets the generic one.
-->

<template>
  <VModal :open="open" @close="emit('close')">
    <div class="invite-modal" data-testid="master-invite-modal">
      <h2 class="invite-modal__title">{{ t('adminScreens.adminMasterInvite.title') }}</h2>
      <p class="invite-modal__text">{{ t('adminScreens.adminMasterInvite.intro') }}</p>

      <div v-if="inviteLink" class="invite-modal__result">
        <span class="invite-modal__caption">{{
          t('adminScreens.adminMasterInvite.linkReady')
        }}</span>
        <p class="invite-modal__link" data-testid="master-invite-link">{{ inviteLink }}</p>
        <p class="invite-modal__hint">
          {{ t('adminScreens.adminMasterInvite.oneTimeLinkExpiryHint') }}
        </p>
      </div>

      <div class="invite-modal__actions">
        <VButton v-if="inviteLink" variant="secondary" @click="onCopy">{{
          t('adminScreens.adminMasterInvite.copy')
        }}</VButton>
        <VButton variant="primary" :loading="creating" @click="onCreate">{{
          t('adminScreens.adminMasterInvite.create')
        }}</VButton>
      </div>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, watch } from 'vue'
import { VButton, VModal } from '@/components/ui'
import { inviteMaster } from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import { errorMessage, extractApiError } from '@/composables/useApiError'
import { useAdminMutation } from '@/composables/queries/admin'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  /** Whether the dialog is open. */
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const toast = useToast()
const creating = ref(false)
const inviteLink = ref('')
// No list shows invites: the mutation row invalidates nothing.
const invite = useAdminMutation('inviteMaster', () => inviteMaster())

// A link belongs to one opening: reopening starts from the form again.
watch(
  () => props.open,
  (open) => {
    if (open) inviteLink.value = ''
  },
)

async function onCreate(): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    const res = await invite.mutateAsync()
    inviteLink.value = res.invite_link
  } catch (e) {
    if (e instanceof ApiResponseError && e.code === 'bot_url_not_configured') {
      toast.error(errorMessage('bot_url_not_configured'))
    } else {
      toast.error(extractApiError(e, t('adminScreens.adminMasterInvite.toast.linkCreateFailed')))
    }
  } finally {
    creating.value = false
  }
}

async function onCopy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    toast.success(t('common.linkCopied'))
  } catch {
    toast.error(t('adminScreens.adminMasterInvite.toast.copyFailed'))
  }
}
</script>

<style scoped>
.invite-modal {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: min(480px, 100%);
  padding: var(--space-2);
}

.invite-modal__title {
  margin: 0;
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.invite-modal__text,
.invite-modal__hint {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.invite-modal__result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border-radius: var(--velo-radius-12);
  background: var(--velo-bg-subtle);
}

.invite-modal__caption {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.invite-modal__link {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  word-break: break-all;
}

.invite-modal__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
