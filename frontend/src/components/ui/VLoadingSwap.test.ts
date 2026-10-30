// =============================================================================
// VELO Frontend -- VLoadingSwap (skeleton -> content in one grid cell)
// =============================================================================
//
// Contract: a fast answer swaps straight to the content (no transition
// classes, no hold); a skeleton that was seen stays its minimum and the
// container is aria-busy meanwhile; the status line announces the load.
// The crossfade itself is CSS (browser-verified).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import VLoadingSwap from '@/components/ui/VLoadingSwap.vue'
import { LOADING_DELAY_MS, LOADING_MIN_DURATION_MS } from '@/composables/useLoadingHold'

let app: App | null = null
let host: HTMLElement | null = null
const pending = ref(true)

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        VLoadingSwap,
        { pending: pending.value },
        {
          skeleton: () => h('div', { class: 'sk' }),
          default: () => h('div', { class: 'content' }, 'ready'),
        },
      ),
  }).use(createTestI18n())
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

const q = (sel: string): Element | null => host?.querySelector(sel) ?? null

beforeEach(() => {
  vi.useFakeTimers()
  pending.value = true
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('VLoadingSwap', () => {
  it('pending: the skeleton (with a status line) is mounted at once and the block is aria-busy', async () => {
    mount()
    await flush()
    expect(q('.sk')).not.toBeNull()
    expect(q('[role="status"]')).not.toBeNull()
    expect(q('.v-loading-swap')?.getAttribute('aria-busy')).toBe('true')
    expect(q('.content')).toBeNull()
  })

  it('a fast answer swaps straight to the content, no hold', async () => {
    mount()
    await flush()
    pending.value = false
    await flush()
    expect(q('.content')?.textContent).toBe('ready')
    expect(q('.sk')).toBeNull()
    expect(q('.v-loading-swap')?.getAttribute('aria-busy')).toBeNull()
  })

  it('a skeleton that was seen stays its minimum before the content', async () => {
    mount()
    await flush()
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    await flush()

    pending.value = false
    await flush()
    expect(q('.sk')).not.toBeNull()
    expect(q('.content')).toBeNull()

    vi.advanceTimersByTime(LOADING_MIN_DURATION_MS)
    await flush()
    expect(q('.content')).not.toBeNull()
  })
})
