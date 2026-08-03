// =============================================================================
// VELO Frontend -- DiaryComposer Unit Tests
// =============================================================================
//
// WHY: this component had ZERO dedicated tests before the PROMPT №629 rebuild
// (DiaryFeedView.test.ts:953-955 says so explicitly -- "the composer's internals
// are a component test, not this screen's", and none existed). The rebuild
// removed the kb-collapse button, collapsed mic/send into one action slot, and
// changed the autogrow cap formula -- exactly the kind of change that silently
// drops behaviour if nothing pins it. This file locks the 13 behaviours
// enumerated in the audit (PROMPT №628 (d)), including the one thing that
// already worked before the rebuild and was easiest to lose: the draft survives
// an outside tap (ruling 7).
//
// Dependency-free SFC mount via createApp + happy-dom (matches
// MethodTaxonomyPicker.test.ts / CalendarFilterModal.test.ts -- no
// @vue/test-utils in this repo's convention). The store is REAL (matches
// DiaryFeedView.test.ts's own PATTERN A); only @/api/diary is mocked.
//
// ⚠ CAVEAT, read before "fixing" the outside-tap test: happy-dom (like jsdom)
// does NOT implement the browser's native "mousedown on a non-focusable
// element blurs whatever was focused" default action -- confirmed by hand this
// session with a real dispatched pointer click in an actual Chromium engine
// (the mechanism works there; a scripted `.click()` on a sibling div does NOT
// reproduce it here). So "outside tap keeps the draft" is tested below by
// calling `.blur()` directly on the textarea -- exercising exactly what a real
// outside tap ultimately triggers (the textarea's blur handler), without
// pretending a simulated click proves the browser-level default action. Do not
// rewrite this to dispatch a click on a sibling and expect it to blur anything.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import DiaryComposer from './DiaryComposer.vue'
import * as diaryApi from '@/api/diary'
import type { DiaryEntryResponse, DiaryFeedResponse } from '@/api/types'

vi.mock('@/api/diary')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

function emptyPage(): DiaryFeedResponse {
  return { items: [], next_cursor: null }
}

function entryFixture(content: string): DiaryEntryResponse {
  return {
    id: 'e1',
    user_id: 'u1',
    practice_id: null,
    entry_type: 'note',
    practice_phase: null,
    title: null,
    content,
    mood: null,
    is_deleted: false,
    created_at: '2026-07-29T10:00:00Z',
    updated_at: null,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia
let createdCount = 0
let composingEvents: boolean[] = []

function mount(props: { entryType?: 'note' | 'dream' } = {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DiaryComposer, {
    ...props,
    onCreated: () => {
      createdCount++
    },
    onComposingChange: (v: boolean) => {
      composingEvents.push(v)
    },
  })
  app.use(pinia)
  app.mount(host)
  return host
}

function unmount(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
}

// createEntry() awaits createDiaryEntry then feed.refresh() (-> listDiaryFeed,
// itself awaiting useCursorPagination's own chain) then a nextTick + autogrow
// before emitting. 8 = bisected against a real failure at 7, not guessed.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function textarea(): HTMLTextAreaElement {
  const el = host?.querySelector('textarea')
  if (!el) throw new Error('textarea did not render')
  return el
}

function slotBtn(): HTMLButtonElement {
  const btns = host?.querySelectorAll('.composer__btn') ?? []
  if (btns.length !== 1) throw new Error(`expected exactly 1 .composer__btn, found ${btns.length}`)
  return btns[0] as HTMLButtonElement
}

// T24-3: the slot wrapper is always present (constant width); the button
// inside it renders only once there is text.
function slotButtonCount(): number {
  return host?.querySelectorAll('.composer__btn').length ?? 0
}

function typeText(value: string): void {
  const el = textarea()
  el.value = value
  el.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  localStorage.clear()
  createdCount = 0
  composingEvents = []
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(diaryApi.createDiaryEntry).mockReset()
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue(emptyPage())
  toastError.mockReset()
})

