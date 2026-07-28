<!--
  VELO Frontend -- ReportUserSheet (Master GROUPS P3, ПРОМТ №592; MULTI-select
  + styling fix batch ПРОМТ №609; full rebuild to measured values ПРОМТ №610)

  "Сообщить о пользователе" -- the report form (step D of the block flow,
  also reachable standalone from wherever a master wants to report a
  student). MULTI-select round-checkbox reasons (G12, owner-ruled) + an
  optional comment.

  POST /api/v1/reports { target_type: "user", target_id, reason }, where
  reason = every selected reason's label joined with ", ", plus " — <comment>"
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

  Rebuild to `Report a user.svg` / `Report a user 2.svg` (ПРОМТ №610):
    - target-user card (TargetUserCard, shared with both block-flow
      VConfirmDialogs on MasterStudentProfileView -- owner Q9)
    - «Причина:» as a full-width glass band, not coloured text
    - round 20x20 checkbox rows (multi-select unchanged, only the visual
      changed from VChip pills)
    - textarea: --velo-radius-4-5 (deliberately small) + --velo-border,
      scoped to this instance
    - support notice: --velo-warning-bg peach panel, NO icon (unlike the
      two block-flow dialogs, which DO carry a warning icon -- see those
      files)
    - «Отмена» (owner Q3, VBottomSheet's new opt-in cancelLabel) + «Отправить»
      in one row, 39/61 width, --velo-primary / --velo-error fill
-->

<template>
  <VBottomSheet
    :open="open"
    title="Сообщить о пользователе"
    compact-title
    cancel-label="Отмена"
    save-label="Отправить"
    :save-disabled="selectedReasons.size === 0"
    @save="onSend"
    @close="$emit('close')"
  >
    <TargetUserCard :name="studentName" :avatar-url="studentAvatarUrl" class="report-user__card" />

    <div class="report-user__reason-band">Причина:</div>
    <div class="report-user__reasons">
      <button
        v-for="r in REASONS"
        :key="r"
        type="button"
        class="report-user__reason-row"
        role="checkbox"
        :aria-checked="selectedReasons.has(r)"
        @click="toggleReason(r)"
      >
        <span
          class="report-user__reason-mark"
          :class="{ 'report-user__reason-mark--on': selectedReasons.has(r) }"
        >
          <IconCheck v-if="selectedReasons.has(r)" class="report-user__reason-check" :size="12" />
        </span>
        <span class="report-user__reason-label">{{ r }}</span>
      </button>
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
import { VBottomSheet, VTextarea } from '@/components/ui'
import { IconCheck } from '@/components/icons'
import TargetUserCard from '@/components/shared/TargetUserCard.vue'
import { createReport } from '@/api/reports'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const props = defineProps<{
  open: boolean
  studentId: string
  studentName: string
  studentAvatarUrl?: string | null
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
.report-user__card {
  margin-bottom: var(--space-4);
}

/* «Причина:» -- full-width glass band, not coloured text (measured). */
.report-user__reason-band {
  width: 100%;
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-3);
}

/* Round 20x20 checkbox rows -- same mark recipe as VRadioGroup (circle +
   IconCheck), copied rather than reusing that component directly: this
   is MULTI-select (a Set), VRadioGroup is architecturally single-select
   (one modelValue). */
.report-user__reasons {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.report-user__reason-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0;
  border: none;
  background: none;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
}

.report-user__reason-mark {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--velo-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--transition-fast);
}

.report-user__reason-mark--on {
  background: var(--velo-primary);
}

.report-user__reason-check {
  color: var(--velo-white);
}

.report-user__reason-label {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
}

/* Measured rx4.5 -- deliberately small, NOT --radius-md. Scoped to THIS
   instance via :deep() (the search-field glass-pill pattern), never
   VTextarea's own default. */
.report-user__textarea :deep(.v-textarea__field) {
  border-color: var(--velo-border);
  border-radius: var(--velo-radius-4-5);
}

/* Support notice: peach panel, NO icon (measured -- unlike the two
   block-flow VConfirmDialogs, which DO carry a warning icon). Reuses
   --velo-warning-bg (40% opacity) rather than minting a near-duplicate
   token for the SVG's ~30% -- Navigator call, not re-litigated here. */
.report-user__note {
  width: 100%;
  background: var(--velo-warning-bg);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-peach-500);
  line-height: 1.5;
  margin: var(--space-3) 0 0;
}
</style>
