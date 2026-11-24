// =============================================================================
// VBarChart Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, type App } from 'vue'
import VBarChart from './VBarChart.vue'

import { configureUi } from '../../i18n'

// The kit component reads the host translator (FE-118 P3): the test injects
// a dictionary with the golden ru values, so the assertions below pin the
// same rendered texts the app suite asserted before the move.
configureUi({ t: (key) => ({ 'ui.noData': 'Данных пока нет' })[key] ?? key })

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: {
  bars?: { label: string; value: number }[]
  emptyText?: string
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VBarChart, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VBarChart', () => {
  it('renders one labelled column per bar, heights scaled to the max', () => {
    const el = mount({
      bars: [
        { label: 'MO', value: 58 },
        { label: 'TU', value: 100 },
      ],
    })
    const cols = el.querySelectorAll('.v-bar-chart__col')
    expect(cols.length).toBe(2)
    const bars = el.querySelectorAll<HTMLElement>('.v-bar-chart__bar')
    expect(bars[0]?.getAttribute('style')).toContain('height: 58%')
    expect(bars[1]?.getAttribute('style')).toContain('height: 100%')
    expect(el.querySelector('.v-bar-chart__label')?.textContent).toBe('MO')
  })

  // happy-dom has no layout, so this pins the structure the layout rests on
  // (the bar's percent height is of its own track, the label stands beside the
  // track); the effect itself -- 7 rates of 69..88 % drawn as 83..106 px
  // instead of 101..106 px -- was measured in Chromium (FE-268).
  it('draws each bar in a track of its own, with the label beside the track, not in it', () => {
    const el = mount({
      bars: [
        { label: 'MO', value: 100 },
        { label: 'TU', value: 90 },
      ],
    })
    const cols = Array.from(el.querySelectorAll('.v-bar-chart__col'))
    expect(cols).toHaveLength(2)
    for (const col of cols) {
      const track = col.querySelector(':scope > .v-bar-chart__track')
      const label = col.querySelector(':scope > .v-bar-chart__label')
      expect(track).not.toBeNull()
      expect(label).not.toBeNull()
      expect(track?.querySelector('.v-bar-chart__bar')).not.toBeNull()
      expect(track?.contains(label ?? null)).toBe(false)
    }
  })

  it('never collapses a bar below the 4% floor', () => {
    const el = mount({
      bars: [
        { label: 'MO', value: 0 },
        { label: 'TU', value: 90 },
      ],
    })
    const bars = el.querySelectorAll<HTMLElement>('.v-bar-chart__bar')
    expect(bars[0]?.getAttribute('style')).toContain('height: 4%')
  })

  it('empty series renders the localized fallback text', () => {
    const el = mount({ bars: [] })
    expect(el.querySelector('.v-bar-chart__plot')).toBeNull()
    expect(el.querySelector('.v-bar-chart__empty')?.textContent).toBe('Данных пока нет')
  })

  it('the emptyText prop overrides the fallback', () => {
    const el = mount({ bars: [], emptyText: 'Nothing this week' })
    expect(el.querySelector('.v-bar-chart__empty')?.textContent).toBe('Nothing this week')
  })
})
