// =============================================================================
// VELO Frontend -- kit icon family tests (FE-119, tz-ui-package.md §4 P4)
// =============================================================================
//
// The 12 cross-cutting glyphs (UI chrome + the VEmptyState ICON_MAP family)
// that move to @velo/ui/icons. Kit-compatible from day one: relative
// imports, no application aliases -- the file travels with the icons into
// the package unchanged. The domain icons (IconBrain, IconBreathwork,
// IconMoodScale*, ...) stay in the application and keep their own coverage
// story; this suite pins only the shared family contract: every glyph is a
// template-only <svg> sized by the `size` prop, default 24.
//
// Dependency-free SFC mount (createApp + happy-dom container), same shape
// as the kit's component tests.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App, type Component } from 'vue'

import IconArrowRight from './IconArrowRight.vue'
import IconCalendar from './IconCalendar.vue'
import IconCheck from './IconCheck.vue'
import IconClose from './IconClose.vue'
import IconDots from './IconDots.vue'
import IconFile from './IconFile.vue'
import IconGroup from './IconGroup.vue'
import IconList from './IconList.vue'
import IconRequired from './IconRequired.vue'
import IconRequiredDone from './IconRequiredDone.vue'
import IconSuccess from './IconSuccess.vue'
import IconWarning from './IconWarning.vue'

const ICONS: Record<string, Component> = {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconClose,
  IconDots,
  IconFile,
  IconGroup,
  IconList,
  IconRequired,
  IconRequiredDone,
  IconSuccess,
  IconWarning,
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(icon: Component, props: { size?: number | string } = {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(icon, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('kit icons (FE-119 P4)', () => {
  it.each(Object.keys(ICONS))('%s renders a template-only svg root', (name) => {
    const el = mount(ICONS[name]!)
    const svg = el.querySelector('svg')
    expect(svg).not.toBeNull()
    // The glyph IS the root: no wrapper element, no class hook to maintain.
    expect(svg).toBe(el.firstElementChild)
    expect(svg?.getAttribute('viewBox')).not.toBe('')
  })

  it.each(Object.keys(ICONS))('%s defaults to 24 and the size prop wins', (name) => {
    const el = mount(ICONS[name]!)
    const svg = el.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')

    const sized = mount(ICONS[name]!, { size: 16 })
    const svg16 = sized.querySelector('svg')
    expect(svg16?.getAttribute('width')).toBe('16')
    expect(svg16?.getAttribute('height')).toBe('16')
  })
})
