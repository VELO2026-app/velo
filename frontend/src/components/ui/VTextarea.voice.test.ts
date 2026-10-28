// =============================================================================
// VELO Frontend -- VTextarea voice input tests (voice input, step 2: FE-94)
//
// The step-2 contract, and how it DIFFERS from the composer's (step 1):
//   - the mic is opt-in per call site (`voiceInput`, kill-switched by
//     TEXTAREA_VOICE_INPUT in the views) and renders WITH TEXT PRESENT --
//     a field transcript APPENDS (§11 appendTranscript), dictation is for
//     adding to what is written, not only for starting it;
//   - the append joins honestly: space when needed, straight onto the user's
//     own trailing whitespace, alone in an empty field, never one character
//     past the caller's maxlength.
//
// The recorder composable and the transcription client are mocked at their
// module seams (same as Composer.voice.test.ts): VTextarea + the extracted
// useVoiceFieldInput pipeline are the unit under test. The recorder mock is a
// plain mutable object built from real refs so the component's computeds
// re-render when a test moves the state machine.
//
// Mount pattern: createApp + happy-dom, this repo's convention (no
// @vue/test-utils). The model is driven through emitted update:modelValue
// payloads -- the parent in these tests is static, so the DOM textarea's own
// value would not re-bind and asserting it would test nothing.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import type { useVoiceRecorder, VoiceTake } from '@/composables/useVoiceRecorder'

type RecorderState = 'idle' | 'requesting' | 'recording' | 'processing'
type Recorder = ReturnType<typeof useVoiceRecorder>

// -- Seams -------------------------------------------------------------------

const voiceState = ref<RecorderState>('idle')
const voiceElapsed = ref(0)
const voiceError = ref<'permission' | 'unsupported' | null>(null)

const start = vi.fn(async () => {})
const stop = vi.fn(async (): Promise<VoiceTake | null> => null)
const cancel = vi.fn(() => {})
const transcribeAudio = vi.fn()

const haptics = { impact: vi.fn(), notification: vi.fn() }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

let onAutoStop: ((take: VoiceTake | null) => void) | null = null

/** Reads as the recorder seam in the test bodies below. */
const voice = {
  state: voiceState,
  elapsedSec: voiceElapsed,
  errorReason: voiceError,
  start,
  stop,
  cancel,
  fireAutoStop: (take: VoiceTake | null) => onAutoStop?.(take),
}

vi.mock('@/composables/useVoiceRecorder', () => ({
  useVoiceRecorder: (opts?: { onAutoStop?: (take: VoiceTake | null) => void }) => {
    onAutoStop = opts?.onAutoStop ?? null
    return voice as Recorder
  },
}))
vi.mock('@/api/transcription', () => ({ transcribeAudio }))
vi.mock('@/platform', () => ({
  platform: {
    hapticFeedback: haptics.impact,
    hapticNotification: haptics.notification,
  },
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toast,
}))

// -- Mount helpers -----------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let updates: string[] = []

// Dynamic on purpose: a static import would evaluate useVoiceFieldInput (and
// through it the vi.mock factories' dependencies) before this module's own
// consts initialize -- the hoisting trap Composer.voice.test.ts documents.
let appendTranscript: typeof import('@/composables/useVoiceFieldInput').appendTranscript
beforeAll(async () => {
  ;({ appendTranscript } = await import('@/composables/useVoiceFieldInput'))
})

function mic(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('[data-testid="voice-mic"]') ?? null
}
function panel(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-testid="voice-panel"]') ?? null
}
function panelBtn(testId: string): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`no panel button ${testId}`)
  return el
}
function textareaEl(): HTMLTextAreaElement {
  const el = host?.querySelector('textarea')
  if (!el) throw new Error('textarea did not render')
  return el
}
/** The last value emitted on update:modelValue (the component's contract --
 *  see the banner for why the DOM value is not the assertion target). */
function emitted(): string | undefined {
  return updates.at(-1)
}

async function flush(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await nextTick()
}

