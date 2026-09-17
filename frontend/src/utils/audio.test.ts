// =============================================================================
// VELO Frontend -- audio utils tests (voice input MVP, step 1)
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  WAV_SAMPLE_RATE,
  blobToBase64,
  encodeWav,
  formatStopwatch,
  peakAmplitude,
  pickRecorderMime,
} from './audio'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('peakAmplitude', () => {
  const buffer = (
    samples: number[],
    channels = 1,
  ): {
    sampleRate: number
    numberOfChannels: number
    length: number
    getChannelData: (ch: number) => Float32Array
  } => ({
    sampleRate: 16000,
    numberOfChannels: channels,
    length: samples.length / channels,
    getChannelData: (ch: number) =>
      Float32Array.from(samples.filter((_, i) => i % channels === ch)),
  })

  it('digital silence peaks at exactly 0', () => {
    expect(peakAmplitude(buffer([0, 0, 0, 0]))).toBe(0)
  })

  it('returns the largest absolute downmixed sample', () => {
    expect(peakAmplitude(buffer([0.25, -0.5, 0.1]))).toBe(0.5)
  })

  it('stereo downmix halves identical channel content', () => {
    // Interleaved frames: L=1/R=0 then L=-1/R=0 -> downmixed ±0.5.
    expect(peakAmplitude(buffer([1, 0, -1, 0], 2))).toBeCloseTo(0.5, 12)
  })
})

describe('formatStopwatch', () => {
  it('formats M:SS with zero padding', () => {
    expect(formatStopwatch(0)).toBe('0:00')
    expect(formatStopwatch(7)).toBe('0:07')
    expect(formatStopwatch(60)).toBe('1:00')
    expect(formatStopwatch(67)).toBe('1:07')
    expect(formatStopwatch(3599)).toBe('59:59')
  })

  it('floors fractional seconds and never goes negative', () => {
    expect(formatStopwatch(1.9)).toBe('0:01')
    expect(formatStopwatch(-5)).toBe('0:00')
  })
})

describe('pickRecorderMime', () => {
  it('returns the first supported candidate in preference order', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (t: string) => t === 'audio/mp4',
    })
    expect(pickRecorderMime()).toBe('audio/mp4')
  })

  it('returns undefined when nothing is supported or the API is absent', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false })
    expect(pickRecorderMime()).toBeUndefined()

    vi.stubGlobal('MediaRecorder', undefined)
    expect(pickRecorderMime()).toBeUndefined()
  })
})

describe('blobToBase64', () => {
  it('returns bare base64 without the data: URL prefix', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    await expect(blobToBase64(blob)).resolves.toBe('AQID')
  })
})

describe('encodeWav', () => {
  function viewOf(blob: Blob): Promise<DataView> {
    return blob.arrayBuffer().then((buf) => new DataView(buf))
  }

  function expectAscii(view: DataView, offset: number, text: string): void {
    let out = ''
    for (let i = 0; i < text.length; i++) {
      out += String.fromCharCode(view.getUint8(offset + i))
    }
    expect(out).toBe(text)
  }

  it('passes 16 kHz mono samples through 1:1 as PCM16 with a canonical header', async () => {
    const blob = encodeWav({
      sampleRate: 16000,
      numberOfChannels: 1,
      length: 4,
      getChannelData: () => new Float32Array([0, 0.5, -0.5, 1]),
    })
    expect(blob.type).toBe('audio/wav')
    const view = await viewOf(blob)

    expectAscii(view, 0, 'RIFF')
    expectAscii(view, 8, 'WAVE')
    expectAscii(view, 12, 'fmt ')
    expectAscii(view, 36, 'data')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(WAV_SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(8) // 4 samples * 2 bytes
    expect(view.getUint32(4, true)).toBe(36 + 8)

    expect(view.getInt16(44 + 0, true)).toBe(0)
    expect(view.getInt16(44 + 2, true)).toBe(Math.round(0.5 * 0x7fff))
    expect(view.getInt16(44 + 4, true)).toBe(Math.round(-0.5 * 0x8000))
    expect(view.getInt16(44 + 6, true)).toBe(0x7fff) // clamped, not wrapped
  })

  it('downmixes stereo and resamples to 16 kHz', async () => {
    // 48 kHz, 6 frames x 2 channels -> 2 frames at 16 kHz.
    const left = new Float32Array([1, 0, 0, -1, 0.5, -0.5])
    const right = new Float32Array([-1, 0, 0, 1, -0.5, 0.5])
    const blob = encodeWav({
      sampleRate: 48000,
      numberOfChannels: 2,
      length: 6,
      getChannelData: (ch) => (ch === 0 ? left : right),
    })
    const view = await viewOf(blob)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(4) // 2 frames * 2 bytes
    expect(view.byteLength).toBe(44 + 4)
    // Frame 0 downmix: (1 + -1) / 2 = 0; frame 1: (-1 + 1) / 2 = 0.
    expect(view.getInt16(44 + 0, true)).toBe(0)
    expect(view.getInt16(44 + 2, true)).toBe(0)
  })

  it('out-of-range input clamps into the PCM16 range instead of wrapping', async () => {
    const blob = encodeWav({
      sampleRate: 16000,
      numberOfChannels: 1,
      length: 2,
      getChannelData: () => new Float32Array([1.5, -1.5]),
    })
    const view = await viewOf(blob)
    expect(view.getInt16(44 + 0, true)).toBe(0x7fff)
    expect(view.getInt16(44 + 2, true)).toBe(-0x8000)
  })

  it('degenerate buffers produce a valid header-only WAV', async () => {
    const blob = encodeWav({
      sampleRate: 0,
      numberOfChannels: 1,
      length: 10,
      getChannelData: () => new Float32Array(10),
    })
    const view = await viewOf(blob)
    expect(view.byteLength).toBe(44)
    expectAscii(view, 0, 'RIFF')
    expect(view.getUint32(40, true)).toBe(0)
  })
})
