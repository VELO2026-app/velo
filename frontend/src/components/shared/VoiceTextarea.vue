<!--
  VELO Frontend -- VoiceTextarea (FE-153; the FE-94 voice field, step 2)

  The kit's VTextarea plus voice dictation. FE-94 built the voice family
  straight into VTextarea; FE-153 cut that seam so the field could move into
  @velo/ui (and the module cycle ui barrel -> VTextarea -> VoiceRecordingPanel
  -> ui barrel went away with it). This wrapper is the domain half:
    - the mic disc rides the kit's #trailing slot;
    - a take turns the kit's `takeover` on for its WHOLE span -- including
      the `requesting` permission prompt, when the region stays an honestly
      frozen EMPTY band, the composer's own behaviour (no premature
      i18n:voice.transcribing before there is a take to transcribe). The panel
      itself mounts in #takeover only once the recorder is actually rolling;
    - the transcript APPENDS to the current value (appendTranscript), clamped
      to the caller's maxlength attr.

  Every other prop/attr (label, rows, error, autogrow, maxlength, ...) falls
  through to VTextarea untouched, so a call site swaps the tag and nothing
  else.

  Usage:
    <VoiceTextarea v-model="thoughts" :voice-input="TEXTAREA_VOICE_INPUT" maxlength="2000" />
-->

<template>
  <VTextarea
    ref="fieldRef"
    v-bind="$attrs"
    :model-value="modelValue"
    :disabled="disabled"
    :takeover="voiceActive"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #takeover>
      <VoiceRecordingPanel
        v-if="voicePanelVisible"
        :state="voicePhase"
        :elapsed-sec="voiceElapsed"
        @cancel="cancel"
        @stop="stop"
      />
    </template>
    <template #trailing>
      <!-- [FE-94] The mic disc. Unlike the composer's mic it renders with
           text present too -- a transcript here APPENDS, so dictation is for
           adding to what is written, not only for starting it. Gone for the
           whole span of a take and whenever the field is disabled. -->
      <VoiceMicButton v-if="voiceInput && !disabled && !voiceActive" @click="micTap" />
    </template>
  </VTextarea>
</template>

<script setup lang="ts">
import { ref, useAttrs } from 'vue'
import { VTextarea } from '@/components/ui'
import { appendTranscript, useVoiceFieldInput } from '@/composables/useVoiceFieldInput'
// Relative file imports: components/shared has no barrel.
import VoiceRecordingPanel from './VoiceRecordingPanel.vue'
import VoiceMicButton from './VoiceMicButton.vue'

// The fallthrough goes to VTextarea explicitly (v-bind above), which in turn
// puts it on the inner <textarea>.
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    modelValue?: string
    disabled?: boolean
    /** [kill-switched per call site] The mic disc in the field's row:
     *  `tap -> record -> transcribe -> the transcript APPENDS`. False keeps
     *  the disc unmounted and every piece of voice machinery unreachable;
     *  the field is then a plain VTextarea. */
    voiceInput?: boolean
  }>(),
  {
    modelValue: '',
    disabled: false,
    voiceInput: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const fieldRef = ref<{ blur: () => void } | null>(null)

// maxlength reaches this component as a fallthrough ATTR; the append clamp
// needs it as a number.
const attrs = useAttrs()
function fieldMaxLength(): number | undefined {
  const raw = attrs.maxlength
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const { voiceActive, voicePhase, voicePanelVisible, voiceElapsed, micTap, stop, cancel } =
  useVoiceFieldInput({
    blurField: () => fieldRef.value?.blur(),
    onTranscript: (text) => {
      emit('update:modelValue', appendTranscript(props.modelValue, text, fieldMaxLength()))
    },
  })
</script>
