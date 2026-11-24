<!--
  VELO Frontend -- VSelect Component (Phase F2.1)

  Native select dropdown. Without a visible `label` the in-field `placeholder`
  is the field's name, so it doubles as the select's aria-label (a disabled
  placeholder <option> is not an accessible name). Matches mockup .form-select styles.
  White plate canon (Phase-3) — unified with VInput as the single field surface
  (was glass-blue). `required` -> pink IconRequired seal in the right gutter.

  Usage:
    <VSelect v-model="lang" label="Language" :options="langOptions" />
    <VSelect v-model="dir" label="Direction" :options="opts" required />
-->

<template>
  <div class="v-select" :class="{ 'v-select--error': !!error }">
    <label v-if="label" class="v-select__label" :for="fieldId">{{ label }}</label>
    <div class="v-select__row">
      <!-- The control wraps the native select so the chevron can be a layer
           painted with a token (a data: URI in background-image cannot read
           CSS variables -- FE-230). -->
      <span class="v-select__control" :class="{ 'v-select__control--disabled': disabled }">
        <select
          :id="fieldId"
          class="v-select__field"
          :value="modelValue"
          :disabled="disabled"
          :aria-label="label ? undefined : ariaLabel || placeholder || undefined"
          :aria-invalid="!!error || undefined"
          :aria-describedby="error ? errorId : undefined"
          @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
        >
          <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
          <option v-for="opt in options" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </span>
      <!-- Required marker (DS): the gutter is ALWAYS reserved while `required`, so
           the field width never jumps when a value is chosen. Red rosette «!» when
           empty → green rosette «✓» when selected (operator 2026-06-23). -->
      <span
        v-if="required"
        class="v-select__seal"
        :class="{ 'v-select__seal--done': !!modelValue }"
      >
        <IconRequired v-if="!modelValue" :size="22" />
        <IconRequiredDone v-else :size="22" />
      </span>
    </div>
    <!-- Animated error row (owner TZ 2026-11-01): always mounted, 0px closed.
         The legacy class stays so tests/view selectors keep resolving. -->
    <VFieldError :id="errorId" class="v-select__error" :message="error" />
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { IconRequired, IconRequiredDone } from '../../icons'
import VFieldError from '../VFieldError'

export interface SelectOption {
  value: string
  label: string
}

// Label/input association (PROMPT №679), same pattern as VInput.vue. VSelect
// does not forward $attrs to the inner <select> (no inheritAttrs:false here),
// so there is no caller-supplied id to defer to on this element.
const fieldId = useId()
// The error row (VFieldError below) is aria-describedby'd from the select.
const errorId = `${fieldId}-error`

withDefaults(
  defineProps<{
    modelValue?: string
    label?: string
    placeholder?: string
    /** Accessible name for a select whose name is on screen elsewhere (a section heading). */
    ariaLabel?: string
    options: SelectOption[]
    error?: string
    disabled?: boolean
    /** Show the pink IconRequired seal in the right gutter (DS required marker). */
    required?: boolean
  }>(),
  {
    modelValue: '',
    label: '',
    placeholder: '',
    ariaLabel: '',
    error: '',
    disabled: false,
    required: false,
  },
)

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<style scoped>
.v-select {
  margin-bottom: var(--space-4);
}

.v-select__label {
  display: block;
  /* Figma form spec: label Marmelad 18, primary — unified with VInput/VTextarea. */
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

/* Row = field (flex:1) + optional required seal in the right gutter. */
.v-select__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.v-select__field {
  flex: 1;
  min-width: 0;
  /* 44px tap target (FE-249). */
  height: var(--velo-size-44);
  padding: 0 var(--size-select-chevron-clearance) 0 calc(var(--space-4) + var(--velo-border-width));
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  /* White plate canon — the single field surface, unified with VInput. */
  background: var(--velo-bg-card-solid);
  /* 1px rim at rest, 2px ring on focus and error (the VInput recipe, FE-249). */
  border: var(--velo-border-width) solid var(--velo-border-input-rest);
  border-radius: var(--velo-radius-badge);
  transition:
    border-color var(--transition-base),
    box-shadow var(--transition-base);
  appearance: none;
}

/* The field box plus its chevron layer. */
.v-select__control {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

/* Primary-tinted chevron (operator SVG 2026-06-11): the SVG is the mask, the
   color is the token. Placed where the field's background-image sat: 16px
   in from the padding box plus the 2px border, centered. */
.v-select__control::after {
  content: '';
  position: absolute;
  top: 50%;
  right: calc(var(--space-4) + var(--velo-gap-2));
  width: var(--velo-size-12);
  height: var(--velo-size-12);
  translate: 0 -50%;
  background-color: var(--velo-primary);
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E")
    no-repeat center / contain;
  pointer-events: none;
}

/* The chevron fades with the disabled field (opacity 0.5 below). */
.v-select__control--disabled::after {
  opacity: 0.5;
}

.v-select__field:focus {
  outline: none;
  border-color: var(--velo-border-input-ring);
  box-shadow: var(--velo-shadow-field-focus);
}

.v-select__field:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background-color: var(--velo-bg-subtle);
}

.v-select--error .v-select__field {
  border-color: var(--velo-error);
  box-shadow: var(--velo-shadow-field-error);
}

/* Required seal — sits beside the field, never shrinks, gutter always reserved
   while required (no width jump on select). Red empty → green when filled. */
.v-select__seal {
  flex-shrink: 0;
  display: flex;
  color: var(--velo-error);
}

.v-select__seal--done {
  color: var(--velo-required-done);
}
</style>
