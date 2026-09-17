// =============================================================================
// VELO Frontend -- Composer voice input tests (voice input MVP, step 1)
//
// The recorder composable and the OpenRouter wrapper are mocked at their
// module seams: Composer is the unit under test (state ownership, guards,
// toast texts, haptics, what replaces what in the row). The recorder mock is
// a plain mutable object so each test can place the state machine exactly
// where the scenario needs it -- the recorder's own transitions are covered
// in useVoiceRecorder.test.ts.
//
// Mount pattern: createApp + happy-dom, this repo's convention (see
// DiaryComposer.test.ts -- no @vue/test-utils).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import type { useVoiceRecorder, VoiceTake } from '@/composables/useVoiceRecorder'

type RecorderState = 'idle' | 'requesting' | 'recording' | 'processing'
type Recorder = ReturnType<typeof useVoiceRecorder>

// -- Seams -------------------------------------------------------------------
// The recorder mock's state is built from REAL Vue refs: the component's
// computeds must re-render when a test moves the state machine, exactly as
// they do with the production composable. The vi.mock factories below close
// over these module-scope bindings; they run lazily on the FIRST dynamic
// import of Composer.vue (inside mount()), after the bindings exist -- which
// is also why Composer is never imported statically here.

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
vi.mock('@/api/openrouter', () => ({ transcribeAudio }))
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
let composingEvents: boolean[] = []

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
function sendSlot(): Element | null {
  return host?.querySelector('.composer__slot') ?? null
}
function typeText(value: string): void {
  const el = textareaEl()
  el.value = value
  el.dispatchEvent(new Event('input'))
}

async function flush(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await nextTick()
}

async function mount(props: Record<string, unknown> = { voiceInput: true }): Promise<void> {
  const { default: Composer } = await import('./Composer.vue')
  host = document.createElement('div')
  document.body.appendChild(host)
  composingEvents = []
  app = createApp(Composer, {
    placeholder: 'Сообщение',
    send: async () => ({ ok: true }),
    onComposingChange: (v: boolean) => composingEvents.push(v),
    ...props,
  })
  app.mount(host)
  await flush(2)
}

/** Places the fake recorder mid-take the way the real one would. */
function beginRecording(elapsed = 5): void {
  voiceState.value = 'recording'
  voiceElapsed.value = elapsed
}

beforeEach(() => {
  localStorage.clear()
  voiceState.value = 'idle'
  voiceElapsed.value = 0
  voiceError.value = null
  start.mockClear()
  stop.mockReset()
  // A normal (audible) take by default; silence cases override the peak.
  stop.mockResolvedValue({ wav: new Blob(['default']), peak: 0.5 })
  // The mock cancel mirrors the real recorder: an aborted take lands back in
  // idle with the stopwatch reset.
  cancel.mockReset()
  cancel.mockImplementation(() => {
    voiceState.value = 'idle'
    voiceElapsed.value = 0
  })
  transcribeAudio.mockReset()
  // The default stop now yields an audible take, so the default transcription
  // answer must exist too -- tests that care override both.
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

describe('Composer -- mic visibility (empty-field-only, kill-switch)', () => {
  it('renders on an empty field only when voiceInput is on; a lone space unmounts it, clear brings it back', async () => {
    await mount()
    expect(mic()).not.toBeNull()
    expect(mic()!.getAttribute('aria-label')).toBe('Голосовой ввод')

    typeText('привет')
    await flush()
    expect(mic()).toBeNull()

    typeText(' ') // whitespace-only still counts as "not empty" for the mic
    await flush()
    expect(mic()).toBeNull()

    typeText('')
    await flush()
    expect(mic()).not.toBeNull()
  })

  it('voiceInput=false: the mic never renders (kill-switch, no other change)', async () => {
    await mount({ voiceInput: false })
    expect(mic()).toBeNull()
    expect(sendSlot()).not.toBeNull()
    expect(panel()).toBeNull()
  })
})

describe('Composer -- the recording phase', () => {
  it('tap: light haptic, panel replaces the field, mic and send slot unmount', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'recording'
    })
    await mount()
    mic()!.click()
    await flush()

    expect(voice.start).toHaveBeenCalledTimes(1)
    expect(haptics.impact).toHaveBeenCalledWith('light')
    expect(panel()).not.toBeNull()
    expect(textareaEl().style.display).toBe('none')
    expect(mic()).toBeNull()
    expect(sendSlot()).toBeNull()
  })

  it('the tap drops keyboard ownership first (blur -> composingChange false)', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'recording'
    })
    await mount()
    textareaEl().focus()
    await flush()
    expect(composingEvents).toContain(true)

    mic()!.click()
    await flush()
    expect(composingEvents).toContain(false)
    // The keyboard must not rise over the recording panel.
    textareaEl().click()
    await flush()
    expect(composingEvents).toContain(false)
  })

  it('requesting (permission prompt): the row freezes WITHOUT a premature busy panel', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'requesting'
    })
    await mount()
    mic()!.click()
    await flush()

    expect(panel()).toBeNull()
    expect(mic()).toBeNull()
    expect(sendSlot()).toBeNull()

    voice.state.value = 'idle'
  })

  it('a second tap while a take is live cannot restart the recorder', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'recording'
    })
    await mount()
    mic()!.click()
    await flush()
    // The mic disc is gone -- nothing left to tap; the guard holds regardless.
    expect(voice.start).toHaveBeenCalledTimes(1)
  })

  it('panel taps never bubble into the field focus handler (no keyboard mid-take)', async () => {
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    try {
      beginRecording(7)
      await mount()
      panelBtn('voice-stop').click()
      panelBtn('voice-cancel').click()
      await flush()
      expect(focusSpy).not.toHaveBeenCalled()
    } finally {
      focusSpy.mockRestore()
    }
    voice.state.value = 'idle'
  })

  it('the stopwatch drives the panel readout (M:SS, tabular)', async () => {
    beginRecording(7)
    await mount()
    await flush()
    expect(panel()!.querySelector('[data-testid="voice-elapsed"]')!.textContent).toBe('0:07')
    voice.state.value = 'idle'
  })
})

