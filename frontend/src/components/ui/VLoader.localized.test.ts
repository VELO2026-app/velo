// =============================================================================
// VLoader -- localized aria-label pin (APPLICATION-side, FE-140)
// =============================================================================
//
// The i18n seam of the FE-117 batch A tail: the kit VLoader is pure and its
// aria-label arrives through attrs on the root (tz-ui-package.md §7.2), so
// the LOCALIZED default ('common.loading') is re-anchored in the application
// barrel until P3 gives the kit its own i18n story. This test pins what the
// ~77 consumers actually see through @/components/ui -- in the default ru
// locale -- and must stay green across that flip (and until P3 moves the
// seam again).
//
// The global i18n singleton (imported by the wrapper) carries the eager ru
// catalog, so no plugin install is needed for the assertion.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import { VLoader } from '@/components/ui'

let app: App | null = null
let host: HTMLElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VLoader (barrel): the localized loading label', () => {
  it('announces itself with the localized common.loading string', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(VLoader, {})
    app.mount(host)
    expect(host.querySelector('.v-loader')?.getAttribute('aria-label')).toBe('Загружаем…')
  })

  it("an explicit consumer aria-label wins over the seam's default (§7.2 flip)", () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(VLoader, { 'aria-label': 'Fetching list' })
    app.mount(host)
    expect(host.querySelector('.v-loader')?.getAttribute('aria-label')).toBe('Fetching list')
  })
})
