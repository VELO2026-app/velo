<!--
  VELO Frontend -- VTextarea Component (Phase F2.1)

  Multiline text input. Matches mockup .form-textarea styles.
  `required` (W22, PROMPT №409) -> renders the same pink IconRequired seal
  VInput/VSelect already do, for DS parity.

  Usage:
    <VTextarea v-model="bio" label="О себе" :rows="4" placeholder="Расскажите..." />
    <VTextarea v-model="bio" label="О себе" required />
-->

<template>
  <div class="v-textarea" :class="{ 'v-textarea--error': !!error }">
    <label v-if="label" class="v-textarea__label">{{ label }}</label>
    <div class="v-textarea__row">
      <textarea
        ref="fieldEl"
        class="v-textarea__field"
        :class="{ 'v-textarea__field--autogrow': autogrow }"
        :value="modelValue"
        :placeholder="placeholder"
        :rows="rows"
        :disabled="disabled"
        v-bind="$attrs"
        @focus="onFieldFocus"
        @input="onInput"
      />
      <!-- Required marker (DS): mirrors VInput/VSelect's seal -- gutter always
           reserved while `required` so the field width never jumps on fill. -->
      <span
        v-if="required"
        class="v-textarea__seal"
        :class="{ 'v-textarea__seal--done': !!modelValue }"
      >
        <IconRequired v-if="!modelValue" :size="22" />
        <IconRequiredDone v-else :size="22" />
      </span>
    </div>
    <span v-if="error" class="v-textarea__error">{{ error }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import { IconRequired, IconRequiredDone } from '@/components/icons'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'

// inheritAttrs:false — forward native attrs (maxlength/inputmode/…) onto the
// inner <textarea>, not the wrapper div. Parity with VInput/VSelect.
defineOptions({ inheritAttrs: false })

// DS-wide default keyboard focus-scroll (root-static batch) — see VInput.vue
// for the rationale; same merge-safe pattern (Vue fires both handlers if a
// caller also passes its own `@focus`).
const { onFieldFocus } = useKeyboardFieldScroll()

const props = withDefaults(
  defineProps<{
    modelValue?: string
    label?: string
    placeholder?: string
    rows?: number
    error?: string
    disabled?: boolean
    /**
     * Opt-in: grow the field to fit its content (up to the DS cap
     * --velo-textarea-autogrow-max, then scroll internally). Off by default so
     * existing fixed-rows usages are byte-identical. The empty start height
     * follows `rows` (e.g. rows=1 ≈ a single-line VInput; rows=4 ≈ the 4-row
     * description plate).
     */
    autogrow?: boolean
    /** Show the pink IconRequired seal in the right gutter (DS required marker,
     *  W22 -- parity with VInput/VSelect). */
    required?: boolean
  }>(),
  {
    modelValue: '',
    label: '',
    placeholder: '',
    rows: 3,
    error: '',
    disabled: false,
    autogrow: false,
    required: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const fieldEl = ref<HTMLTextAreaElement | null>(null)

// Resize to content: reset to auto, then take scrollHeight. The CSS max-height
// (--velo-textarea-autogrow-max) caps the visible box and overflow-y:auto kicks
// in past the cap, so no min/max math is needed here.
function resize(): void {
  if (!props.autogrow) return
  const el = fieldEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  resize()
}

// Initial size + react to programmatic value changes (e.g. the edit form
// populating fields after the practice loads).
onMounted(() => {
  void nextTick(resize)
})
watch(
  () => props.modelValue,
  () => {
    if (props.autogrow) void nextTick(resize)
  },
)
</script>

<style scoped>
.v-textarea {
  margin-bottom: var(--space-4);
}

.v-textarea__label {
  display: block;
  /* Figma form spec (2 Edit Profile.svg): label Marmelad 18, primary colour. */
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

/* Row = field (flex:1) + optional required seal in the right gutter. */
.v-textarea__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.v-textarea__field {
  flex: 1;
  min-width: 0;
  padding: 10px var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  /* Figma: form fields are SOLID WHITE plates (was glass-blue). Single standard. */
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  transition: border-color var(--transition-base);
  min-height: 100px;
  resize: vertical;
}

/* Auto-grow variant: JS drives the height to content; CSS caps it at the DS
   token and switches to internal scroll. min-height:0 so a 1-row field can sit
   at the VInput height instead of the 100px fixed-rows floor. */
.v-textarea__field--autogrow {
  min-height: 0;
  max-height: var(--velo-textarea-autogrow-max);
  resize: none;
  overflow-y: auto;
}

.v-textarea__field:focus {
  outline: none;
  border-color: var(--velo-border-input-focus);
}

.v-textarea__field::placeholder {
  color: var(--velo-text-muted);
}

.v-textarea__field:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--velo-bg-subtle);
}

.v-textarea--error .v-textarea__field {
  border-color: var(--velo-error);
}

/* Required seal — sits beside the field, never shrinks, gutter always reserved
   while required (no width jump on fill). Anchored to the top (not centered,
   like VInput/VSelect) since the field itself is multi-line/tall. Red empty →
   green when filled, same convention as VInput/VSelect. */
.v-textarea__seal {
  flex-shrink: 0;
  display: flex;
  margin-top: var(--space-1);
  color: var(--velo-error);
}

.v-textarea__seal--done {
  color: var(--velo-required-done);
}

.v-textarea__error {
  display: block;
  font-size: var(--text-xs);
  color: var(--velo-error);
  margin-top: var(--space-1);
}
</style>