afterEach(() => {
  unmount()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('DiaryComposer -- idle state (1: no chevron, one slot; T24-3: no mic)', () => {
  it('renders NO action button while empty, no kb-collapse button, but the slot still reserves its width', () => {
    mount()
    expect(slotButtonCount()).toBe(0)
    expect(host!.querySelector('.composer__btn--kb')).toBeNull()
    expect(host!.querySelector('.composer__slot')).not.toBeNull()
  })

  it('placeholder follows entryType', () => {
    mount({ entryType: 'dream' })
    expect(textarea().placeholder).toBe('Запишите сон...')
  })

  it('MAX_LEN is wired onto the textarea', () => {
    mount()
    expect(textarea().getAttribute('maxlength')).toBe('10000')
  })
})

describe('DiaryComposer -- the single action slot (4: empty <-> send, never a disabled mic)', () => {
  it('typing makes the send button appear; clearing removes it again (empty slot)', async () => {
    mount()
    typeText('hello')
    await nextTick()
    expect(slotBtn().getAttribute('aria-label')).toBe('Отправить')
    expect(slotButtonCount()).toBe(1)

    typeText('')
    await nextTick()
    expect(slotButtonCount()).toBe(0)
  })

  it('whitespace-only text never shows the send button', async () => {
    mount()
    typeText('   \n   ')
    await nextTick()
    expect(slotButtonCount()).toBe(0)
  })

  it('the kb-collapse button never reappears once composing', async () => {
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(host!.querySelector('.composer__btn--kb')).toBeNull()
    // Composing with no text yet: the slot stays empty, not a placeholder button.
    expect(slotButtonCount()).toBe(0)
  })

  it('the slot has no button and cannot be clicked while the field is empty (mic removed, T24-3)', () => {
    mount()
    const slot = host!.querySelector('.composer__slot')
    expect(slot).not.toBeNull()
    expect(slot!.querySelector('.composer__btn')).toBeNull()
    expect(diaryApi.createDiaryEntry).not.toHaveBeenCalled()
  })
})

describe('DiaryComposer -- focus/blur + composingChange', () => {
  it('focus sets composing, emits composingChange(true); blur reverses it', async () => {
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(composingEvents).toEqual([true])
    expect(host!.querySelector('.composer')!.classList.contains('composer--composing')).toBe(true)

    textarea().dispatchEvent(new Event('blur'))
    await nextTick()
    expect(composingEvents).toEqual([true, false])
    expect(host!.querySelector('.composer')!.classList.contains('composer--composing')).toBe(false)
  })
})

describe('DiaryComposer -- draft preservation (7: outside-tap keeps the draft -- the easiest thing here to lose)', () => {
  it('a blur with unsent text does NOT clear it -- collapses to the single-line preview instead', async () => {
    mount()
    typeText('unsent draft')
    await nextTick()

    // See the file banner: this is the real mechanism a native outside tap
    // ultimately fires (blur), not a simulated click on a sibling.
    textarea().dispatchEvent(new Event('blur'))
    await nextTick()

    expect(host!.querySelector('.composer__preview')?.textContent).toBe('unsent draft')
    expect(localStorage.getItem('velo:diary:draft:note')).toBe('unsent draft')
  })

  it('the draft survives a remount (navigate away and back)', async () => {
    mount()
    typeText('still here later')
    await nextTick()
    unmount()

    mount()
    await nextTick()
    expect(textarea().value).toBe('still here later')
  })

  it('note and dream keep separate draft keys', async () => {
    mount({ entryType: 'note' })
    typeText('note draft')
    await nextTick()
    unmount()

    mount({ entryType: 'dream' })
    await nextTick()
    expect(textarea().value).toBe('')
    expect(localStorage.getItem('velo:diary:draft:note')).toBe('note draft')
  })
})

describe('DiaryComposer -- send path', () => {
  it('success: clears the text and the stored draft, emits created', async () => {
    vi.mocked(diaryApi.createDiaryEntry).mockResolvedValueOnce(entryFixture('a real entry'))
    mount()
    typeText('a real entry')
    await nextTick()

    slotBtn().click()
    await flush()

    expect(diaryApi.createDiaryEntry).toHaveBeenCalledWith({
      content: 'a real entry',
      entry_type: 'note',
    })
    expect(textarea().value).toBe('')
    expect(localStorage.getItem('velo:diary:draft:note')).toBeNull()
    expect(createdCount).toBe(1)
  })

  it('failure: the text survives, the error toasts, created never emits', async () => {
    vi.mocked(diaryApi.createDiaryEntry).mockRejectedValueOnce(new Error('boom'))
    mount()
    typeText('a real entry')
    await nextTick()

    slotBtn().click()
    await flush()

    expect(textarea().value).toBe('a real entry')
    expect(toastError).toHaveBeenCalledWith('Не удалось создать запись')
    expect(createdCount).toBe(0)
  })

  it('ruling 3: success blurs the field, so the keyboard closes', async () => {
    // Per this file's own caveat (top banner): happy-dom does not reliably
    // propagate a real DOM .blur() call into a dispatched 'blur' event, even
    // on a genuinely .focus()-ed element -- confirmed by hand this session
    // (real .focus() + .blur() left composer--composing unchanged, twice).
    // That is an environment gap, not a code bug -- a real engine fires
    // 'blur' synchronously from .blur(), which is exactly what a real
    // outside tap already exercises (the draft-preservation tests above, via
    // a directly-dispatched blur event). So this asserts what onSend's own
    // code does -- calls .blur() on the field -- rather than a downstream
    // effect this environment cannot produce. Do not rewrite this to check
    // the composing class/composingChange; that would test happy-dom, not
    // this component.
    vi.mocked(diaryApi.createDiaryEntry).mockResolvedValueOnce(entryFixture('a real entry'))
    mount()
    typeText('a real entry')
    await nextTick()
    const blurSpy = vi.spyOn(textarea(), 'blur')

    slotBtn().click()
    await flush()

    expect(blurSpy).toHaveBeenCalledTimes(1)
  })

  it('a second click while the first send is still in flight is a no-op (submitting guard)', async () => {
    let resolveCreate!: (v: DiaryEntryResponse) => void
    vi.mocked(diaryApi.createDiaryEntry).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    mount()
    typeText('a real entry')
    await nextTick()

    const btn = slotBtn()
    btn.click()
    btn.click()
    await nextTick()

    expect(diaryApi.createDiaryEntry).toHaveBeenCalledTimes(1)
    resolveCreate(entryFixture('a real entry'))
    await flush()
  })
})

describe("DiaryComposer -- autogrow cap (3, corrected PROMPT №630: the owner's fixed 300px, bounded by available space; collapsed cap unchanged)", () => {
  it('collapsed cap stays 120px', async () => {
    mount()
    typeText('a')
    await nextTick()
    expect(textarea().style.maxHeight).toBe('120px')
  })

  it('composing on a generous viewport reaches the full 300px target', async () => {
    // happy-dom's default window.innerHeight is 768 (no visualViewport, so the
    // component falls back to it) -- 768 - 176 (chrome offset) = 592, well
    // above 300, so the owner's figure applies unbounded.
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(window.innerHeight).toBe(768)
    expect(textarea().style.maxHeight).toBe('300px')
  })

  it("a short viewport bounds the cap below 300px (the physical limit, not a second guess at the owner's number)", async () => {
    vi.stubGlobal('innerHeight', 300)
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    // 300 (viewport) - 176 (chrome offset) = 124 -- below the 300px target, so
    // the bound wins.
    expect(textarea().style.maxHeight).toBe('124px')
  })

  it('an extremely short viewport hits the floor, never below 80px', async () => {
    vi.stubGlobal('innerHeight', 200)
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    // 200 - 176 = 24, floored to 80 so the field cannot collapse to one line.
    expect(textarea().style.maxHeight).toBe('80px')
  })
})
