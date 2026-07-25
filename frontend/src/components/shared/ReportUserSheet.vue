<!--
  VELO Frontend -- ReportUserSheet (Master GROUPS P3, ПРОМТ №592)

  "Сообщить о пользователе" -- the report form (step D of the block flow,
  also reachable standalone from wherever a master wants to report a
  student). Single-select VChip reasons + an optional comment.

  POST /api/v1/reports { target_type: "user", target_id, reason }, where
  reason = the chosen chip's label, plus " — <comment>" if a comment was
  entered. Composed client-side because the backend Report table has one
  free-text `reason` column, no separate category/comment split (recon
  #589: Report is USER|MASTER|PRACTICE + reason, nothing more).

  Duplicate handling: MEASURED (reports/service.py/router.py, read before
  writing this) -- a duplicate (same reporter+target) returns HTTP 200 with
  the EXISTING report, never a 409. Either way api.post() resolves without
  throwing, so there is nothing to special-case here; the success toast
  fires uniformly.
-->

<template>
  <VBottomSheet
    :open="open"
    title="Сообщить о пользователе"
    save-label="Отправить"
    :save-disabled="!selectedReason"
    @save="onSend"
    @close="$emit('close')"
  >
    <p class="report-user__name">{{ studentName }}</p>

    <p class="report-user__label">Причина:</p>
    <div class="report-user__chips">
      <VChip
        v-for="r in REASONS"
        :key="r"
        size="md"
        clickable
        :active="selectedReason === r"
        @click="selectedReason = r"
      >
        {{ r }}
      </VChip>
    </div>

    <VTextarea
      v-model="comment"
      label="Комментарий (необязательно)"
      placeholder="Опишите, что произошло, это поможет нам разобраться"
      :rows="4"
    />

    <p class="report-user__note">
      Заявка уйдёт в поддержку. Мы можем связаться с вами, чтобы уточнить детали.
    </p>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { VBottomSheet, VChip, VTextarea } from '@/components/ui'
import { createReport } from '@/api/reports'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const props = defineProps<{
  open: boolean
  studentId: string
  studentName: string
}>()

const emit = defineEmits<{ close: []; sent: [] }>()

const toast = useToast()

const REASONS = [
  'Сорвал практику',
  'Спам или реклама',
  'Оскорбления, неподобающее поведение',
  'Мошенничество',
  'Другое',
] as const

const selectedReason = ref<string>('')
const comment = ref('')

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedReason.value = ''
      comment.value = ''
    }
  },
)

async function onSend(): Promise<void> {
  if (!selectedReason.value) return
  const reason = comment.value.trim()
    ? `${selectedReason.value} — ${comment.value.trim()}`
    : selectedReason.value
  try {
    await createReport({ target_type: 'user', target_id: props.studentId, reason })
    toast.success('Заявка отправлена в поддержку')
    emit('sent')
    emit('close')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить заявку'))
  }
}
</script>

<style scoped>
.report-user__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-4);
}

.report-user__label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-2);
}

.report-user__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.report-user__note {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  line-height: 1.5;
  margin: var(--space-3) 0 0;
}
</style>
