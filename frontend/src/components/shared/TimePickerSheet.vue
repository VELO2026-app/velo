<!--
  VELO Frontend -- TimePickerSheet (Phase-3 master DS)

  Bottom-sheet time picker for the practice form (operator SVG 2026-06-11,
  "Время практики"). 24-hour (Q1=А): two VWheel columns — hours 00–23, minutes
  in 5-minute steps. No AM/PM (the app is 24h/ru everywhere).

  v-model is 'HH:MM' (24h) — exactly what the form stores. Emits update:modelValue
  + close on save.
-->

<template>
  <VBottomSheet
    :open="open"
    :title="title ?? t('timePicker.title')"
    :save-label="t('ui.save')"
    @save="save"
    @close="$emit('close')"
  >
    <div class="tps">
      <VWheel v-model="hour" :options="HOUR_OPTIONS" />
      <VWheel v-model="minute" :options="MINUTE_OPTIONS" />
    </div>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, watch } from 'vue'
import { VBottomSheet, VWheel } from '@/components/ui'

const props = withDefaults(
  defineProps<{
    open: boolean
    modelValue?: string
    /** Sheet heading — defaults to the practice-form label; override for reuse. */
    title?: string
  }>(),
  { modelValue: '' },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  close: []
}>()

const MINUTE_STEP = 5

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: pad2(h), label: pad2(h) }))
const MINUTE_OPTIONS = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => {
  const m = i * MINUTE_STEP
  return { value: pad2(m), label: pad2(m) }
})

const hour = ref('12')
const minute = ref('00')

function initFromModel(): void {
  const m = /^(\d{2}):(\d{2})$/.exec(props.modelValue)
  if (m) {
    hour.value = pad2(Math.min(23, Number(m[1])))
    // Snap minutes to the nearest step (e.g. 32 -> 30).
    const mins = (Math.round(Number(m[2]) / MINUTE_STEP) * MINUTE_STEP) % 60
    minute.value = pad2(mins)
  } else {
    hour.value = '12'
    minute.value = '00'
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) initFromModel()
  },
  { immediate: true },
)

function save(): void {
  emit('update:modelValue', `${hour.value}:${minute.value}`)
  emit('close')
}
</script>

<style scoped>
.tps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-8);
}
</style>
