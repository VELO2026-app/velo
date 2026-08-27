<!--
  VELO Frontend -- VCheckbox Component (Phase-3 master DS)

  Square checkbox + label. DS-token control (the DS had only VSwitch; the
  practice "Повторение" section needs a real checkbox). Checked = primary fill
  + white IconCheck, matching the operator SVG (2026-06-11).

  Usage:
    <VCheckbox v-model="isRecurring" label="Сделать регулярной" />
-->

<template>
  <button
    type="button"
    role="checkbox"
    :aria-checked="modelValue"
    class="v-checkbox"
    :class="{ 'v-checkbox--disabled': disabled, 'v-checkbox--sm': size === 'sm' }"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="v-checkbox__box" :class="{ 'v-checkbox__box--on': modelValue }">
      <IconCheck v-if="modelValue" class="v-checkbox__check" :size="14" />
    </span>
    <span v-if="label || $slots.default" class="v-checkbox__label"
      ><slot>{{ label }}</slot></span
    >
  </button>
</template>

<script setup lang="ts">
import { IconCheck } from '@/components/icons'

const props = withDefaults(
  defineProps<{
    modelValue?: boolean
    label?: string
    disabled?: boolean
    /** 'sm' reduces the label font (batch J J1b, e.g. consent copy). Default =
     *  current size, so existing callers are unchanged. */
    size?: 'sm' | 'md'
  }>(),
  {
    modelValue: false,
    label: '',
    disabled: false,
    size: 'md',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<style scoped>
.v-checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0;
  border: none;
  background: none;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  position: relative;
}

/* [FE-26] 44px touch-target bar: the row's own height is label-sized
   (~20-27px) and must not grow -- consent/«Сделать регулярной» rows are
   deliberately compact, and 44px min-height would blow up every form's
   spacing. The invisible overlay extends the tappable zone ~12px above/
   below and around instead: the 20px box alone reaches 44px, and rows
   WITH a label were already wide enough. Adjacent stacked checkboxes'
   zones can meet in the row gap -- a seam tap then goes to the later
   row, which for adjacent checkbox rows is an acceptable miss. */
.v-checkbox::after {
  content: '';
  position: absolute;
  inset: -12px -10px;
}

.v-checkbox--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.v-checkbox__box {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: var(--velo-radius-badge);
  border: 1.5px solid var(--velo-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--transition-fast);
}

.v-checkbox__box--on {
  background: var(--velo-primary);
}

.v-checkbox__check {
  color: var(--velo-white);
}

.v-checkbox__label {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

/* Compact variant (batch J): smaller label copy (e.g. consent text). */
.v-checkbox--sm .v-checkbox__label {
  font-size: var(--text-xs);
  line-height: 1.35;
}
</style>
