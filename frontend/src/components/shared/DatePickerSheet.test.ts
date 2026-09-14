// =============================================================================
// VELO Frontend -- DatePickerSheet Unit Tests (FE-70: the `max` bound)
// =============================================================================
//
// The sheet grew an optional upper bound `max` (mirroring `min`) for the
// external-activity form, where nothing that has not happened yet can be
// recorded. These tests pin the bound's four contracts:
//   1. days after `max` are disabled in the grid;
//   2. the › month-nav stops at the max month (no all-disabled dead views);
//   3. `min` and `max` coexist (a window, not one edge winning);
//   4. WITHOUT `max` every existing caller is byte-identical: a wholly
//      future month stays fully pickable (the pre-max behaviour).
//
// Dependency-free SFC mount via createApp + happy-dom (matches
// DiaryComposer.test.ts / MethodTaxonomyPicker.test.ts -- no @vue/test-utils
// in this repo's convention). The sheet teleports to body, so queries go to
// document.body. The viewed month is pinned through modelValue (initFromModel
// derives the view from it), never through the wall clock.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DatePickerSheet from './DatePickerSheet.vue'

interface MountProps {
  modelValue?: string
  min?: string
  max?: string
}

let app: App | null = null
let host: HTMLElement | null = null
const emitted: string[] = []

function mount(props: MountProps = {}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DatePickerSheet, {
    open: true,
    ...props,
    'onUpdate:modelValue': (v: string) => emitted.push(v),
  })
  app.mount(host)
}

function unmount(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
}

async function flush(): Promise<void> {
  await nextTick()
}

/** The in-month day button for a day number (adjacent-month cells are dimmed
 *  and carry no .dps__day--dim marker distinction we need here). */
function dayBtn(day: number): HTMLButtonElement {
  const el = document.body.querySelector('.dps__grid')?.querySelectorAll('.dps__day')
  const btn = Array.from(el ?? []).find((b) => b.textContent?.trim() === String(day))
  if (!(btn instanceof HTMLButtonElement)) throw new Error(`day ${day} did not render`)
  return btn
}

function nextMonthBtn(): HTMLButtonElement {
  const btn = document.body.querySelector('button[aria-label="Следующий месяц"]')
  if (!(btn instanceof HTMLButtonElement)) throw new Error('next-month nav did not render')
  return btn
}

function saveBtn(): HTMLButtonElement {
  const btn = document.body.querySelector('.v-sheet__save')
  if (!(btn instanceof HTMLButtonElement)) throw new Error('save did not render')
  return btn
}

function monthLabel(): string {
  const el = document.body.querySelector('.dps__month')
  if (!el) throw new Error('month header did not render')
  return el.textContent?.trim() ?? ''
}

beforeEach(() => {
  emitted.length = 0
})
afterEach(unmount)

describe('DatePickerSheet max bound (FE-70)', () => {
  it('disables days after max, keeps earlier days pickable', async () => {
    mount({ modelValue: '2026-07-15', max: '2026-07-20' })
    await flush()

    expect(dayBtn(20).disabled).toBe(false)
    expect(dayBtn(21).disabled).toBe(true)
    expect(dayBtn(31).disabled).toBe(true)
  })

  it('stops the › month-nav at the max month', async () => {
    mount({ modelValue: '2026-07-15', max: '2026-07-20' })
    await flush()

    expect(nextMonthBtn().disabled).toBe(true)
    expect(monthLabel()).toContain('Июль')
  })

  it('allows one › step when max lives in the NEXT month, then stops there', async () => {
    mount({ modelValue: '2026-07-15', max: '2026-08-02' })
    await flush()

    expect(nextMonthBtn().disabled).toBe(false)
    nextMonthBtn().click()
    await flush()
    expect(monthLabel()).toContain('Август')
    // August is the max month: nav forward stops, and its late days are dead.
    expect(nextMonthBtn().disabled).toBe(true)
    expect(dayBtn(2).disabled).toBe(false)
    expect(dayBtn(3).disabled).toBe(true)
  })

  it('min and max coexist as a window', async () => {
    mount({ modelValue: '2026-07-15', min: '2026-07-10', max: '2026-07-20' })
    await flush()

    expect(dayBtn(9).disabled).toBe(true)
    expect(dayBtn(10).disabled).toBe(false)
    expect(dayBtn(20).disabled).toBe(false)
    expect(dayBtn(21).disabled).toBe(true)
  })

  it('emits the picked ISO date on save', async () => {
    mount({ modelValue: '2026-07-15', max: '2026-07-20' })
    await flush()

    dayBtn(18).click()
    saveBtn().click()
    await flush()

    expect(emitted).toEqual(['2026-07-18'])
  })

  it('without max, a wholly future month stays fully pickable (pre-max callers unchanged)', async () => {
    // No max at all: the bound must not have leaked into the default path.
    mount({ modelValue: '2026-07-15' })
    await flush()

    expect(nextMonthBtn().disabled).toBe(false)
    expect(dayBtn(1).disabled).toBe(false)
    expect(dayBtn(31).disabled).toBe(false)
  })
})
