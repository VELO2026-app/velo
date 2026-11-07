// =============================================================================
// VDayPicker Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container) — the repo has
// no @vue/test-utils, and plugin-vue (vitest.config) compiles the .vue for
// us. Kit-compatible from day one: relative import, no application aliases —
// the file travels with the component into @velo/ui unchanged.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import VDayPicker from './VDayPicker.vue'

import { configureUi } from '../../i18n'

// The kit component reads the host translator (FE-118 P3): the test injects
// a dictionary with the golden ru values, so the assertions below pin the
// same rendered texts the app suite asserted before the move.
configureUi({
  t: (key) =>
    ({
      'ui.weekdays': 'Дни недели',
      'ui.dayFull.mon': 'Понедельник',
      'ui.dayFull.sun': 'Воскресенье',
      'ui.dayShort.mon': 'ПН',
      'ui.dayShort.tue': 'ВТ',
      'ui.dayShort.wed': 'СР',
      'ui.dayShort.thu': 'ЧТ',
      'ui.dayShort.fri': 'ПТ',
      'ui.dayShort.sat': 'СБ',
      'ui.dayShort.sun': 'ВС',
    })[key] ?? key,
})

let app: App | null = null
let host: HTMLElement | null = null

const emitted: string[][] = []

// The harness feeds the emitted selection back into the prop (v-model),
// otherwise the second click would toggle against a stale empty selection.
let selected: { value: string[] }

function mount(props: { modelValue?: string[]; ariaLabel?: string }): HTMLElement {
  selected = ref(props.modelValue ?? [])
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(VDayPicker, {
        ...props,
        modelValue: selected.value,
        'onUpdate:modelValue': (value: string[]) => {
          selected.value = value
          emitted.push([...value])
        },
      }),
  })
  app.mount(host)
  return host
}

function dayButtons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('.v-day-picker__day')]
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  emitted.length = 0
})

describe('VDayPicker', () => {
  it('renders seven Mon-first day buttons with short labels and full aria names', () => {
    const el = mount({})
    const buttons = dayButtons(el)
    expect(buttons.map((b) => b.textContent)).toEqual(['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'])
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Понедельник')
    expect(buttons[6]?.getAttribute('aria-label')).toBe('Воскресенье')
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('the row is a labelled group: localized default, prop override wins', () => {
    expect(mount({}).querySelector('.v-day-picker')?.getAttribute('aria-label')).toBe('Дни недели')
    expect(
      mount({ ariaLabel: 'Practice days' })
        .querySelector('.v-day-picker')
        ?.getAttribute('aria-label'),
    ).toBe('Practice days')
  })

  it('selection is visible: pressed state and the on modifier', () => {
    const el = mount({ modelValue: ['wed'] })
    const buttons = dayButtons(el)
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[2]?.className).toContain('v-day-picker__day--on')
    expect(buttons[0]?.className).not.toContain('v-day-picker__day--on')
  })

  it('toggles days and emits the canonical Mon-first order regardless of clicks', async () => {
    const el = mount({ modelValue: [] })
    const buttons = dayButtons(el)
    buttons[6]?.click() // Sunday first
    await nextTick()
    buttons[0]?.click() // then Monday
    await nextTick()
    expect(emitted).toEqual([['sun'], ['mon', 'sun']])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    // Clicking a selected day removes it.
    dayButtons(el)[0]?.click()
    await nextTick()
    expect(emitted[2]).toEqual(['sun'])
  })
})
