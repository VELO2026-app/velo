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
// before emitting. Was 8 (bisected against a real failure at 7) before this
// component wrapped the shared Composer.vue (PROMPT №740): the extra
// DiaryComposer -> Composer -> handleSend -> diaryStore.createEntry
// indirection adds one more microtask hop, so 8 started under-flushing
// (createdCount stayed 0, confirmed reproduced). Re-bisected: FAILS at 8,
// PASSES at 9 -- 10 kept as the same one-tick margin the original 8-over-7
// value used.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
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

  it('ruling 3b (PROMPT №668, supersedes ruling 3): success does NOT blur the field -- the keyboard stays open', async () => {
    // Ruling 3 (blur on send, so the keyboard closed) was reversed the same
    // day it shipped: the owner redefined the diary as a conversation, where
    // closing the keyboard after every message would break "write several in
    // a row". This pins the reversal -- onSend must NOT call .blur() any
    // more. Spy-on-the-call is still the right shape here (see this file's
    // top banner on happy-dom's blur/focus limitations) -- it just now
    // asserts the call is ABSENT rather than present.
    vi.mocked(diaryApi.createDiaryEntry).mockResolvedValueOnce(entryFixture('a real entry'))
    mount()
    typeText('a real entry')
    await nextTick()
    const blurSpy = vi.spyOn(textarea(), 'blur')

    slotBtn().click()
    await flush()

    expect(blurSpy).not.toHaveBeenCalled()
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

// PROMPT №740 (track 2) flattened the old two-tier 120px-collapsed /
// up-to-300px-composing-bounded-by-viewport formula to a static CSS token.
// PROMPT №741 (track 3) RESTORES it -- wired via useComposerGrowCap.ts
// (composerGrowCap has its own dedicated, numbers-first test file:
// useComposerGrowCap.test.ts). What belongs HERE is only that DiaryComposer
// actually PASSES the computed value through to the rendered textarea --
// the formula itself is proven elsewhere.
describe('DiaryComposer -- autogrow (PROMPT №741: viewport-aware growCap restored, wired from useComposerGrowCap)', () => {
  it('grows the inline height to fit content while under the cap', async () => {
    mount()
    typeText('a')
    await nextTick()
    // jsdom/happy-dom report scrollHeight as 0 by default (no real layout),
    // so the JS-set inline height mirrors that -- this pins that autogrow()
    // still RUNS and writes an explicit height (not left at 'auto'), which is
    // the behaviour a real browser's non-zero scrollHeight then bounds.
    expect(textarea().style.height).not.toBe('')
    expect(textarea().style.height).not.toBe('auto')
  })

  it('idle (not composing): the collapsed 120px cap is wired through to the textarea', async () => {
    mount()
    await nextTick()
    expect(textarea().style.maxHeight).toBe('120px')
  })

  it('composing on a generous viewport (happy-dom default innerHeight 768): reaches the 240px ceiling ([FE-9])', async () => {
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(window.innerHeight).toBe(768)
    expect(textarea().style.maxHeight).toBe('240px')
  })

  it('a short viewport caps at a third of it ([FE-9]: round(300/3))', async () => {
    vi.stubGlobal('innerHeight', 300)
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(textarea().style.maxHeight).toBe('100px')
  })

  it('an extremely short viewport hits the floor, never below 80px', async () => {
    vi.stubGlobal('innerHeight', 150)
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(textarea().style.maxHeight).toBe('80px')
  })

  it('blur returns the cap to 120px', async () => {
    mount()
    textarea().dispatchEvent(new Event('focus'))
    await nextTick()
    expect(textarea().style.maxHeight).toBe('240px')

    textarea().dispatchEvent(new Event('blur'))
    await nextTick()
    expect(textarea().style.maxHeight).toBe('120px')
  })

  it('an explicit growCap prop, exercised directly against the shared Composer (not through DiaryComposer, which computes its own), overrides via inline style', async () => {
    const ComposerMod = await import('./Composer.vue')
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const app2 = createApp(ComposerMod.default, {
      placeholder: 'x',
      growCap: 111,
      send: async () => ({ ok: true }),
    })
    app2.mount(host2)
    const ta = host2.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.style.maxHeight).toBe('111px')
    app2.unmount()
    host2.remove()
  })
})
