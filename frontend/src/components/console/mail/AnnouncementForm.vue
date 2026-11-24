<!--
  VELO Frontend -- AnnouncementForm (FE-268)

  The "new announcement" card of the mail module: the audience, the title and
  the text of one announcement, and the send.
  `POST /admin/announcements` takes exactly these three (audience: everyone or
  the masters). It has no channel choice, no button, no schedule and no test
  send, and it keeps no row of what it sent: the history needs BE-256.

  An announcement cannot be recalled and the server takes no idempotency key,
  so a second request is a second announcement. Two guards stand against it:
    - a press while a send is in flight (or the confirmation is open) does
      nothing -- checked first, before the input is read;
    - the send asks the admin to confirm, naming who will receive it.
  A failure keeps the form as it was. An answer that never came (a timeout,
  no network) or a 5xx says the announcement may have gone out.
-->

<template>
  <ConsoleCard :title="t('console.mail.newTitle')" data-testid="announcement-form">
    <form class="announcement" novalidate @submit.prevent="requestSend">
      <div class="announcement__field">
        <span class="announcement__caption">{{ t('console.mail.audience.label') }}</span>
        <VSegment
          compact
          :model-value="audience"
          :options="audienceOptions"
          :aria-label="t('console.mail.audience.label')"
          @update:model-value="setAudience"
        />
      </div>

      <VInput
        v-model="title"
        :label="t('console.mail.titleLabel')"
        :error="titleError"
        :maxlength="TITLE_MAX"
        :disabled="sending"
        @update:model-value="titleError = ''"
      />

      <div class="announcement__field">
        <VTextarea
          v-model="body"
          :label="t('console.mail.bodyLabel')"
          :error="bodyError"
          :rows="8"
          :maxlength="BODY_MAX"
          :disabled="sending"
          @update:model-value="bodyError = ''"
        />
        <span class="announcement__counter" data-testid="announcement-counter">{{
          t('console.mail.counter', { count: body.length, max: BODY_MAX })
        }}</span>
      </div>

      <div class="announcement__actions">
        <VButton type="submit" :loading="sending" data-testid="announcement-send">
          {{ t('console.mail.send') }}
        </VButton>
      </div>
    </form>

    <VConfirmDialog
      :open="confirming"
      :title="t('console.mail.confirm.title')"
      :message="confirmMessage"
      :confirm-label="t('console.mail.confirm.confirm')"
      :cancel-label="t('console.mail.confirm.cancel')"
      :loading="sending"
      @confirm="send"
      @cancel="cancelConfirm"
    />
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { VButton, VConfirmDialog, VInput, VSegment, VTextarea } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import { ApiResponseError } from '@/api/client'
import { sendAnnouncement, type AnnouncementRequest } from '@/api/admin'
import { useAdminMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

/** The limits of `AnnouncementRequest` on the server (`min_length=1`, `max_length`). */
const TITLE_MAX = 200
const BODY_MAX = 2000

type Audience = NonNullable<AnnouncementRequest['audience']>
const AUDIENCES: readonly Audience[] = ['all', 'masters']

const toast = useToast()
// The request takes the announcement alone (Colada also hands a context).
const mutation = useAdminMutation('sendAnnouncement', (announcement: AnnouncementRequest) =>
  sendAnnouncement(announcement),
)

const audience = ref<Audience>('all')
const title = ref('')
const body = ref('')
const titleError = ref('')
const bodyError = ref('')
/** A request is in flight. Set before anything else runs, restored in `finally`. */
const sending = ref(false)
/** The "send it?" confirmation is open. */
const confirming = ref(false)

const audienceOptions = computed<SegmentOption[]>(() =>
  AUDIENCES.map((value) => ({ value, label: t(`console.mail.audience.${value}`) })),
)
const confirmMessage = computed(() => t(`console.mail.confirm.${audience.value}`))

// VSegment hands a plain string; a value that is no audience is ignored.
function setAudience(value: string): void {
  const next = AUDIENCES.find((a) => a === value)
  if (next !== undefined) audience.value = next
}

/** The send button and Enter in the title: check the input, then ask to confirm. */
function requestSend(): void {
  // The guard comes first: while a send is in flight or the confirmation is
  // up, a press neither reads the input nor opens a second confirmation.
  if (sending.value || confirming.value) return
  titleError.value = title.value.trim() === '' ? t('console.mail.errors.titleRequired') : ''
  bodyError.value = body.value.trim() === '' ? t('console.mail.errors.bodyRequired') : ''
  if (titleError.value !== '' || bodyError.value !== '') return
  confirming.value = true
}

function cancelConfirm(): void {
  confirming.value = false
}

/** The confirmation's "send": one request, one announcement. */
async function send(): Promise<void> {
  if (sending.value) return
  sending.value = true
  try {
    await mutation.mutateAsync({
      title: title.value.trim(),
      body: body.value.trim(),
      audience: audience.value,
    })
    toast.success(t('console.mail.sent'))
    title.value = ''
    body.value = ''
  } catch (error) {
    // A refusal (4xx) says nothing went out. A 5xx -- a gateway that gave up
    // after the request reached the server -- and no answer at all (a timeout,
    // no network) leave it open: the announcement may have gone out.
    toast.error(
      error instanceof ApiResponseError && error.status < 500
        ? extractApiError(error, t('console.mail.sendFailed'))
        : t('console.mail.sendUnknown'),
    )
  } finally {
    sending.value = false
    confirming.value = false
  }
}
</script>

<style scoped>
.announcement {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* The kit's textarea is a borderless plate with a large label (made for the
   photo background); on the white card it takes the field look ConsoleCard
   gives an input: a small label and a light border. An error keeps its own. */
.announcement :deep(.v-textarea__label) {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.announcement :deep(.v-textarea:not(.v-textarea--error) .v-textarea__field:not(:focus)) {
  border-color: var(--velo-border-light);
  font-size: var(--velo-fs-16);
}

.announcement__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.announcement__caption {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.announcement__counter {
  align-self: flex-end;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.announcement__actions {
  display: flex;
  justify-content: flex-start;
}
</style>
