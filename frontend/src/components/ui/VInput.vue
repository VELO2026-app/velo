<!--
  VELO Frontend -- VInput Component (Phase F2.1)

  Text input with label. VELΘ minimal style: no border at rest, focus ring.
  `required` (Phase-3 master DS) -> renders the pink IconRequired seal in the
  right gutter, paired with the legend banner on the form. Replaces the inline
  "*"-asterisk pattern; old `label="… *"` usages keep working until migrated.

  Usage:
    <VInput v-model="email" label="Email" type="email" placeholder="you@example.com" />
    <VInput v-model="name" label="Название" required />
-->

<template>
  <div class="v-input" :class="{ 'v-input--error': !!error }">
    <!-- External label — hidden in floating mode (the label lives inside the field).
         T24-6 (PROMPT №639): `hideLabel` keeps this SAME <label> in the DOM (a
         placeholder is not a substitute -- it disappears on typing and is not
         announced the way a label is) but visually hides it, for a screen that
         wants the placeholder alone to carry the visible hint. Off by default —
         every existing caller keeps the visible label, byte-identical. -->
    <label
      v-if="label && !floatingLabel"
      class="v-input__label"
      :class="{ 'v-input__label--visually-hidden': hideLabel }"
      :for="fieldId"
      >{{ label }}</label
    >

    <div class="v-input__row">
      <!-- Floating-label path (DS variant): the label sits inside the empty field
           as a placeholder, then floats up small on focus/fill and stays (batch J
           J1a). Additive — only when `floatingLabel`; every other caller is
           untouched. Not combined with the affix slots. -->
      <div
        v-if="floatingLabel && !$slots.prefix && !$slots.suffix"
        class="v-input__float"
        :class="{ 'v-input__float--filled': !!modelValue }"
      >
        <input
          ref="inputEl"
          class="v-input__field v-input__field--float"
          :type="type"
          :id="fieldId"
          :value="modelValue"
          :disabled="disabled"
          v-bind="$attrs"
          @focus="onFieldFocus"
          @input="onInput"
        />
        <label class="v-input__float-label" :for="fieldId">{{ label }}</label>
      </div>

      <!-- Affix path: prefix/suffix slots (€ amount, inline action, …). The box
           carries the border/bg; the input goes bare inside. -->
      <div v-else-if="$slots.prefix || $slots.suffix" class="v-input__box">
        <span v-if="$slots.prefix" class="v-input__affix"><slot name="prefix" /></span>
        <input
          ref="inputEl"
          class="v-input__field v-input__field--bare"
          :type="type"
          :id="fieldId"
          :value="modelValue"
          :placeholder="placeholder"
          :disabled="disabled"
          v-bind="$attrs"
          @focus="onFieldFocus"
          @input="onInput"
        />
        <span v-if="$slots.suffix" class="v-input__affix"><slot name="suffix" /></span>
      </div>

      <!-- Plain path (default) — unchanged for every existing usage. -->
      <input
        v-else
        ref="inputEl"
        class="v-input__field"
        :type="type"
        :id="fieldId"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        v-bind="$attrs"
        @focus="onFieldFocus"
        @input="onInput"
      />

      <!-- Required marker (DS): the gutter is ALWAYS reserved while `required`, so
           the field width never jumps when it fills. Red rosette «!» when empty →
           green rosette «✓» when filled (operator 2026-06-23). -->
      <span v-if="required" class="v-input__seal" :class="{ 'v-input__seal--done': !!modelValue }">
        <IconRequired v-if="!modelValue" :size="22" />
        <IconRequiredDone v-else :size="22" />
      </span>
    </div>

    <span v-if="error" class="v-input__error">{{ error }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, useId } from 'vue'
import { IconRequired, IconRequiredDone } from '@/components/icons'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'

// inheritAttrs:false — forward native attrs (min/max/step/inputmode/…) onto the
// inner <input>, not the wrapper div. Keeps VInput at parity with VSelect/VTextarea.
defineOptions({ inheritAttrs: false })

// DS-wide default keyboard focus-scroll (root-static batch): every VInput
// scrolls itself above the keyboard on focus, closing the "some fields never
// got the per-field treatment" gap (diary search, Language/Timezone, MasterApply
// Step 1/2, …). If a caller ALSO passes its own `@focus`, Vue's v-bind merge
// behavior fires BOTH handlers (no override, no crash) -- calling
// scrollIntoView twice is harmless. Callers may drop their own wiring later;
// not required for this to work.
//
// W10 fix (PROMPT №387): the original batch only wired `@focus` on the PLAIN
// render path (below) -- the floating-label path (`floating-label` prop,
// e.g. MasterApplyView Step 1's display_name/email/phone) and the affix path
// (prefix/suffix slots) each render their OWN <input>, so they silently
// didn't inherit it. Same fix, same reasoning, applied to all 3 paths now.
const { onFieldFocus } = useKeyboardFieldScroll()

// Label/input association (PROMPT №679): one id per component instance covers
// all 3 template branches, since only one is ever mounted at a time. A
// caller-supplied `id` (arriving through $attrs, bound AFTER this in the
// template) still wins -- Vue resolves same-element plain attrs by source
// order, so this is the fallback, not an override.
const fieldId = useId()