describe('Composer -- stop, too-short, cancel', () => {
  it('stop under 1s: cancel + honest hint, no transcription', async () => {
    beginRecording(0)
    await mount()
    panelBtn('voice-stop').click()
    await flush()

    expect(voice.cancel).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith('Запись слишком короткая')
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(panel()).toBeNull()
    voice.state.value = 'idle'
  })

  it('cancel (✕): silent discard -- no toast, no transcription, empty field', async () => {
    beginRecording(5)
    await mount()
    panelBtn('voice-cancel').click()
    voice.state.value = 'idle'
    await flush()

    expect(voice.cancel).toHaveBeenCalledTimes(1)
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(textareaEl().value).toBe('')
  })
})

describe('Composer -- the transcript lands in the field', () => {
  it('stop ≥1s: the wav goes to transcribeAudio, the text lands like typed input (send disc back, draft saved)', async () => {
    const take = { wav: new Blob(['wav-bytes']), peak: 0.5 }
    voice.stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return take
    })
    transcribeAudio.mockResolvedValue({ ok: true, text: 'заметка с голоса' })
    beginRecording(5)
    await mount({ voiceInput: true, draftKey: 'velo:test:draft' })

    panelBtn('voice-stop').click()
    await flush()

    expect(voice.stop).toHaveBeenCalledTimes(1)
    expect(transcribeAudio).toHaveBeenCalledWith(take.wav)
    expect(haptics.notification).toHaveBeenCalledWith('success')
    expect(textareaEl().value).toBe('заметка с голоса')
    expect(textareaEl().style.display).not.toBe('none')
    expect(panel()).toBeNull()
    expect(sendSlot()).not.toBeNull()
    expect(localStorage.getItem('velo:test:draft')).toBe('заметка с голоса')
  })

  it('diary: a fresh transcript stays expanded and visible -- the collapsed preview waits for a real blur', async () => {
    voice.stop.mockImplementation(async () => {
      voice.state.value = 'idle'
      return { wav: new Blob(['w']), peak: 0.5 }
    })
    transcribeAudio.mockResolvedValue({ ok: true, text: 'диктованный текст' })
    beginRecording(5)
    await mount({
      voiceInput: true,
      showDraftPreview: true,
      draftKey: 'velo:t',
    })
    panelBtn('voice-stop').click()
    await flush()

    // No one-line ellipsized readout over the dictated text.
    expect(textareaEl().style.display).not.toBe('none')
    expect(host!.querySelector('.composer__preview')).toBeNull()
    expect(textareaEl().value).toBe('диктованный текст')

    // The user's next real blur brings the collapsed draft preview back
    // (focus first: happy-dom does not dispatch blur for an unfocused
    // element, and a real user must focus before they can blur).
    textareaEl().focus()
    await flush()
    textareaEl().blur()
    await flush()
    expect(host!.querySelector('.composer__preview')).not.toBeNull()
  })

  it('a SILENT take (stop without speaking) never reaches transcription and leaves the field untouched', async () => {
    // Peak below SILENCE_PEAK_THRESHOLD: the model would answer with an
    // apologetic sentence -- reject locally, no request, no fake transcript.
    voice.stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return { wav: new Blob(['silence']), peak: 0.001 }
    })
    beginRecording(5)
    await mount()
    panelBtn('voice-stop').click()
    await flush()

    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Не удалось распознать речь')
    expect(textareaEl().value).toBe('')
    expect(panel()).toBeNull()
  })

  it('no autofocus: the keyboard does not rise on the transcript', async () => {
    const wav = new Blob(['wav-bytes'])
    voice.stop.mockImplementation(async () => {
      voice.state.value = 'idle'
      return { wav, peak: 0.5 }
    })
    transcribeAudio.mockResolvedValue({ ok: true, text: 'текст' })
    // Pin what the component OWNS -- never calling focus() -- instead of
    // document.activeElement, which leaks across tests in happy-dom.
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    try {
      beginRecording(5)
      await mount()
      panelBtn('voice-stop').click()
      await flush()

      expect(focusSpy).not.toHaveBeenCalled()
      expect(composingEvents).not.toContain(true)
    } finally {
      focusSpy.mockRestore()
    }
  })

  it('the auto-stop path feeds the same transcription flow', async () => {
    const take = { wav: new Blob(['auto']), peak: 0.5 }
    transcribeAudio.mockResolvedValue({ ok: true, text: 'длинная запись' })
    await mount()
    beginRecording(60)
    voice.state.value = 'idle'
    voice.fireAutoStop(take)
    await flush()

    expect(transcribeAudio).toHaveBeenCalledWith(take.wav)
    expect(textareaEl().value).toBe('длинная запись')
  })
})

