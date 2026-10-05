/**
 * VELO Frontend -- useVoiceRecorder (voice input MVP, step 1)
 *
 * The recording half of composer voice input: MediaRecorder lifecycle wrapped
 * in a small state machine, plus the WAV handoff. Transcription does NOT live
 * here -- the caller (Composer) owns the transcription round-trip and the toasts
 * (the voice-input spec file was never committed to the repo; FE-75 in Linear
 * carries the step split and the step-2 scope).
 *
 * STATE MACHINE: idle -> requesting -> recording -> processing -> idle.
 *   - requesting: getUserMedia permission prompt in flight (UI shows nothing
 *     new; a denial lands in errorReason).
 *   - recording:  mic open, stopwatch ticking (elapsedSec, ~200ms cadence).
 *   - processing: stop() called -- tape stopped, WebAudio decode + WAV encode
 *     running; resolves to the wav Blob (null on decode failure).
 * CANCELLATION is silent by design: cancel() discards the take with no error
 * state and no toast -- only the caller decides what (if anything) to show.
 *
 * OWNED EDGES:
 *   - 60s cap fires onAutoStop with the same result stop() would return.
 *   - document.hidden mid-recording cancels silently (the user cannot see or
 *     stop a recording whose tab vanished; iOS may kill the capture anyway).
 *   - scope disposal releases the mic, timers, AudioContext, listeners.
 */

import { onScopeDispose, ref } from 'vue'
import { encodeWav, peakAmplitude, pickRecorderMime } from '@/utils/audio'
import { onDocumentEvent, offDocumentEvent, isDocumentHidden } from '@/platform/dom'

export type VoiceRecorderState = 'idle' | 'requesting' | 'recording' | 'processing'

/** Why the last start() failed -- the CALLER turns this into user-facing text. */
export type VoiceRecorderError = 'permission' | 'unsupported'

/** A finished take: the WAV handoff plus the peak amplitude (0..1) of the
 * source audio, so the caller can reject a silent take locally without
 * burning a transcription request (the model answers silence with apology
 * text that would otherwise land in the field as a fake transcript). */
export interface VoiceTake {
  wav: Blob
  peak: number
}

export const VOICE_MAX_DURATION_SEC = 60
/** Stopwatch cadence. Sub-second is enough; coarser reads as stuck. */
const TICK_MS = 200

export interface VoiceRecorderOptions {
  /** Fires when the 60s cap stops the take on its own (not from stop()). */
  onAutoStop?: (take: VoiceTake | null) => void
}

export function useVoiceRecorder(options: VoiceRecorderOptions = {}) {
  const state = ref<VoiceRecorderState>('idle')
  const elapsedSec = ref(0)
  const errorReason = ref<VoiceRecorderError | null>(null)

  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let startedAt: number | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let audioContext: AudioContext | null = null
  /** stop() re-returns this while a stop is already unwinding. */
  let stopPromise: Promise<VoiceTake | null> | null = null
  /** FE-78.1: bumped by cancel()/dispose() so a getUserMedia answer that
   * arrives after its own request was abandoned (the permission prompt sat
   * open while the person bailed) is recognized as dead and never turns
   * into a recording. */
  let generation = 0

  function isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    )
  }

  function clearTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }

  function releaseStream(): void {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
  }

  function closeAudioContext(): void {
    if (audioContext !== null) {
      void audioContext.close().catch(() => {})
      audioContext = null
    }
  }

  function teardownAfterTake(): void {
    recorder = null
    releaseStream()
    closeAudioContext()
    chunks = []
    elapsedSec.value = 0
  }

  /** Open the mic and start recording. No-op unless idle; failures land in
   * errorReason (never a throw -- the caller maps them to honest toasts). */
  async function start(): Promise<void> {
    if (state.value !== 'idle') return
    errorReason.value = null

    if (!isSupported()) {
      errorReason.value = 'unsupported'
      return
    }

    state.value = 'requesting'
    const requestGeneration = generation
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      if (requestGeneration !== generation) return
      state.value = 'idle'
      errorReason.value = 'permission'
      return
    }
    // The request was cancelled (or the composable disposed) while the
    // permission prompt sat open: the late mic stream is released, nothing
    // records, and the state stays exactly where cancel() left it.
    if (requestGeneration !== generation) {
      releaseStream()
      return
    }

    chunks = []
    const mimeType = pickRecorderMime()
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    recorder.start()

    startedAt = Date.now()
    elapsedSec.value = 0
    state.value = 'recording'
    ticker = setInterval(() => {
      if (state.value !== 'recording') return
      elapsedSec.value = Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000)
      if (elapsedSec.value >= VOICE_MAX_DURATION_SEC) {
        void finishTake('auto')
      }
    }, TICK_MS)
  }

  async function finishTake(mode: 'manual' | 'auto'): Promise<VoiceTake | null> {
    if (state.value !== 'recording') return null
    clearTicker()
    state.value = 'processing'

    // The final dataavailable races recorder.stop(); the stop event is the
    // "tape is closed" signal. An already-inactive recorder means the engine
    // stopped on its own -- take whatever chunks exist.
    const finalChunks = await new Promise<Blob[]>((resolve) => {
      const rec = recorder
      if (!rec || rec.state === 'inactive') {
        resolve(chunks)
        return
      }
      rec.addEventListener('stop', () => resolve(chunks))
      try {
        rec.stop()
      } catch {
        resolve(chunks)
      }
    })

    const raw = new Blob(finalChunks, {
      type: finalChunks[0]?.type || 'audio/webm',
    })
    const take = await toWav(raw)
    teardownAfterTake()
    startedAt = null
    state.value = 'idle'

    if (mode === 'auto') options.onAutoStop?.(take)
    return take
  }

  async function toWav(raw: Blob): Promise<VoiceTake | null> {
    try {
      const encoded = await raw.arrayBuffer()
      audioContext = audioContext ?? new AudioContext()
      const decoded = await audioContext.decodeAudioData(encoded)
      return { wav: encodeWav(decoded), peak: peakAmplitude(decoded) }
    } catch {
      // Un-decodable take: null, not a fake transcript.
      return null
    }
  }

  /** Manual stop: recording -> processing -> the take (null on failure).
   * Idempotent while a stop is already in flight. */
  function stop(): Promise<VoiceTake | null> {
    if (state.value === 'recording') {
      stopPromise = finishTake('manual').finally(() => {
        stopPromise = null
      })
      return stopPromise
    }
    return stopPromise ?? Promise.resolve(null)
  }

  /** Silent discard: no processing, no result, no error state. */
  function cancel(): void {
    if (state.value === 'idle') return
    generation += 1
    clearTicker()
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop()
    } catch {
      // Already inactive -- nothing to stop.
    }
    teardownAfterTake()
    startedAt = null
    stopPromise = null
    state.value = 'idle'
  }

  function onVisibilityChange(): void {
    if (isDocumentHidden() && state.value === 'recording') cancel()
  }
  onDocumentEvent('visibilitychange', onVisibilityChange)

  onScopeDispose(() => {
    offDocumentEvent('visibilitychange', onVisibilityChange)
    cancel()
  })

  return { state, elapsedSec, errorReason, start, stop, cancel }
}
