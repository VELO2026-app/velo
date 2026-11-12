<!--
  VELO Frontend -- VProgressRow (Admin DS, 2026-06-14, operator SVG "Engagement")

  A labelled meter row: text label, a horizontal progress track (filled to `value`
  percent), a right-aligned value, and an optional drill-in chevron. Used by the
  admin dashboard Engagement card (Check-in / Feedback / Return rate).

  Stub-friendly (build-full-design): omit `value` (or pass null) to show an empty
  track + "—" until the backend metric exists.

  Usage:
    <VProgressRow label="Check-in rate" :value="78" clickable @click="open()" />
    <VProgressRow label="Return rate" :value="null" />   (stub: empty + "—")
-->

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    class="v-progress-row"
    :class="{ 'v-progress-row--clickable': clickable }"
    @click="clickable ? $emit('click') : undefined"
  >
    <span class="v-progress-row__label">{{ label }}</span>
    <span class="v-progress-row__track">
      <i class="v-progress-row__fill" :style="{ width: fillWidth }"></i>
    </span>
    <span class="v-progress-row__value">{{ valueDisplay }}</span>
    <span v-if="chevron" class="v-progress-row__chevron"><IconArrowRight :size="16" /></span>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IconArrowRight } from '../../icons'

const props = withDefaults(
  defineProps<{
    label: string
    /** Percent 0..100. Null/undefined = stub (empty track + "—"). */
    value?: number | null
    /** Show the drill-in chevron (default true). */
    chevron?: boolean
    clickable?: boolean
  }>(),
  { value: null, chevron: true, clickable: false },
)

defineEmits<{ click: [] }>()

const hasValue = computed(
  (): boolean => typeof props.value === 'number' && Number.isFinite(props.value),
)
const fillWidth = computed((): string =>
  hasValue.value ? `${Math.max(0, Math.min(100, props.value as number))}%` : '0%',
)
const valueDisplay = computed((): string =>
  hasValue.value ? `${Math.round(props.value as number)}%` : '—',
)
</script>

<style scoped>
.v-progress-row {
  width: 100%;
  display: grid;
  grid-template-columns: 104px 1fr auto auto;
  align-items: center;
  gap: var(--space-3);
  background: transparent;
  border: none;
  padding: 0;
  text-align: left;
  font-family: var(--font-body);
}

.v-progress-row--clickable {
  cursor: pointer;
}

.v-progress-row--clickable:active {
  opacity: 0.8;
}

.v-progress-row__label {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.v-progress-row__track {
  position: relative;
  height: 10px;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-glass-blue-15);
  overflow: hidden;
}

.v-progress-row__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-primary);
  transition: width var(--transition-base);
}

.v-progress-row__value {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  min-width: 34px;
  text-align: right;
}

.v-progress-row__chevron {
  color: var(--velo-text-primary);
  display: flex;
}
</style>