async function mount(props: Record<string, unknown> = {}): Promise<void> {
  const { default: VTextarea } = await import('@/components/ui/VTextarea.vue')
  host = document.createElement('div')
  document.body.appendChild(host)
  updates = []
  app = createApp(VTextarea, {
    'onUpdate:modelValue': (v: string) => updates.push(v),
    ...props,
  }).use(createTestI18n())
  app.mount(host)
  await flush(2)
}

/** Places the fake recorder mid-take the way the real one would. */
function beginRecording(elapsed = 5): void {
  voiceState.value = 'recording'
  voiceElapsed.value = elapsed
}

beforeEach(() => {
  voiceState.value = 'idle'
  voiceElapsed.value = 0
  voiceError.value = null
  start.mockClear()
  stop.mockReset()
  // A normal (audible) take by default; silence cases override the peak.
  stop.mockResolvedValue({ wav: new Blob(['default']), peak: 0.5 })
  cancel.mockReset()
  cancel.mockImplementation(() => {
    voiceState.value = 'idle'
    voiceElapsed.value = 0
  })
  transcribeAudio.mockReset()
  transcribeAudio.mockResolvedValue({ ok: true, text: 'дефолтный транскрипт' })
  haptics.impact.mockClear()
  haptics.notification.mockClear()
  toast.success.mockClear()
  toast.error.mockClear()
  toast.info.mockClear()
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

describe('appendTranscript (pure §11 join)', () => {
  it('an empty field takes the transcript alone; the addition is trimmed', () => {
    expect(appendTranscript('', '  привет  ')).toBe('привет')
  })
  it('text present: joins with ONE space', () => {
    expect(appendTranscript('Утро', 'было тихим')).toBe('Утро было тихим')
  })
  it("the user's own trailing whitespace survives -- no extra space", () => {
    expect(appendTranscript('Утро\n', 'продолжение')).toBe('Утро\nпродолжение')
    expect(appendTranscript('Утро ', 'продолжение')).toBe('Утро продолжение')
  })
  it('a whitespace-only addition changes nothing', () => {
    expect(appendTranscript('Утро', '   ')).toBe('Утро')
  })
  it('maxLength caps the RESULT -- separator counted, never one past', () => {
    // 9 chars + a space would already be the 10-char cap: no room for a
    // single letter, the field keeps its text.
    expect(appendTranscript('123456789', 'новое', 10)).toBe('123456789')
    expect(appendTranscript('12345678', 'новое', 10)).toBe('12345678 н')
    expect(appendTranscript('123456789', 'новое', 9)).toBe('123456789')
  })
  it('an already-full field changes nothing', () => {
    expect(appendTranscript('0123456789', 'ещё', 10)).toBe('0123456789')
  })
  it('an empty field under maxLength truncates to the cap', () => {
    expect(appendTranscript('', 'привет', 3)).toBe('при')
  })
})

describe('VTextarea -- mic visibility (opt-in, append-mode)', () => {
  it('voiceInput off (the default): no mic, no panel -- every existing caller unchanged', async () => {
    await mount({ modelValue: 'текст' })
    expect(mic()).toBeNull()
    expect(panel()).toBeNull()
    expect(textareaEl().style.display).not.toBe('none')
  })

  it('THE §11 DIFFERENCE: the mic renders WITH text present (append, not empty-field-only)', async () => {
    await mount({ modelValue: 'Утро было', voiceInput: true })
    expect(mic()).not.toBeNull()
    expect(mic()!.getAttribute('aria-label')).toBe('Голосовой ввод')
  })

  it('a disabled field hides the mic', async () => {
    await mount({ modelValue: '', voiceInput: true, disabled: true })
    expect(mic()).toBeNull()
  })
})

describe('VTextarea -- the take owns the field', () => {
  it('tap: recording starts, the panel stands in for the plate, mic unmounts', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'recording'
    })
    await mount({ voiceInput: true })
    mic()!.click()
    await flush()

    expect(voice.start).toHaveBeenCalledTimes(1)
    expect(haptics.impact).toHaveBeenCalledWith('light')
    expect(panel()).not.toBeNull()
    expect(textareaEl().style.display).toBe('none')
    expect(mic()).toBeNull()
    voice.state.value = 'idle'
  })

  it('the tap drops focus first -- the keyboard never hangs over the panel', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'recording'
    })
    const blurSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'blur')
    try {
      await mount({ voiceInput: true })
      textareaEl().focus()
      mic()!.click()
      await flush()
      expect(blurSpy).toHaveBeenCalled()
    } finally {
      blurSpy.mockRestore()
    }
    voice.state.value = 'idle'
  })

  it('requesting (permission prompt): the field freezes HIDDEN as an empty band -- no premature busy panel, mic gone; a denial returns the field', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'requesting'
    })
    await mount({ modelValue: 'Утро', voiceInput: true })
    mic()!.click()
    await flush()

    // The composer's own rule: the take owns the field from the permission
    // prompt on -- editable text must not sit under an open OS dialog.
    expect(textareaEl().style.display).toBe('none')
    expect(mic()).toBeNull()
    expect(panel()).toBeNull()
    const band = host!.querySelector('.v-textarea__voice')
    expect(band).not.toBeNull() // the frozen band holds the row's shape
    expect(band!.querySelector('[data-testid="voice-panel"]')).toBeNull()

    // Denied: the row thaws exactly where it was, text intact.
    voiceState.value = 'idle'
    await flush()
    expect(textareaEl().style.display).not.toBe('none')
    expect(host!.querySelector('.v-textarea__voice')).toBeNull()
    expect(mic()).not.toBeNull()
  })

  it('the stopwatch drives the panel readout', async () => {
    beginRecording(7)
    await mount({ voiceInput: true })
    await flush()
    expect(panel()!.querySelector('[data-testid="voice-elapsed"]')!.textContent).toBe('0:07')
    voice.state.value = 'idle'
  })
})

