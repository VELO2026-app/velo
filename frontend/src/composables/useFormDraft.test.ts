// =============================================================================
// VELO Frontend -- useFormDraft (FE-157 stage 4, track 4A)
// =============================================================================
//
// The draft autosave CreatePracticeView used to carry inline. The screen
// suite pins the banner flow (offer, restore, start over, sweep, per-user
// key); this file pins the autosave timing contract those tests cannot
// reach without waiting out the debounce: a person's edit is saved after the
// delay, a programmatic fill is not, and a finished draft never comes back.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, nextTick, reactive, type App } from 'vue'
import { useFormDraft, type FormDraft } from '@/composables/useFormDraft'

const KEY = 'draft:test'

let app: App | null = null
let form: { title: string; note: string }
let draft: FormDraft

function mount(): void {
  form = reactive({ title: '', note: '' })
  const Host = defineComponent({
    setup() {
      draft = useFormDraft(form, { key: () => KEY, isMeaningful: (d) => !!d.title })
      return () => null
    },
  })
  app = createApp(Host)
  app.mount(document.createElement('div'))
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  app?.unmount()
  app = null
  localStorage.clear()
  vi.useRealTimers()
})

describe('useFormDraft', () => {
  it("saves the person's edit after the debounce, not before", async () => {
    mount()
    form.title = 'Morning'
    await nextTick()
    vi.advanceTimersByTime(499)
    expect(localStorage.getItem(KEY)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ title: 'Morning', note: '' })
  })

  it('a programmatic fill is not saved as the draft', async () => {
    mount()
    draft.withoutAutosave(() => {
      form.title = 'From a template'
    })
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('a finished draft is dropped and a pending save cannot resurrect it', async () => {
    mount()
    form.title = 'Morning'
    await nextTick()
    draft.finish()
    form.note = 'late edit'
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('offers a stored draft without filling, and restore fills it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ title: 'Stored', note: 'n' }))
    mount()
    expect(draft.offered.value).toBe(true)
    expect(form.title).toBe('')
    draft.restore()
    await nextTick()
    expect(form).toEqual({ title: 'Stored', note: 'n' })
    expect(draft.offered.value).toBe(false)
    // The restore itself is not a new edit to save.
    localStorage.removeItem(KEY)
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
