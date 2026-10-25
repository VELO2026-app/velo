<!--
  VELO Frontend -- SupportMessageBubble (FE-100, delivery B)

  One message of a support feed as an admin reads it, with its translation
  (BE-166, support/translation.py::admin_feed). Used by the ticket card for
  both the ticket's feed and the person's read-only history.

  THE PERSON'S MESSAGE (`fromPerson`): `body` is the translation into the
  support language when `ready`, the original otherwise.
    ready                     -> «Показать оригинал» / «Показать перевод»: the
                                 original is shown ONLY on demand;
    preparing / not_requested -> «Переводится…» (the original is shown);
    impossible                -> «Ошибка перевода» (the original is shown);
    not_needed / no block     -> nothing.
  A REPLY of support to a person of another language: `body` is the reply as
  written; the block says what became of its translation for the person.
    preparing / not_requested -> «Переводится…»;
    impossible                -> «Не доставлено» -- the person cannot read it;
    ready / not_needed / null -> nothing.
  ANY message with `retryable: true` (the job failed in transport) offers
  «Повторить» -- any admin may ask again (owner ruling FE-100). A declined
  translation is `impossible` with `retryable: false`: final, no button.

  The five states are comms' closed set (VariantState) -- there is no
  "unknown state" branch.
-->

<template>
  <div class="bubble-row" :class="{ 'bubble-row--mine': mine }">
    <div class="bubble" :class="{ 'bubble--mine': mine }">
      <div class="bubble__body">{{ shownText }}</div>

      <div v-if="mark" class="bubble__mark" :class="`bubble__mark--${mark}`">
        {{ markLabel }}
      </div>

      <div v-if="canToggle || canRetry" class="bubble__actions">
        <button v-if="canToggle" type="button" class="bubble__link" @click="emit('toggle')">
          {{
            showOriginal
              ? t('adminScreens.adminSupportDetail.translation.showTranslation')
              : t('adminScreens.adminSupportDetail.translation.showOriginal')
          }}
        </button>
        <button
          v-if="canRetry"
          type="button"
          class="bubble__link"
          :disabled="retrying"
          @click="emit('retry')"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <div class="bubble__time">{{ time }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import type { SupportMessage } from '@/api/support'

const props = defineProps<{
  message: SupportMessage
  /** Written by the person the ticket is about (not by support). */
  fromPerson: boolean
  /** Written by the viewing admin -- right-aligned. */
  mine: boolean
  showOriginal: boolean
  retrying: boolean
  time: string
}>()

const emit = defineEmits<{
  toggle: []
  retry: []
}>()

type Mark = 'translating' | 'failed' | 'undelivered'

const state = computed(() => props.message.translation?.state ?? null)

const mark = computed<Mark | null>(() => {
  if (state.value === 'preparing' || state.value === 'not_requested') return 'translating'
  if (state.value === 'impossible') return props.fromPerson ? 'failed' : 'undelivered'
  return null
})

const markLabel = computed<string>(() => {
  if (mark.value === 'translating')
    return t('adminScreens.adminSupportDetail.translation.translating')
  if (mark.value === 'failed') return t('adminScreens.adminSupportDetail.translation.failed')
  return t('adminScreens.adminSupportDetail.translation.undelivered')
})

/** Only a person's translated message has an original to show. */
const canToggle = computed<boolean>(() => props.fromPerson && state.value === 'ready')
const canRetry = computed<boolean>(() => props.message.translation?.retryable === true)

const shownText = computed<string>(() =>
  canToggle.value && props.showOriginal ? props.message.original : props.message.body,
)
</script>

<style scoped>
.bubble-row {
  display: flex;
  justify-content: flex-start;
}

.bubble-row--mine {
  justify-content: flex-end;
}

.bubble {
  max-width: 78%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
  word-break: break-word;
}

.bubble--mine {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.bubble__body {
  white-space: pre-wrap;
  font-size: var(--text-sm);
}

.bubble__mark {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  opacity: 0.75;
}

.bubble__mark--failed,
.bubble__mark--undelivered {
  opacity: 1;
  color: var(--velo-danger-text);
}

.bubble--mine .bubble__mark--failed,
.bubble--mine .bubble__mark--undelivered {
  color: var(--velo-white);
  font-weight: 600;
}

.bubble__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-1);
}

.bubble__link {
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  font-size: var(--text-xs);
  text-decoration: underline;
  cursor: pointer;
}

.bubble__link:disabled {
  opacity: 0.5;
  cursor: default;
}

.bubble__time {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  opacity: 0.6;
  text-align: right;
}
</style>
