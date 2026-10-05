<!--
  VELO Frontend -- VRadioGroup Component (Phase-3 master DS)

  Single-choice radio list + labels. DS-token control (the DS had only VSwitch).
  Selected = primary fill + white IconCheck inside a circle, matching the
  operator SVG (2026-06-11) — the selected radio shows a check, not a dot.

  Usage:
    <VRadioGroup v-model="recurrence" :options="[
      { label: 'Каждый день',    value: 'daily' },
      { label: 'Каждую неделю',  value: 'weekly' },
      { label: 'Раз в две недели', value: 'biweekly' },
    ]" />
    <VRadioGroup v-model="role" :options="..." disabled />
-->

<template>
  <div class="v-radio-group" role="radiogroup">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
      class="v-radio"
      :disabled="disabled"
      @click="onPick(opt.value)"
    >
      <span class="v-radio__mark" :class="{ 'v-radio__mark--on': modelValue === opt.value }">
        <IconCheck v-if="modelValue === opt.value" class="v-radio__check" :size="12" />
      </span>
      <span class="v-radio__label">{{ opt.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { IconCheck } from '@/components/icons'

export interface RadioOption {
  value: string
  label: string
}

const props = defineProps<{
  modelValue: string
  options: RadioOption[]
  /** FE-87 (§1.12.3): whole-group lock while the popup is busy or the
   *  current role is still being resolved. Additive -- every existing
   *  call site omits it and behaves exactly as before. */
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function onPick(value: string): void {
  if (props.disabled) return
  emit('update:modelValue', value)
}
</script>

<style scoped>
.v-radio-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.v-radio {
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

.v-radio:disabled {
  cursor: default;
  opacity: 0.5;
}

.v-radio__mark {
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

.v-radio__mark--on {
  background: var(--velo-primary);
}

.v-radio__check {
  color: var(--velo-white);
}

.v-radio__label {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}
</style>
