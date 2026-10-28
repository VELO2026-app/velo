/**
 * VELO Frontend -- useVoiceFieldInput (voice input, step 2: FE-94)
 *
 * The transcription half of FIELD voice input, extracted from the flow
 * Composer.vue carried alone in step 1: recorder lifecycle observables, the
 * take->transcript round-trip, and every user-facing consequence of it --
 * toasts (the same composer.* texts), haptics, the local silence rejection.
 * What the caller keeps is the two decisions that differ per surface: what a
 * transcript DOES to the field (onTranscript -- the composer replaces, a
 * diary textarea APPENDS, see appendTranscript below) and how to drop focus
 * before a take so the keyboard never hangs over the recording panel.
 *
 * THE PANEL CONTRACT, so every surface renders the same take: micTap opens a
 * recording; the caller's field yields its row for the WHOLE voiceActive span
 * -- hidden, not merely disabled, exactly like the composer hides its textarea
 * -- while the panel itself waits for an actual take (voicePanelVisible:
 * recording, plus the processing/transcription freeze). voiceActive spans the
 * `requesting` permission prompt too, when the row freezes as an empty band
 * WITHOUT a premature «Транскрибация…». Mic/stop buttons unmount for the whole
 * span.
 *
 * Composer.vue deliberately keeps its own copy of this flow: its version is
 * interwoven with the draft-preview suppression and capsule autogrow, and its
 * tests (Composer.voice.test.ts) mock the recorder seam this composable
 * would hide. Merging them is a refactor for a calm moment, not a rider on
 * this feature.
 */

import { computed, ref } from 'vue'
import { t } from '@/locales'
import { useToast } from '@/composables/useToast'
import { useVoiceRecorder, type VoiceTake } from '@/composables/useVoiceRecorder'
import { transcribeAudio } from '@/api/transcription'
import { SILENCE_PEAK_THRESHOLD } from '@/utils/audio'
import { platform } from '@/platform'

export interface VoiceFieldInputOptions {
  /** Receives each successful transcript; the caller decides append or
   *  replace. Runs BEFORE the busy freeze lifts, while the field is still
   *  hidden behind the panel -- re-measure any autogrow on the freeze's end
   *  (watch voicePanelVisible), not here. */
  onTranscript: (text: string) => void
  /** Called right before the mic request opens: the caller drops focus from
   *  its field so the keyboard cannot hang over the recording panel. */
  blurField?: () => void
}