describe('Composer -- honest failures', () => {
  it('a denied mic permission answers with the exact toast, field untouched', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'idle'
      voice.errorReason.value = 'permission'
    })
    await mount()
    mic()!.click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Доступ к микрофону запрещён')
    expect(haptics.impact).not.toHaveBeenCalled()
    expect(textareaEl().value).toBe('')
    expect(panel()).toBeNull()
  })

  it('an unsupported browser answers with the device toast', async () => {
    voice.start.mockImplementation(async () => {
      voice.state.value = 'idle'
      voice.errorReason.value = 'unsupported'
    })
    await mount()
    mic()!.click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Микрофон недоступен на этом устройстве')
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('a transcription failure keeps the field empty and toasts the mapped message', async () => {
    voice.stop.mockImplementation(async () => {
      voice.state.value = 'idle'
      return { wav: new Blob(['wav-bytes']), peak: 0.5 }
    })
    transcribeAudio.mockResolvedValue({
      ok: false,
      error: 'Закончился баланс OpenRouter',
    })
    beginRecording(5)
    await mount()
    panelBtn('voice-stop').click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Закончился баланс OpenRouter')
    expect(haptics.notification).toHaveBeenCalledWith('error')
    expect(textareaEl().value).toBe('')
    expect(panel()).toBeNull()
    expect(sendSlot()).not.toBeNull()
  })

  it('an ok response with no usable text is a recognition failure, never a fake success', async () => {
    voice.stop.mockImplementation(async () => {
      voice.state.value = 'idle'
      return { wav: new Blob(['wav-bytes']), peak: 0.5 }
    })
    transcribeAudio.mockResolvedValue({ ok: true })
    beginRecording(5)
    await mount()
    panelBtn('voice-stop').click()
    await flush()

    expect(toast.error).toHaveBeenCalledWith('Не удалось распознать речь')
    expect(textareaEl().value).toBe('')
  })

  it('an undecodable take (null wav) never reaches transcription', async () => {
    voice.stop.mockResolvedValue(null)
    beginRecording(5)
    await mount()
    panelBtn('voice-stop').click()
    await flush()

    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Не удалось распознать речь')
    expect(textareaEl().value).toBe('')
  })
})

describe('Composer -- the processing freeze', () => {
  it('while the take is processing, the row is honestly frozen', async () => {
    let releaseTranscription: (r: { ok: boolean; text?: string }) => void = () => {}
    voice.stop.mockImplementation(async () => {
      voice.state.value = 'idle'
      return { wav: new Blob(['wav-bytes']), peak: 0.5 }
    })
    transcribeAudio.mockImplementation(
      () =>
        new Promise<{ ok: boolean; text?: string }>((resolve) => {
          releaseTranscription = resolve
        }),
    )
    beginRecording(5)
    await mount()
    panelBtn('voice-stop').click()
    await flush()

    // Pending transcription: busy panel, disabled controls, no send slot.
    expect(panel()).not.toBeNull()
    expect(panel()!.querySelector('[data-testid="voice-busy"]')).not.toBeNull()
    expect(panelBtn('voice-cancel').disabled).toBe(true)
    expect(panelBtn('voice-stop').disabled).toBe(true)
    expect(sendSlot()).toBeNull()

    // A tap on the field must not raise the keyboard over the frozen row
    // (the focusField guard). The hidden textarea itself is not tappable in
    // a real browser, so the tap is simulated on the field container.
    host!.querySelector<HTMLElement>('.composer__field')!.click()
    await flush()
    expect(composingEvents).not.toContain(true)

    releaseTranscription({ ok: true, text: 'дошло' })
    await flush()
    expect(panel()).toBeNull()
    expect(textareaEl().value).toBe('дошло')
  })
})
