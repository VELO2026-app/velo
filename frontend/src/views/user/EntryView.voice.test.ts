// =============================================================================
// VELO Frontend -- EntryView voice input tests (voice input, step 2: FE-94)
//
// EntryView's OWN half of step 2 (the pipeline itself is pinned in
// VTextarea.voice.test.ts over the shared useVoiceFieldInput): the mic lives
// only in the editor, a transcript APPENDS to the entry body and survives the
// save round-trip, a live take freezes «Сохранить», and leaving the editor
// mid-take discards the take instead of orphaning a recording whose panel
// just unmounted.
//
// Same seams as EntryView.test.ts (diary/practices API, router, auth, toast)
// plus the voice seams from Composer.voice.test.ts (recorder, transcription,
// platform haptics). Separate file for the same reason Composer's voice tests
// are separate: the voice mocks must not shape the main file's graph.
//
// TICKS = 8, counted for the deepest chain here -- the dictation-then-save
// flow: stop -> transcribe (1) -> onTranscript sets editContent (2) ->
// re-render (3) -> «Сохранить» click -> onSave -> updateEntry ->
// updateDiaryEntry (4) -> feed.refresh -> loadMore -> listDiaryFeed (5,6) ->
// updateEntry resumes and re-points selectedEntry (7) -> re-render (8).
// listDiaryFeed is mocked resolved for the same reason as the main file: every
// mutation ends in feed.refresh().
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import type { useVoiceRecorder, VoiceTake } from '@/composables/useVoiceRecorder'
import type { DiaryEntryResponse, DiaryFeedResponse, UpdateDiaryEntryRequest } from '@/api/types'

// -- Voice seams (same shape as Composer.voice.test.ts) -----------------------

type RecorderState = 'idle' | 'requesting' | 'recording' | 'processing'
type Recorder = ReturnType<typeof useVoiceRecorder>

const voiceState = ref<RecorderState>('idle')
const voiceElapsed = ref(0)
const voiceError = ref<'permission' | 'unsupported' | null>(null)

const start = vi.fn(async () => {})
const stop = vi.fn(async (): Promise<VoiceTake | null> => null)
const cancel = vi.fn(() => {})
const transcribeAudio = vi.fn()

const haptics = { impact: vi.fn(), notification: vi.fn() }
const toastError = vi.fn()
const toastInfo = vi.fn()

let onAutoStop: ((take: VoiceTake | null) => void) | null = null

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

// -- Screen seams (same as EntryView.test.ts) ---------------------------------

import * as diaryApi from '@/api/diary'

vi.mock('@/api/diary')
vi.mock('@/api/practices')

const push = vi.fn()
const replace = vi.fn()
const routeParams: { id: string } = { id: 'e1' }

vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: toastInfo }),
}))

const authState: { user: { timezone: string } | null } = { user: { timezone: 'UTC' } }
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

// -- Fixtures & helpers -------------------------------------------------------