const props = withDefaults(
  defineProps<{
    modelValue?: string
    label?: string
    placeholder?: string
    type?: string
    error?: string
    disabled?: boolean
    /** Show the pink IconRequired seal in the right gutter (DS required marker). */
    required?: boolean
    /** Floating-label variant (batch J): render `label` inside the field; it
     *  floats up small on focus/fill. Default OFF — all existing callers keep the
     *  external-label layout. Ignored when prefix/suffix slots are used. */
    floatingLabel?: boolean
    /** T24-6 (PROMPT №639): keep `label` as the field's accessible name but hide
     *  it visually — the placeholder alone carries the visible hint. Default OFF
     *  — every existing caller keeps the visible label. Ignored with `floatingLabel`
     *  (that variant already has no external label to hide). */
    hideLabel?: boolean
  }>(),
  {
    modelValue: '',
    label: '',
    placeholder: '',
    type: 'text',
    error: '',
    disabled: false,
    required: false,
    floatingLabel: false,
    hideLabel: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

// Expose focus() so callers can programmatically focus the field
// (e.g. autofocus on reveal). Works for both the plain and affix paths.
const inputEl = ref<HTMLInputElement | null>(null)
defineExpose({ focus: () => inputEl.value?.focus() })

/**
 * Emit, then re-assert the parent's value onto the DOM.
 *
 * Without the re-assert this field is not actually controlled. When a parent
 * REJECTS or NORMALISES what was typed and lands back on the value it already
 * held, `modelValue` does not change between renders, so Vue's
 * shouldUpdateComponent skips this child entirely and the inner <input> is never
 * patched. The typed text survives because nothing overwrites it, and the field
 * then shows something the state does not agree with. (It is NOT that Vue
 * "skips the value patch" -- Vue always patches `value`; the child simply never
 * re-renders. Verified on a bare VInput, PROMPT №434.)
 *
 * Two sites do this today, both money-adjacent -- TopupView's negative-amount
 * reject and MasterNewPromocodeView's usage-limit clamp; both are covered in
 * VInput.test.ts and in their own view tests.
 *
 * The `!==` guard is load-bearing: on the overwhelmingly common path the parent
 * accepts the value, DOM and prop already agree, and nothing is written -- so
 * this cannot disturb the caret for anyone typing normally. It only writes on
 * the divergence it exists to repair.
 */
function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
  nextTick(() => {
    const el = inputEl.value
    if (el && el.value !== props.modelValue) el.value = props.modelValue
  })
}
</script>

<style scoped>
.v-input {
  margin-bottom: var(--space-4);
}

.v-input__label {
  display: block;
  /* Figma form spec (2 Edit Profile.svg): label Marmelad 18, primary colour. */
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

/* T24-6 (PROMPT №639): standard visually-hidden technique -- stays in the DOM
   and in the accessible-name computation, occupies zero visual space (clipped
   to 1px, not display:none, which screen readers skip entirely). */
.v-input__label--visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Row = field (flex:1) + optional required seal in the right gutter. */
.v-input__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.v-input__field {
  flex: 1;
  min-width: 0;
  height: var(--velo-size-40);
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  /* Figma: form fields are SOLID WHITE plates (was glass-blue, which read as
     "transparent" on the photo background). This is the single field standard. */
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  transition: border-color var(--transition-base);
}

.v-input__field:focus {
  outline: none;
  border-color: var(--velo-border-input-focus);
}

.v-input__field::placeholder {
  color: var(--velo-text-placeholder);
}

.v-input__field:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--velo-bg-subtle);
}

.v-input--error .v-input__field {
  border-color: var(--velo-error);
}

/* -- Affix box (prefix/suffix slots) -- */
.v-input__box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--velo-size-40);
  padding: 0 var(--space-4);
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  transition: border-color var(--transition-base);
}

.v-input__box:focus-within {
  border-color: var(--velo-border-input-focus);
}

.v-input--error .v-input__box {
  border-color: var(--velo-error);
}

.v-input__affix {
  flex-shrink: 0;
  font-size: var(--text-base);
  color: var(--velo-text-placeholder);
}

.v-input__field--bare {
  height: auto;
  flex: 1;
  min-width: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
}

.v-input__field--bare:disabled {
  background: transparent;
}

/* -- Floating-label variant (batch J) -- */
.v-input__float {
  position: relative;
  flex: 1;
  min-width: 0;
}

/* Taller plate so the floated label + input text both fit; extra top padding
   reserves the row the label rises into. Shares the white-plate base above. */
.v-input__field--float {
  width: 100%;
  height: var(--velo-size-56);
  padding: 20px var(--space-4) 0;
}

.v-input__float-label {
  position: absolute;
  left: calc(var(--space-4) + 2px);
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-placeholder);
  pointer-events: none;
  transition:
    top var(--transition-fast),
    font-size var(--transition-fast),
    color var(--transition-fast),
    transform var(--transition-fast);
}

/* Floated state: focused OR filled → small label pinned near the top. */
.v-input__float:focus-within .v-input__float-label,
.v-input__float--filled .v-input__float-label {
  top: 9px;
  transform: none;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* Required seal — sits beside the field, never shrinks, gutter always reserved
   while required (no width jump on fill). Red empty → green when filled. */
.v-input__seal {
  flex-shrink: 0;
  display: flex;
  color: var(--velo-error);
}

.v-input__seal--done {
  color: var(--velo-required-done);
}

.v-input__error {
  display: block;
  font-size: var(--text-xs);
  color: var(--velo-error);
  margin-top: var(--space-1);
}
</style>
