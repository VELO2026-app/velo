// =============================================================================
// VELO Frontend -- VLoadingSwap localized label (P8 batch 5)
// =============================================================================
//
// P8 moved VLoadingSwap into @velo/ui with the loading rule
// (useLoadingHold/useDelayedFlag) and the kit's own sessionStorage/motion
// seams. The kit component is PURE: its sr-only status line renders the
// `label` prop as-is, no catalog lookups. The localized common.loading
// default is re-anchored HERE, in the application barrel wrapper (the
// VLoader pattern, tz-ui-package §4 P3) -- this file pins that anchor:
// a bare consumer still hears the localized caption, an explicit label
// wins.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, nextTick, h, type App } from 'vue'
import { VLoadingSwap } from '@/components/ui'

let app: App | null = null
let host: HTMLElement | null = null

async function mountSwap(props: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(VLoadingSwap, { pending: true, ...props }, { default: () => h('p', 'content') }),
  })
  app.mount(host)
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VLoadingSwap (barrel): the localized loading label', () => {
  it('announces the wait with the localized common.loading string', async () => {
    await mountSwap()
    expect(host?.querySelector('.v-loading-swap .velo-sr-only')?.textContent).toBe('Загружаем…')
  })

  it('an explicit consumer label wins over the seam default', async () => {
    await mountSwap({ label: 'Fetching bookings' })
    expect(host?.querySelector('.v-loading-swap .velo-sr-only')?.textContent).toBe(
      'Fetching bookings',
    )
  })
})
