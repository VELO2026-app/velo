// =============================================================================
// VELO Frontend -- useVoiceRecorder tests (voice input MVP, step 1)
//
// Browser capture APIs are stubbed at their seams (navigator.mediaDevices,
// MediaRecorder, AudioContext) -- the composable's own state machine, cleanup
// and auto-stop logic run for real. onScopeDispose needs an active scope, so
// every setup runs inside an effectScope (the Vue-idiomatic host for a
// composable outside a component).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { useVoiceRecorder, VOICE_MAX_DURATION_SEC, type VoiceTake } from './useVoiceRecorder'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn(() => true)

  state: 'inactive' | 'recording' = 'inactive'
  private listeners: Record<string, Array<(event: BlobEvent) => void>> = {}

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    for (const fn of this.listeners['stop'] ?? []) fn({} as BlobEvent)
  }

  addEventListener(type: string, listener: (event: BlobEvent) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  emitData(chunk: Blob): void {
    for (const fn of this.listeners['dataavailable'] ?? []) {
      fn({ data: chunk } as BlobEvent)
    }
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  decoded: unknown
  close = vi.fn(async () => {})

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  async decodeAudioData(): Promise<AudioBuffer> {
    // Structural fake: encodeWav only needs sampleRate/length/getChannelData.
    return {
      sampleRate: 16000,
      numberOfChannels: 1,
      length: 16,
      getChannelData: () => new Float32Array(16),
    } as unknown as AudioBuffer
  }
}

function fakeStream(): MediaStream {
  // Stable tracks: every getTracks() call must return the SAME objects, so a
  // test can observe the stop() the composable performed on them.
  const tracks = [{ stop: vi.fn() } as unknown as MediaStreamTrack]
  return { getTracks: () => tracks } as unknown as MediaStream
}

const gumMock = vi.fn()
const onAutoStop = vi.fn()

let scope: EffectScope | null = null
// The composable under test -- hoisted per setup() inside an effect scope.
let recorder: ReturnType<typeof useVoiceRecorder> | null = null

function setup(): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: gumMock },
    configurable: true,
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  scope = effectScope()
  scope.run(() => {
    recorder = useVoiceRecorder({ onAutoStop })
  })
}

async function startRecording(): Promise<FakeMediaRecorder> {
  await recorder!.start()
  const instance = FakeMediaRecorder.instances.at(-1)
  if (!instance) throw new Error('no MediaRecorder instance')
  return instance
}

beforeEach(() => {
  setup()
})

afterEach(() => {
  // Disposal releases mic/timers/listeners exactly as an unmounted component
  // would -- then the stubs go away so test order can never matter.
  scope?.stop()
  scope = null
  recorder = null
  FakeMediaRecorder.instances = []
  FakeAudioContext.instances = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
  gumMock.mockReset()
  onAutoStop.mockReset()
  Object.defineProperty(document, 'hidden', {
    value: false,
    configurable: true,
  })
})

describe('useVoiceRecorder -- start', () => {
  it('a successful start opens the mic and lands in recording', async () => {
    gumMock.mockResolvedValue(fakeStream())
    const instance = await startRecording()

    expect(recorder!.state.value).toBe('recording')
    expect(recorder!.elapsedSec.value).toBe(0)
    expect(gumMock).toHaveBeenCalledWith({ audio: true })
    expect(instance.state).toBe('recording')
    expect(recorder!.errorReason.value).toBeNull()
  })

  it('start while already recording is a no-op (no second MediaRecorder)', async () => {
    gumMock.mockResolvedValue(fakeStream())
    await startRecording()
    await recorder!.start()
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('no getUserMedia/MediaRecorder support -> unsupported, no prompt', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true,
    })
    await recorder!.start()
    expect(recorder!.state.value).toBe('idle')
    expect(recorder!.errorReason.value).toBe('unsupported')
    expect(gumMock).not.toHaveBeenCalled()
  })

  it('a denied mic permission -> permission, back to idle', async () => {
    gumMock.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await recorder!.start()
    expect(recorder!.state.value).toBe('idle')
    expect(recorder!.errorReason.value).toBe('permission')
  })

  it('errorReason resets on the next start attempt', async () => {
    gumMock.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    await recorder!.start()
    expect(recorder!.errorReason.value).toBe('permission')

    gumMock.mockResolvedValue(fakeStream())
    await recorder!.start()
    expect(recorder!.errorReason.value).toBeNull()
    expect(recorder!.state.value).toBe('recording')
  })
})

