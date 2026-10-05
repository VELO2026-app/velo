// =============================================================================
// VELO Frontend -- VoiceRecordingPanel tests (voice input MVP, step 1)
//
// Dependency-free SFC mount via createApp + happy-dom (this repo's convention,
// see DiaryComposer.test.ts -- no @vue/test-utils). The panel is a pure
// render/emit component: these tests pin its two phases and the disabled
// processing contract.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import VoiceRecordingPanel from './VoiceRecordingPanel.vue'

let app: App | null = null
let host: HTMLElement | null = null

type PanelState = 'recording' | 'processing'

function mount(
  props: { state: PanelState; elapsedSec?: number; compact?: boolean } = {
    state: 'recording',
  },
): { events: string[]; click: (testId: string) => void } {
  host = document.createElement('div')
  document.body.appendChild(host)
  const events: string[] = []
  app = createApp(VoiceRecordingPanel, {
    ...props,
    onCancel: () => events.push('cancel'),
    onStop: () => events.push('stop'),
  })
  app.mount(host)
  return {
    events,
    click(testId: string) {
      const el = host?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      if (!el) throw new Error(`no element ${testId}`)
      el.click()
    },
  }
}

function unmount(): void {
  app?.unmount()
  app = null
  host?.remove()
  host = null
}

describe('VoiceRecordingPanel -- recording', () => {
  it('shows the pulsing dot and the M:SS stopwatch, no busy row', () => {
    mount({ state: 'recording', elapsedSec: 7 })
    expect(host!.querySelector('.voice-panel__dot')).not.toBeNull()
    expect(host!.querySelector('[data-testid="voice-elapsed"]')!.textContent).toBe('0:07')
    expect(host!.querySelector('[data-testid="voice-busy"]')).toBeNull()
    unmount()
  })

  it('✕ emits cancel, ⏹ emits stop (accessible names included)', () => {
    const { events, click } = mount({ state: 'recording', elapsedSec: 0 })
    const cancel = host!.querySelector<HTMLButtonElement>('[data-testid="voice-cancel"]')
    const stop = host!.querySelector<HTMLButtonElement>('[data-testid="voice-stop"]')
    expect(cancel!.getAttribute('aria-label')).toBe('Отменить запись')
    expect(stop!.getAttribute('aria-label')).toBe('Завершить запись')

    click('voice-cancel')
    click('voice-stop')
    expect(events).toEqual(['cancel', 'stop'])
    unmount()
  })

  it('compact (capsule) mode is on the root class', () => {
    mount({ state: 'recording', elapsedSec: 0, compact: true })
    expect(host!.querySelector('.voice-panel--compact')).not.toBeNull()
    unmount()
  })
})

describe('VoiceRecordingPanel -- processing', () => {
  it('swaps the indicators for «Транскрибация…» + VLoader', () => {
    mount({ state: 'processing', elapsedSec: 12 })
    expect(host!.querySelector('[data-testid="voice-busy"]')).not.toBeNull()
    expect(host!.querySelector('.voice-panel__busy')!.textContent).toContain('Транскрибация')
    expect(host!.querySelector('.v-loader')).not.toBeNull()
    expect(host!.querySelector('.voice-panel__dot')).toBeNull()
    expect(host!.querySelector('[data-testid="voice-elapsed"]')).toBeNull()
    unmount()
  })

  it('both buttons are disabled and emit nothing -- the row is honestly frozen', () => {
    const { events, click } = mount({ state: 'processing', elapsedSec: 12 })
    const cancel = host!.querySelector<HTMLButtonElement>('[data-testid="voice-cancel"]')
    const stop = host!.querySelector<HTMLButtonElement>('[data-testid="voice-stop"]')
    expect(cancel!.disabled).toBe(true)
    expect(stop!.disabled).toBe(true)

    click('voice-cancel')
    click('voice-stop')
    expect(events).toEqual([])
    unmount()
  })
})

describe('VoiceRecordingPanel -- stopwatch formatting', () => {
  it('past the minute keeps M:SS', async () => {
    mount({ state: 'recording', elapsedSec: 67 })
    await nextTick()
    expect(host!.querySelector('[data-testid="voice-elapsed"]')!.textContent).toBe('1:07')
    unmount()
  })
})
