// =============================================================================
// VELO Frontend -- VLoadingSwap: the block glides to its loaded height
// =============================================================================
//
// The on-device bug: three skeleton cards resolving into an empty state made
// the block pop shorter and everything below it jump. Contract: the leaving
// skeleton is out of flow, the block is held at the height it had and set to
// the content's, so the CSS transition (--velo-dur-resize) glides it once;
// it goes back to auto when that ends (or on the safety timer). A swap to
// nothing glides to 0. Reduced motion and animate-height=false: no glide.
// happy-dom has no layout, so heights come from a small model below.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import VLoadingSwap from '@/components/ui/VLoadingSwap.vue'
import { LOADING_DELAY_MS, LOADING_MIN_DURATION_MS } from '@/composables/useLoadingHold'

const SKELETON_H = 300
const contentHRef = ref(80)
/** Height the content renders with (read from the DOM, like layout). */
let contentH = 80

/** Layout model: an explicit inline height wins; otherwise a skeleton still
 * in flow sets the height, else the content does. */
function modelHeight(el: Element): number {
  if (!(el instanceof HTMLElement) || !el.classList.contains('v-loading-swap')) return 0
  if (el.style.height) return parseFloat(el.style.height)
  const sk = el.querySelector('.v-loading-swap__skeleton')
  if (sk && !sk.className.includes('leave-active')) return SKELETON_H
  const content = el.querySelector<HTMLElement>('.content')
  return content ? Number(content.dataset.h) : 0
}

let app: App | null = null
let host: HTMLElement | null = null
const pending = ref(true)
const empty = ref(false)

const revision = ref<string | undefined>(undefined)

function mount(props: Record<string, unknown> = {}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        VLoadingSwap,
        { pending: pending.value, revision: revision.value, ...props },
        {
          skeleton: () => h('div', { class: 'sk' }),
          default: () =>
            empty.value
              ? null
              : h('div', { class: 'content', 'data-h': contentHRef.value }, 'ready'),
        },
      ),
  }).use(createTestI18n())
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

const block = (): HTMLElement => {
  const el = host?.querySelector<HTMLElement>('.v-loading-swap')
  if (!el) throw new Error('no block')
  return el
}

/** Skeleton seen, then the answer lands after the hold. */
async function loadThroughSkeleton(): Promise<void> {
  await flush()
  vi.advanceTimersByTime(LOADING_DELAY_MS)
  await flush()
  pending.value = false
  await flush()
  vi.advanceTimersByTime(LOADING_MIN_DURATION_MS)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  pending.value = true
  empty.value = false
  revision.value = undefined
  contentH = 80
  contentHRef.value = 80
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return { height: modelHeight(this), width: 0, top: 0, left: 0, bottom: 0, right: 0 } as DOMRect
  })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('VLoadingSwap height', () => {
  it('a shorter answer: held at the skeleton height, then set to the content height, then auto', async () => {
    mount()
    await loadThroughSkeleton()

    const el = block()
    expect(el.classList.contains('v-loading-swap--sizing')).toBe(true)
    expect(el.style.height).toBe(`${contentH}px`)
    // The leaving skeleton is lifted out of flow while it fades.
    expect(el.querySelector('.v-loading-swap__skeleton')?.className ?? '').toContain('leave-active')

    el.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'height' }))
    expect(el.classList.contains('v-loading-swap--sizing')).toBe(false)
    expect(el.style.height).toBe('')
  })

  it('an answer with nothing to show collapses the block to 0 the same way', async () => {
    empty.value = true
    mount()
    await loadThroughSkeleton()

    const el = block()
    expect(el.classList.contains('v-loading-swap--sizing')).toBe(true)
    expect(el.style.height).toBe('0px')
  })

  it('never stays pinned: the safety timer releases the height without a transitionend', async () => {
    mount()
    await loadThroughSkeleton()
    expect(block().style.height).not.toBe('')
    vi.advanceTimersByTime(1000)
    expect(block().style.height).toBe('')
    expect(block().classList.contains('v-loading-swap--sizing')).toBe(false)
  })

  it('same height: nothing to glide', async () => {
    contentH = SKELETON_H
    contentHRef.value = SKELETON_H
    mount()
    await loadThroughSkeleton()
    expect(block().classList.contains('v-loading-swap--sizing')).toBe(false)
    expect(block().style.height).toBe('')
  })

  it('reduced motion: the height is instant', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({ matches: query.includes('reduce'), media: query }) as MediaQueryList,
    )
    mount()
    await loadThroughSkeleton()
    expect(block().classList.contains('v-loading-swap--sizing')).toBe(false)
    expect(block().style.height).toBe('')
  })

  it('animate-height=false opts out', async () => {
    mount({ animateHeight: false })
    await loadThroughSkeleton()
    expect(block().classList.contains('v-loading-swap--sizing')).toBe(false)
  })

  it('an answer inside the delay never shows a skeleton: the content just fades in', async () => {
    mount()
    await flush()
    vi.advanceTimersByTime(LOADING_DELAY_MS - 20)
    pending.value = false
    await flush()
    expect(host?.querySelector('.sk')).toBeNull()
    const content = host?.querySelector('.content')?.parentElement
    expect(content?.className ?? '').toContain('v-loading-swap-content-enter')
  })

  it('content there from the start (cache) appears without a fade', async () => {
    pending.value = false
    mount()
    await flush()
    const content = host?.querySelector('.content')?.parentElement
    expect(content?.className ?? '').not.toContain('enter')
  })

  it('memory-key: the settled height is remembered and reserved while the next load waits', async () => {
    pending.value = false
    mount({ memoryKey: 'blk' })
    await flush()
    expect(sessionStorage.getItem('velo:block-height:blk')).toBe(String(contentH))
    app?.unmount()
    host?.remove()

    pending.value = true
    mount({ memoryKey: 'blk' })
    await flush()
    expect(block().style.height).toBe(`${contentH}px`) // reserved, skeleton still invisible
    expect(block().style.overflow).toBe('hidden')
  })

  it('revision: a silent refresh that changes the rows glides the height', async () => {
    pending.value = false
    revision.value = 'a,b'
    mount()
    await flush()
    contentHRef.value = 40
    revision.value = 'a'
    await flush()
    expect(block().classList.contains('v-loading-swap--sizing')).toBe(true)
    expect(block().style.height).toBe('40px')
  })
})