describe('useVoiceRecorder -- stop / WAV handoff', () => {
  it('stop() resolves a 16 kHz mono WAV take and releases everything', async () => {
    gumMock.mockResolvedValue(fakeStream())
    const instance = await startRecording()
    instance.emitData(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }))

    const take = await recorder!.stop()

    expect(take!.wav.type).toBe('audio/wav')
    // 16 silence frames from the fake decode + 44-byte header.
    expect(take!.wav.size).toBe(44 + 16 * 2)
    // The fake decodes digital silence -- and the peak says so honestly.
    expect(take!.peak).toBe(0)
    expect(recorder!.state.value).toBe('idle')
    // The mic is closed and the AudioContext torn down after the handoff.
    for (const track of instance.stream.getTracks()) {
      expect(track.stop).toHaveBeenCalledTimes(1)
    }
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalled()
  })

  it('an undecodable take stops with null -- never a fake transcript', async () => {
    gumMock.mockResolvedValue(fakeStream())
    const instance = await startRecording()
    // The composable builds its AudioContext lazily at stop time, so swapping
    // the stub NOW is what the stop() path will actually construct.
    vi.stubGlobal(
      'AudioContext',
      class {
        close = vi.fn(async () => {})
        decodeAudioData = vi.fn(async () => {
          throw new Error('not audio')
        })
      },
    )

    const wav = await recorder!.stop()
    expect(wav).toBeNull()
    expect(recorder!.state.value).toBe('idle')
    expect(instance.state).toBe('inactive')
  })

  it('stop() while idle resolves null and does not throw', async () => {
    await expect(recorder!.stop()).resolves.toBeNull()
  })

  it('two stop() calls share one unwinding take', async () => {
    gumMock.mockResolvedValue(fakeStream())
    await startRecording()
    const first: Promise<VoiceTake | null> = recorder!.stop()
    const second: Promise<VoiceTake | null> = recorder!.stop()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
  })
})

describe('useVoiceRecorder -- stopwatch and the 60s cap', () => {
  it('elapsedSec ticks while recording', async () => {
    vi.useFakeTimers()
    gumMock.mockResolvedValue(fakeStream())
    await startRecording()

    await vi.advanceTimersByTimeAsync(2100)
    expect(recorder!.elapsedSec.value).toBe(2)

    await recorder!.stop()
    vi.useRealTimers()
  })

  it('the 60s cap auto-stops and reports through onAutoStop', async () => {
    vi.useFakeTimers()
    gumMock.mockResolvedValue(fakeStream())
    await startRecording()

    await vi.advanceTimersByTimeAsync(VOICE_MAX_DURATION_SEC * 1000 + 500)

    expect(onAutoStop).toHaveBeenCalledTimes(1)
    const take = onAutoStop.mock.calls[0]?.[0] as VoiceTake
    expect(take.wav).toBeInstanceOf(Blob)
    expect(recorder!.state.value).toBe('idle')
    vi.useRealTimers()
  })
})

describe('useVoiceRecorder -- cancel and edges', () => {
  it('cancel() discards silently: idle, no result, mic released', async () => {
    gumMock.mockResolvedValue(fakeStream())
    const instance = await startRecording()

    recorder!.cancel()

    expect(recorder!.state.value).toBe('idle')
    expect(recorder!.elapsedSec.value).toBe(0)
    expect(instance.state).toBe('inactive')
    for (const track of instance.stream.getTracks()) {
      expect(track.stop).toHaveBeenCalled()
    }
    await expect(recorder!.stop()).resolves.toBeNull()
    expect(onAutoStop).not.toHaveBeenCalled()
  })

  it('cancel() while idle is a no-op', () => {
    expect(() => recorder!.cancel()).not.toThrow()
  })

  it('a hidden document mid-recording cancels silently', async () => {
    gumMock.mockResolvedValue(fakeStream())
    await startRecording()

    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(recorder!.state.value).toBe('idle')
    expect(onAutoStop).not.toHaveBeenCalled()
  })

  it('scope disposal releases the mic', async () => {
    gumMock.mockResolvedValue(fakeStream())
    const instance = await startRecording()

    scope?.stop()

    expect(instance.state).toBe('inactive')
    for (const track of instance.stream.getTracks()) {
      expect(track.stop).toHaveBeenCalled()
    }
  })
})
