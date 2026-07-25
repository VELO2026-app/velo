<!--
  VELO Frontend -- AdminMasterInviteView (Batch-INVITE, generic link)

  Standalone admin screen «Пригласить мастера» (admin-master-invite), reached
  from the «Мастера» tab. Header (back + title) -> form-card (section
  «ОДНОРАЗОВАЯ ССЫЛКА», «Создать ссылку») -> result-card (the composed
  t.me/… deeplink + «Скопировать» via the B2 clipboard pattern).

  The link is GENERIC (no target): it works for any authenticated opener
  until the first claim burns it. Each «Создать ссылку» mints a fresh link
  and replaces the result card in place.

  Error contract (machine codes from POST /admin/masters/invite):
    - bot_url_not_configured (503) -> toast (server-side ops gap)
-->

<template>
  <div class="invite">
    <header class="invite__top">
      <VBackButton @click="router.back()" />
      <span class="invite__title">Пригласить мастера</span>
    </header>

    <!-- Form card -->
    <VCard class="invite__card">
      <span class="invite__section-title">ОДНОРАЗОВАЯ ССЫЛКА</span>
      <p class="invite__desc">
        Создайте ссылку и отправьте её будущему мастеру. Она одноразовая:
        сработает у первого, кто её откроет, — после этого погашается.
      </p>

      <VButton
        variant="primary"
        block
        :loading="creating"
        @click="onCreate"
      >
        Создать ссылку
      </VButton>
    </VCard>

    <!-- Result card (replaced in place on re-generate) -->
    <VCard v-if="inviteLink" class="invite__card">
      <span class="invite__section-title">ССЫЛКА ГОТОВА</span>
      <p class="invite__link">{{ inviteLink }}</p>
      <VButton variant="secondary" block @click="onCopy">Скопировать</VButton>
      <p class="invite__caption">одноразовая · действует до погашения</p>
    </VCard>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VCard, VButton } from '@/components/ui'
import { inviteMaster } from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

const creating = ref(false)
const inviteLink = ref('')

async function onCreate(): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    const res = await inviteMaster()
    inviteLink.value = res.invite_link
  } catch (e) {
    if (e instanceof ApiResponseError && e.code === 'bot_url_not_configured') {
      // Server misconfiguration (telegram_bot_url unset), not something the
      // admin can act on beyond reporting it — the raw backend string ("...is
      // not configured") is not a human message. Deliberately does not touch
      // the 503 or the code itself, both test-pinned.
      toast.error('Ссылки для приглашений временно недоступны. Сообщите в поддержку.')
    } else {
      toast.error(extractApiError(e, 'Не удалось создать ссылку'))
    }
  } finally {
    creating.value = false
  }
}

// Copy needs no backend — write the link straight to the clipboard (B2).
async function onCopy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    toast.success('Ссылка скопирована')
  } catch {
    toast.error('Не удалось скопировать')
  }
}
</script>

<style scoped>
.invite {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* -- Header: back + title (canonical admin sub-view header) -- */
.invite__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.invite__title {
  flex: 1;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

/* -- Cards -- */
.invite__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.invite__section-title {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.invite__desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
}

.invite__link {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  word-break: break-all;
  line-height: 1.5;
}

.invite__caption {
  margin: 0;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.02em;
}
</style>