function entry(overrides: Partial<DiaryEntryResponse> = {}): DiaryEntryResponse {
  return {
    id: 'e1',
    user_id: 'u1',
    practice_id: null,
    entry_type: 'note',
    practice_phase: null,
    title: 'Тихое утро',
    content: 'Старый текст записи.',
    mood: null,
    is_deleted: false,
    created_via: 'app',
    created_at: '2026-07-16T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

const EMPTY_FEED: DiaryFeedResponse = { items: [], next_cursor: null }

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

async function mount(): Promise<void> {
  const { default: EntryView } = await import('@/views/user/EntryView.vue')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(EntryView).use(createTestI18n())
  app.use(pinia)
  app.mount(host)
  await flush()
}

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
function contentArea(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.entry__edit-content')
  if (!el) throw new Error('content textarea did not render')
  return el
}
function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}
function menuItem(ariaLabel: string): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`) ?? undefined
}

/** View -> edit through the real kebab + pencil. */
async function startEditing(): Promise<void> {
  host?.querySelector<HTMLButtonElement>('.v-menu__trigger')?.click()
  await flush()
  menuItem('Редактировать')?.click()
  await flush()
}

function beginRecording(elapsed = 5): void {
  voiceState.value = 'recording'
  voiceElapsed.value = elapsed
}

/** The default stop: an audible take, handed back like the real recorder. */
function audibleTake(): void {
  stop.mockImplementation(async () => {
    voiceState.value = 'idle'
    return { wav: new Blob(['wav-bytes']), peak: 0.5 }
  })
}

beforeEach(() => {
  routeParams.id = 'e1'
  authState.user = { timezone: 'UTC' }
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(diaryApi.getDiaryEntry).mockReset().mockResolvedValue(entry())
  vi.mocked(diaryApi.updateDiaryEntry).mockReset().mockResolvedValue(entry())
  vi.mocked(diaryApi.deleteDiaryEntry).mockReset().mockResolvedValue(undefined)
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue(EMPTY_FEED)

  voiceState.value = 'idle'
  voiceElapsed.value = 0
  voiceError.value = null
  start.mockClear()
  stop.mockReset()
  stop.mockResolvedValue({ wav: new Blob(['default']), peak: 0.5 })
  cancel.mockReset()
  cancel.mockImplementation(() => {
    voiceState.value = 'idle'
    voiceElapsed.value = 0
  })
  transcribeAudio.mockReset()
  transcribeAudio.mockResolvedValue({ ok: true, text: 'продолжение с голоса' })
  haptics.impact.mockClear()
  haptics.notification.mockClear()
  toastError.mockClear()
  toastInfo.mockClear()
  push.mockReset()
  replace.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  voiceState.value = 'idle'
  vi.clearAllMocks()
})

describe('EntryView -- voice dictation on the entry body', () => {
  it('the mic lives in the EDITOR only: view mode has none, edit mode has the disc', async () => {
    await mount()
    expect(mic()).toBeNull()

    await startEditing()
    expect(mic()).not.toBeNull()
    expect(mic()!.getAttribute('aria-label')).toBe('Голосовой ввод')
  })

  it('a take owns the field: panel stands in, textarea hides, mic unmounts', async () => {
    await mount()
    await startEditing()
    beginRecording(5)
    await flush()

    expect(panel()).not.toBeNull()
    expect(contentArea().style.display).toBe('none')
    expect(mic()).toBeNull()
    voiceState.value = 'idle'
    await flush()
  })

  it('THE §11 FLOW: a transcript APPENDS to the entry body and survives the save', async () => {
    audibleTake()
    await mount()
    await startEditing()
    beginRecording(5)
    await flush()

    panelBtn('voice-stop').click()
    await flush()

    // Appended with the single join space -- the old text is still first.
    expect(contentArea().value).toBe('Старый текст записи. продолжение с голоса')
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Blob))
    expect(haptics.notification).toHaveBeenCalledWith('success')

    button('Сохранить')?.click()
    await flush()

    const call = vi.mocked(diaryApi.updateDiaryEntry).mock.calls[0]
    const body: UpdateDiaryEntryRequest | undefined = call?.[1]
    expect(body?.content).toBe('Старый текст записи. продолжение с голоса')
  })

  it('a live take freezes «Сохранить» -- a mid-take save would drop the dictation', async () => {
    await mount()
    await startEditing()
    expect(button('Сохранить')?.disabled).toBe(false)

    beginRecording(5)
    await flush()

    expect(button('Сохранить')?.disabled).toBe(true)
    voiceState.value = 'idle'
    await flush()
  })

  it('the permission prompt already owns the field: body hidden, no premature panel, «Сохранить» frozen; a denial thaws the row', async () => {
    // The composer's own rule (its textarea hides on voiceActive, not just
    // when the panel shows), pinned here so the surfaces cannot drift apart
    // again: editable text must not sit under an open OS permission dialog.
    await mount()
    await startEditing()

    voiceState.value = 'requesting'
    await flush()

    expect(contentArea().style.display).toBe('none')
    expect(panel()).toBeNull()
    expect(mic()).toBeNull()
    expect(button('Сохранить')?.disabled).toBe(true)

    voiceState.value = 'idle'
    await flush()
    expect(contentArea().style.display).not.toBe('none')
    expect(contentArea().value).toBe('Старый текст записи.')
    expect(button('Сохранить')?.disabled).toBe(false)
  })

  it('leaving the editor while the permission prompt is open kills the REQUEST -- no orphaned recording when getUserMedia answers late', async () => {
    // The recorder's generation guard (FE-78.1) only engages if cancel
    // reaches it during `requesting`; the composable's cancel must not stop
    // at `recording`. Without this, a late permission grant starts a take
    // whose panel just unmounted with the editor.
    await mount()
    await startEditing()
    voiceState.value = 'requesting'
    await flush()

    host?.querySelector<HTMLButtonElement>('.v-back')?.click()
    await flush()

    expect(voice.cancel).toHaveBeenCalledTimes(1)
    expect(voiceState.value).toBe('idle')
    expect(push).not.toHaveBeenCalled() // back in edit mode only returns to view
  })

  it('leaving the editor mid-take discards the take -- no orphaned recording', async () => {
    await mount()
    await startEditing()
    beginRecording(5)
    await flush()

    // Back in EDIT mode returns to VIEW without navigating away (goBack's
    // documented branch) -- the take must not survive the mode swap.
    host?.querySelector<HTMLButtonElement>('.v-back')?.click()
    await flush()

    expect(voice.cancel).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(mic()).toBeNull() // view mode again
    expect(host?.querySelector('.entry__edit-title')).toBeNull()
  })

  it('a SILENT take leaves the body untouched and says so honestly', async () => {
    stop.mockImplementation(async () => {
      voiceState.value = 'idle'
      return { wav: new Blob(['silence']), peak: 0.001 }
    })
    await mount()
    await startEditing()
    beginRecording(5)
    await flush()

    panelBtn('voice-stop').click()
    await flush()

    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('Не удалось распознать речь')
    expect(contentArea().value).toBe('Старый текст записи.')
  })
})
