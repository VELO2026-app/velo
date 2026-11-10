<!--
  VELO Frontend -- PracticeSchedulePicker (FE-157 stage 4, track 4A)

  A schedule field of the practice form (create and edit): a white trigger
  plate that opens the branded DatePickerSheet or the 24h TimePickerSheet
  (both teleport to body), plus the field's own error row. Replaces the
  trigger + sheet + friendly-date code each screen carried (date, time and
  the series end date on create; date and time on edit).

  The plate mirrors the white VInput plate. A date field never offers a day
  before `min`, and `min` falls back to today (local calendar date, read at
  render time, so it is not stale after midnight -- W-7 / W-8).

  Usage:
    <PracticeSchedulePicker v-model="form.date" kind="date" placeholder="Date"
      :error="errors.date" error-id="err-date" />
    <PracticeSchedulePicker v-model="form.time" kind="time" :label="'Time'"
      placeholder="Choose" />
-->

<template>
  <div class="practice-schedule-picker">
    <label v-if="label" class="practice-schedule-picker__label">{{ label }}</label>
    <button
      type="button"
      class="practice-schedule-picker__trigger"
      :class="{
        'practice-schedule-picker__trigger--empty': !modelValue,
        'practice-schedule-picker__trigger--error': !!error,
        'practice-schedule-picker__trigger--outlined': outlined,
      }"
      :aria-invalid="!!error || undefined"
      :aria-describedby="error && errorId ? errorId : undefined"
      @click="open = true"
    >
      {{ modelValue ? display : placeholder }}
    </button>
    <VFieldError v-if="errorId" :id="errorId" :message="error" />
    <DatePickerSheet
      v-if="kind === 'date'"
      :open="open"
      :model-value="modelValue"
      :min="min || todayLocalISO()"
      :title="title"
      @update:model-value="emit('update:modelValue', $event)"
      @close="open = false"
    />
    <TimePickerSheet
      v-else
      :open="open"
      :model-value="modelValue"
      :title="title"
      @update:model-value="emit('update:modelValue', $event)"
      @close="open = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { VFieldError } from '@/components/ui'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import TimePickerSheet from '@/components/shared/TimePickerSheet.vue'
import { formatShortDate, todayLocalISO } from '@/utils/format'

const props = defineProps<{
  /** ISO 'YYYY-MM-DD' for a date, 'HH:mm' for a time; '' = not chosen. */
  modelValue: string
  kind: 'date' | 'time'
  /** Shown in the plate while nothing is chosen. */
  placeholder: string
  /** Field label above the plate (the edit screen's layout); none = the placeholder names it. */
  label?: string
  /** Earliest selectable ISO date (date only); defaults to today. */
  min?: string
  /** Sheet heading; each sheet has its own default. */
  title?: string
  error?: string
  /** Renders the error row (0px while closed) and links the plate to it. */
  errorId?: string
  /** A visible border, for a plate sitting on a white card. */
  outlined?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)

// A friendly date, e.g. "25 Jan 2026" in the ru short form; times show as typed.
const display = computed((): string =>
  props.kind === 'date'
    ? `${formatShortDate(`${props.modelValue}T12:00:00`)} ${props.modelValue.slice(0, 4)}`
    : props.modelValue,
)
</script>

<style scoped>
.practice-schedule-picker__label {
  display: block;
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

.practice-schedule-picker__trigger {
  display: flex;
  align-items: center;
  width: 100%;
  height: var(--velo-size-40);
  text-align: left;
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  cursor: pointer;
}

.practice-schedule-picker__trigger--empty {
  color: var(--velo-text-muted);
}

.practice-schedule-picker__trigger--outlined {
  border-color: var(--velo-border);
}

.practice-schedule-picker__trigger--error {
  border-color: var(--velo-error);
}
</style>
