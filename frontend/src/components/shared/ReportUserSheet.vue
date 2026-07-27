<!--
  VELO Frontend -- ReportUserSheet (Master GROUPS P3, ПРОМТ №592; MULTI-select
  + styling fix batch ПРОМТ №609)

  "Сообщить о пользователе" -- the report form (step D of the block flow,
  also reachable standalone from wherever a master wants to report a
  student). MULTI-select VChip reasons (G12, owner-ruled) + an optional
  comment.

  POST /api/v1/reports { target_type: "user", target_id, reason }, where
  reason = every selected chip's label joined with ", ", plus " — <comment>"
  if a comment was entered. Composed client-side because the backend Report
  table has one free-text `reason` column, no separate category/comment
  split, and NO structured multi-reason support (recon #589: Report is
  USER|MASTER|PRACTICE + reason, nothing more) -- owner-parked as a
  separate future task, NOT started here. `reason` is capped at 2000 chars
  server-side (Navigator-verified); several reasons plus a long comment can
  exceed that, so submit is blocked with a clear message rather than
  silently truncating the master's own comment (REASON_MAX_LENGTH below).

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
    compact-title
    save-label="Отправить"
    :save-disabled="selectedReasons.size === 0"
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
        :active="selectedReasons.has(r)"
        @click="toggleReason(r)"
      >
        {{ r }}
      </VChip>
    </div>

    <VTextarea
      v-model="comment"
      placeholder="Опишите, что произошло, это поможет нам разобраться"
      :rows="4"
      class="report-user__textarea"
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

// Backend cap (reports/schemas.py, Navigator-verified): reason: str =
// Field(min_length=1, max_length=2000). Several selected reasons joined
// with a long comment CAN exceed it -- checked before submit (below), not
// silently truncated.
const REASON_MAX_LENGTH = 2000

const selectedReasons = ref<Set<string>>(new Set())
const comment = ref('')

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedReasons.value = new Set()
      comment.value = ''
    }
  },
)

function toggleReason(r: string): void {
  const next = new Set(selectedReasons.value)
  if (next.has(r)) next.delete(r)
  else next.add(r)
  selectedReasons.value = next
}

async function onSend(): Promise<void> {
  if (selectedReasons.value.size === 0) return
  const reasonList = Array.from(selectedReasons.value).join(', ')
  const trimmedComment = comment.value.trim()
  const reason = trimmedComment ? `${reasonList} — ${trimmedComment}` : reasonList
  if (reason.length > REASON_MAX_LENGTH) {
    toast.error(
      `Слишком длинно (${reason.length} из ${REASON_MAX_LENGTH} символов) — сократите комментарий`,
    )
    return
  }
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

/* G12 (ПРОМТ №609): colour-highlighted per the mockup -- no exact value
   was measured for this one (unlike the tokened items elsewhere in this
   batch), so the existing brand/emphasis token is used rather than a
   literal; flagged in the delivery report as unmeasured. */
.report-user__label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-primary);
  font-weight: 600;
  margin: 0 0 var(--space-2);
}

/* G12: MULTI-select, options stacked VERTICALLY (was flex-wrap, one row) --
   align-items: flex-start keeps each chip its own natural pill width
   instead of stretching to fill the row. */
.report-user__chips {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

/* G14 (ПРОМТ №609): visible resting border on the textarea, scoped to
   THIS instance via :deep() (the same pattern the search-field glass
   pills already use) rather than changing VTextarea's own default --
   that default border color equals the focus-state color, so making it
   always-visible app-wide would make every textarea look permanently
   focused. --velo-border is the existing token that matches (same value
   as --velo-border-input-focus, but that coincidence is exactly why this
   must stay scoped, not global). */
.report-user__textarea :deep(.v-textarea__field) {
  border-color: var(--velo-border);
}

.report-user__note {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  line-height: 1.5;
  margin: var(--space-3) 0 0;
}
</style>
