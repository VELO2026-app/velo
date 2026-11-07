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