export function useVoiceFieldInput(options: VoiceFieldInputOptions) {
  const toast = useToast()

  const {
    state: recorderState,
    elapsedSec: recorderElapsed,
    errorReason: recorderError,
    start: startRecorder,
    stop: stopRecorder,
    cancel: cancelRecorder,
  } = useVoiceRecorder({ onAutoStop: (take) => void takeReady(take) })

  /** The transcription round-trip: still part of "the take owns the field",
   *  so the row stays frozen until the transcript lands or the toast shows. */
  const transcribing = ref(false)

  /** True while a take owns the field: requesting/recording/encoding plus the
   *  transcription request. Drives the hidden field and the absent mic. */
  const voiceActive = computed(() => recorderState.value !== 'idle' || transcribing.value)

  /** What the panel renders: live recording vs any processing-flavoured phase
   *  (WAV encode and the transcription request both freeze the row). */
  const voicePhase = computed<'recording' | 'processing'>(() =>
    recorderState.value === 'recording' ? 'recording' : 'processing',
  )

  /** The panel itself waits for an actual take: the transient `requesting`
   *  phase (permission prompt) freezes the row WITHOUT a premature
   *  «Транскрибация…». */
  const voicePanelVisible = computed(
    () =>
      recorderState.value === 'recording' ||
      recorderState.value === 'processing' ||
      transcribing.value,
  )

  const voiceElapsed = computed(() => recorderElapsed.value)

  async function micTap(): Promise<void> {
    if (voiceActive.value) return
    // The keyboard must not hang over the recording panel: drop focus first.
    options.blurField?.()
    await startRecorder()
    if (recorderState.value === 'recording') {
      platform.hapticFeedback('light')
      return
    }
    // Honest failure, exact texts from the error table.
    if (recorderError.value === 'permission') {
      toast.error(t('composer.micDenied'))
    } else {
      toast.error(t('composer.micUnavailable'))
    }
  }

  /** The panel's ✕: silent discard -- an aborted take is not an error and
   *  needs no toast. Also the "surface is going away" escape hatch (e.g. the
   *  diary editor left mid-take). Non-idle, not just recording: a surface
   *  unmounted while the PERMISSION PROMPT sat open must kill that request
   *  too -- the recorder's own generation guard (FE-78.1) then discards the
   *  mic stream whenever the late getUserMedia answer arrives, so no orphaned
   *  recording starts with its panel already gone. */
  function cancel(): void {
    if (recorderState.value === 'idle') return
    cancelRecorder()
  }

  /** The panel's ⏹. */
  async function stop(): Promise<void> {
    if (recorderState.value !== 'recording') return
    if (recorderElapsed.value < 1) {
      cancelRecorder()
      toast.info(t('composer.tooShort'))
      return
    }
    // Freeze the row BEFORE the recorder unwinds: its state passes through
    // 'idle' for one tick on the way down, and without this the field would
    // flicker back mid-stop.
    transcribing.value = true
    try {
      await takeReady(await stopRecorder())
    } finally {
      transcribing.value = false
    }
  }

  /** A finished take: transcribe and hand the text to the caller. A silent
   *  take (tap stop without speaking) or a null one (decode failure) never
   *  reaches the network -- the failure is an honest toast, the field stays
   *  untouched. Sets/clears the transcribing freeze itself, so the auto-stop
   *  path gets the same frozen row without a dip through idle. */
  async function takeReady(take: VoiceTake | null): Promise<void> {
    transcribing.value = true
    try {
      if (!take || take.peak < SILENCE_PEAK_THRESHOLD) {
        // Nothing audible: the model would answer with an apologetic sentence
        // that would land in the field as a fake transcript -- reject locally.
        platform.hapticNotification('error')
        toast.error(t('composer.notRecognized'))
        return
      }
      const result = await transcribeAudio(take.wav)
      if (result.ok && result.text) {
        options.onTranscript(result.text)
        platform.hapticNotification('success')
      } else {
        // An ok response with no usable text is still a recognition failure.
        platform.hapticNotification('error')
        toast.error(result.error ?? t('composer.notRecognized'))
      }
    } finally {
      transcribing.value = false
    }
  }

  return {
    voiceActive,
    voicePhase,
    voicePanelVisible,
    voiceElapsed,
    micTap,
    stop,
    cancel,
  }
}

/** §11 `appendTranscript`: how a transcript joins text that is already in the
 * field. Unlike the composer (empty-field-only, replace) a diary textarea
 * GROWS by voice -- the mic stays available with text present, and a fresh
 * take glues onto the end of what is there: nothing when the field is empty,
 * straight on when the text already ends in whitespace (the user's own line
 * break survives), a single space otherwise. `maxLength`, when the caller
 * knows one (its maxlength attr), stops the append where the browser would
 * have stopped typing -- separator included in the count, so the result
 * NEVER runs one character past the cap. */
export function appendTranscript(current: string, addition: string, maxLength?: number): string {
  const text = addition.trim()
  if (!text) return current
  if (current.length === 0) {
    return maxLength === undefined ? text : text.slice(0, maxLength)
  }
  const joiner = /\s$/.test(current) ? '' : ' '
  const total = current + joiner + text
  if (maxLength === undefined || total.length <= maxLength) return total
  const room = maxLength - current.length - joiner.length
  if (room <= 0) return current
  return current + joiner + text.slice(0, room)
}