describe('VTextarea -- stop, too-short, cancel', () => {
  it('stop under 1s: cancel + honest hint, no transcription', async () => {
    beginRecording(0)
    await mount({ voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(voice.cancel).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith('Запись слишком короткая')
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(panel()).toBeNull()
    voice.state.value = 'idle'
  })

  it('cancel (✕): silent discard -- no toast, no transcription, value untouched', async () => {
    beginRecording(5)
    await mount({ modelValue: 'Утро', voiceInput: true })
    panelBtn('voice-cancel').click()
    voice.state.value = 'idle'
    await flush()

    expect(voice.cancel).toHaveBeenCalledTimes(1)
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })
})

describe('VTextarea -- the transcript APPENDS', () => {
  function audibleTake() {
    voice.stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return { wav: new Blob(['wav-bytes']), peak: 0.5 }
    })
  }

  it('stop ≥1s: text present -> emitted value = old text + space + transcript', async () => {
    audibleTake()
    transcribeAudio.mockResolvedValue({ ok: true, text: 'продолжение с голоса' })
    beginRecording(5)
    await mount({ modelValue: 'Утро было тихим', voiceInput: true })

    panelBtn('voice-stop').click()
    await flush()

    expect(voice.stop).toHaveBeenCalledTimes(1)
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Blob))
    expect(haptics.notification).toHaveBeenCalledWith('success')
    expect(emitted()).toBe('Утро было тихим продолжение с голоса')
    expect(panel()).toBeNull()
    expect(mic()).not.toBeNull()
  })

  it('empty field: the transcript lands alone', async () => {
    audibleTake()
    transcribeAudio.mockResolvedValue({ ok: true, text: 'первая фраза' })
    beginRecording(5)
    await mount({ modelValue: '', voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(emitted()).toBe('первая фраза')
  })

  it("the user's trailing newline survives -- no injected space", async () => {
    audibleTake()
    transcribeAudio.mockResolvedValue({ ok: true, text: 'новый абзац' })
    beginRecording(5)
    await mount({ modelValue: 'Утро\n', voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(emitted()).toBe('Утро\nновый абзац')
  })

  it("the caller's maxlength attr caps the append", async () => {
    audibleTake()
    transcribeAudio.mockResolvedValue({ ok: true, text: 'новое слово' })
    beginRecording(5)
    await mount({ modelValue: '01234567', voiceInput: true, maxlength: 10 })
    panelBtn('voice-stop').click()
    await flush()

    // Room for the join space and exactly one letter -- then the cap.
    expect(emitted()).toBe('01234567 н')
  })

  it('the auto-stop path feeds the same append flow', async () => {
    const take = { wav: new Blob(['auto']), peak: 0.5 }
    transcribeAudio.mockResolvedValue({ ok: true, text: 'диктовка до лимита' })
    await mount({ modelValue: 'Было', voiceInput: true })
    voiceState.value = 'idle'
    voice.fireAutoStop(take)
    await flush()

    expect(transcribeAudio).toHaveBeenCalledWith(take.wav)
    expect(emitted()).toBe('Было диктовка до лимита')
  })

  it('no autofocus: the keyboard does not rise on the transcript', async () => {
    audibleTake()
    transcribeAudio.mockResolvedValue({ ok: true, text: 'текст' })
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    try {
      beginRecording(5)
      await mount({ voiceInput: true })
      panelBtn('voice-stop').click()
      await flush()
      expect(focusSpy).not.toHaveBeenCalled()
    } finally {
      focusSpy.mockRestore()
    }
  })
})

describe('VTextarea -- honest failures', () => {
  it('a denied mic permission answers with the exact toast, field untouched', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'idle'
      voice.errorReason.value = 'permission'
    })
    await mount({ modelValue: 'Утро', voiceInput: true })
    mic()!.click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Доступ к микрофону запрещён')
    expect(haptics.impact).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('an unsupported browser answers with the device toast', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'idle'
      voice.errorReason.value = 'unsupported'
    })
    await mount({ voiceInput: true })
    mic()!.click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Микрофон недоступен на этом устройстве')
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('a SILENT take never reaches transcription and leaves the value untouched', async () => {
    voice.stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return { wav: new Blob(['silence']), peak: 0.001 }
    })
    beginRecording(5)
    await mount({ modelValue: 'Утро', voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Не удалось распознать речь')
    expect(updates).toEqual([])
  })

  it('a transcription failure toasts the mapped message and keeps the old text', async () => {
    voice.stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return { wav: new Blob(['wav-bytes']), peak: 0.5 }
    })
    transcribeAudio.mockResolvedValue({ ok: false, error: 'Сервис транскрибации недоступен' })
    beginRecording(5)
    await mount({ modelValue: 'Утро', voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Сервис транскрибации недоступен')
    expect(haptics.notification).toHaveBeenCalledWith('error')
    expect(updates).toEqual([])
  })

  it('an undecodable take (null wav) never reaches transcription', async () => {
    voice.stop.mockResolvedValue(null)
    beginRecording(5)
    await mount({ voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Не удалось распознать речь')
    expect(updates).toEqual([])
  })
})

describe('VTextarea -- the processing freeze', () => {
  it('pending transcription: busy panel, disabled controls, field stays hidden', async () => {
    let releaseTranscription: (r: { ok: boolean; text?: string }) => void = () => {}
    voice.stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return { wav: new Blob(['wav-bytes']), peak: 0.5 }
    })
    transcribeAudio.mockImplementation(
      () =>
        new Promise<{ ok: boolean; text?: string }>((resolve) => {
          releaseTranscription = resolve
        }),
    )
    beginRecording(5)
    await mount({ modelValue: 'Утро', voiceInput: true })
    panelBtn('voice-stop').click()
    await flush()

    expect(panel()).not.toBeNull()
    expect(panel()!.querySelector('[data-testid="voice-busy"]')).not.toBeNull()
    expect(panelBtn('voice-cancel').disabled).toBe(true)
    expect(panelBtn('voice-stop').disabled).toBe(true)
    expect(textareaEl().style.display).toBe('none')
    expect(mic()).toBeNull()

    releaseTranscription({ ok: true, text: 'дошло' })
    await flush()
    expect(panel()).toBeNull()
    expect(emitted()).toBe('Утро дошло')
  })
})
