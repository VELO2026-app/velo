/**
 * VELO Frontend -- Audio helpers (voice input MVP, step 1)
 *
 * Pure, browser-surface-only helpers shared by the voice recorder
 * (useVoiceRecorder) and the transcription client. No Vue here:
 * everything is either a pure function over data (testable without a
 * microphone) or a thin FileReader bridge.
 *
 * WHY WAV: the audio models our backend transcribes with accept only
 * wav/mp3 as input_audio, while MediaRecorder on iOS Safari produces mp4/aac
 * and on Android/Chrome webm/opus. We standardise on PCM WAV: decode with the
 * WebAudio API and re-encode 16 kHz mono PCM16 below -- small, universally
 * accepted, and good enough for speech.
 */

/** OpenAI audio models take 16 kHz mono happily; speech needs no more. */
export const WAV_SAMPLE_RATE = 16000

/** Structural subset of AudioBuffer encodeWav actually needs -- tests pass
 * plain objects, real recordings pass a decoded AudioBuffer. */
export interface EncodableAudioBuffer {
  sampleRate: number
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}

/** M:SS stopwatch, floored, never negative (cap is 60s so M stays small). */
export function formatStopwatch(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Best container/codec the current engine's MediaRecorder can produce.
 * Order = preference (opus-in-webm is the smallest for speech). Undefined
 * means "let the browser pick its default" -- MediaRecorder is optional to
 * construct without options. */
export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}

/** Blob -> bare base64 (no data: URL prefix) -- the input_audio.data shape. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL always resolves to a string; narrow for the type system.
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'))
    reader.readAsDataURL(blob)
  })
}

/** Mono downmix shared by encodeWav and peakAmplitude. */
function downmix(buffer: EncodableAudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length)
  const channels = Math.max(1, buffer.numberOfChannels)
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0
    for (let ch = 0; ch < channels; ch++) {
      sum += buffer.getChannelData(ch)[i] ?? 0
    }
    mono[i] = sum / channels
  }
  return mono
}

/** Peak absolute sample (0..1) of the downmixed audio. The recorder hands it
 * to the caller so a SILENT take (record-start + stop, nothing said) can be
 * rejected locally -- the audio model answers pure silence with an apologetic
 * sentence, which must never land in the composer as a "transcript". */
export function peakAmplitude(buffer: EncodableAudioBuffer): number {
  const mono = downmix(buffer)
  let peak = 0
  for (let i = 0; i < mono.length; i++) {
    const abs = Math.abs(mono[i] ?? 0)
    if (abs > peak) peak = abs
  }
  return peak
}

/** Below this peak (≈ -40 dBFS) a take counts as "nothing was said".
 * Deliberately LOW: a mic noise floor sits around -60..-40 dBFS, and real
 * speech peaks far above -- we would rather send a quiet take to the model
 * than discard a genuine whisper. */
export const SILENCE_PEAK_THRESHOLD = 0.01

/** Resampled PCM16 mono WAV (RIFF/WAVE) built from a decoded audio buffer.
 * Pure over the buffer's data: downmix every channel, linear-interpolate to
 * 16 kHz, clamp to [-1, 1]. A degenerate buffer (empty / zero rate) yields a
 * valid header-only file rather than a corrupt one. */
export function encodeWav(buffer: EncodableAudioBuffer): Blob {
  const empty = new ArrayBuffer(44)
  const emptyView = new DataView(empty)
  writeWavHeader(emptyView, 0)
  if (buffer.length <= 0 || !(buffer.sampleRate > 0)) {
    return new Blob([empty], { type: 'audio/wav' })
  }

  const mono = downmix(buffer)

  // Linear interpolation to the target rate.
  const ratio = buffer.sampleRate / WAV_SAMPLE_RATE
  const targetLength = Math.max(1, Math.round(buffer.length / ratio))
  const pcm = new Int16Array(targetLength)
  for (let i = 0; i < targetLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, buffer.length - 1)
    const frac = pos - i0
    const sample = (mono[i0] ?? 0) * (1 - frac) + (mono[i1] ?? 0) * frac
    const clamped = Math.max(-1, Math.min(1, sample))
    pcm[i] = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff))
  }

  const bytes = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(bytes)
  writeWavHeader(view, pcm.length * 2)
  new Int16Array(bytes, 44).set(pcm)
  return new Blob([bytes], { type: 'audio/wav' })
}

/** 44-byte canonical PCM WAV header (mono, 16 kHz, 16-bit) + data size. */
function writeWavHeader(view: DataView, dataByteLength: number): void {
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataByteLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, WAV_SAMPLE_RATE, true)
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataByteLength, true)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
