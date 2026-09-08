<!--
  VELO Frontend -- SendMessageModal (Master DS, 2026-06-11; REAL send -- T3)

  "Написать сообщение" sheet, reused on the student screens (list / profile /
  summary / analytics). REAL since the T3 chat backend landed: «Отправить»
  open-or-gets the eternal DM with the student (POST /chats/students -- the
  same thread the student's own «Задать вопрос» opens) and posts the text.
  Same open-then-send split as BookingConfirmedView.onSendRequest: one
  in-flight flag, success toasts and closes, a failure toasts and leaves the
  sheet standing with the draft (the retry is safe -- comms dedups on the
  pair). Visual contract: recipient chip + message textarea + Отмена /
  Отправить.
-->

<template>
  <VModal :open="open" :show-close="false" @close="$emit('close')">
    <div class="send-msg">
      <div class="send-msg__chip">
        <VAvatar :name="name" size="md" />
        <span class="send-msg__name">{{ name }}</span>
      </div>
      <!-- maxlength is a native attr VTextarea forwards to the field, the same
           4000 cap the chat thread's own Composer enforces. -->
      <VTextarea v-model="text" placeholder="Сообщение…" :rows="5" maxlength="4000" />
      <div class="send-msg__actions">
        <VButton variant="danger" block :disabled="sending" @click="$emit('close')">Отмена</VButton>
        <VButton variant="primary" block :loading="sending" @click="onSend">Отправить</VButton>
      </div>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { VModal, VAvatar, VTextarea, VButton } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { openStudentChat, sendChatMessage } from '@/api/chats'

const props = defineProps<{ open: boolean; studentId: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

const toast = useToast()
const text = ref('')
const sending = ref(false)

// Reset the field each time the sheet opens.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) text.value = ''
  },
)

async function onSend(): Promise<void> {
  // Two calls, in order: open-or-get the DM, then post the text. ONE flag
  // guards both (VButton's own :loading already blocks the button; this is
  // the logic-level twin). A failure leaves the draft in place and toasts --
  // the retry re-uses the same thread, so nothing double-sends.
  const body = text.value.trim()
  if (!body || sending.value) return
  sending.value = true
  try {
    const thread = await openStudentChat(props.studentId)
    await sendChatMessage(thread.id, body)
    toast.success('Сообщение отправлено')
    emit('close')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить сообщение'))
  } finally {
    sending.value = false
  }
}
</script>

<style scoped>
.send-msg {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.send-msg__chip {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-glass-blue-15);
  border-radius: 10px;
  padding: 10px var(--space-4);
}

.send-msg__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.send-msg__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

/* VTextarea owns a bottom margin; drop it so the modal's gap controls spacing. */
.send-msg :deep(.v-textarea) {
  margin-bottom: 0;
}

/* The textarea rests with a transparent border (white plate) — invisible on the
   white modal. Give it a visible frame here so the input area reads clearly
   (design «3 Students» message sheet). */
.send-msg :deep(.v-textarea__field) {
  border-color: var(--velo-border);
}
</style>
