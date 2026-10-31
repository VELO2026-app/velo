// =============================================================================
// VELO Frontend -- BirthDateSheet Unit Tests (FE-101)
// =============================================================================
//
// Pins the sheet's contracts that do not need a real scroll:
//   1. the three wheel columns render with their Месяц/День/Год labels;
//   2. save with no prior pick emits the DEFAULT position (1 января 2000) --
//      the repo's "the untouched value travels" idiom (see
//      ExternalActivityCreateView.test.ts, pickDefaultTime);
//   3. a modelValue initializes the wheels and round-trips on save;
//   4. reopening re-initializes from the CURRENT modelValue, not the state
//      left over from the previous open.
//
// NOT COVERED, deliberately (same stance as every wheel consumer in the
// repo): driving VWheel by scroll -- happy-dom fires no scroll events for
// programmatic scrollTo, so the month-switch day clamp (Jan 31 -> Feb 28)
// and the current-year month/day truncation are exercised only through
// their observable defaults here, never by simulated gestures.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, reactive, nextTick, type App } from 'vue'
import BirthDateSheet from './BirthDateSheet.vue'

let app: App | null = null
let host: HTMLElement | null = null
const emitted: string[] = []

function mount(modelValue = ''): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(BirthDateSheet, {
    open: true,
    modelValue,
    'onUpdate:modelValue': (v: string) => emitted.push(v),
  }).use(createTestI18n())
  app.mount(host)
}

/** A reactive wrapper so one mount can CLOSE the sheet and reopen it with a
 *  different modelValue -- the reopen path createApp(Component, props)
 *  cannot reach (those props are not reactive). */
const state = reactive({ open: true, modelValue: '1995-03-07' })

function mountReactive(): void {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(BirthDateSheet, {
        open: state.open,
        modelValue: state.modelValue,
        'onUpdate:modelValue': (v: string) => emitted.push(v),
      }),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(Wrapper).use(createTestI18n())
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

function sheet(): HTMLElement {
  const el = document.body.querySelector('.v-sheet__panel')
  if (!el) throw new Error('the sheet did not render')
  return el as HTMLElement
}

function saveBtn(): HTMLButtonElement {
  const btn = sheet().querySelector('.v-sheet__save')
  if (!(btn instanceof HTMLButtonElement)) throw new Error('save did not render')
  return btn
}

function columnLabels(): string[] {
  return Array.from(sheet().querySelectorAll('.bds__label')).map((l) => l.textContent?.trim() ?? '')
}

beforeEach(() => {
  emitted.length = 0
})
afterEach(unmount)

describe('BirthDateSheet (FE-101)', () => {
  it('renders the three wheel columns with Месяц/День/Год labels', async () => {
    mount()
    await flush()

    expect(sheet().querySelectorAll('.v-wheel')).toHaveLength(3)
    expect(columnLabels()).toEqual(['Месяц', 'День', 'Год'])
  })

  it('save with no prior pick emits the default position as ISO', async () => {
    mount()
    await flush()

    saveBtn().click()
    await flush()

    expect(emitted).toEqual(['2000-01-01'])
  })

  it('a modelValue initializes the wheels and round-trips on save', async () => {
    mount('2001-10-14')
    await flush()

    saveBtn().click()
    await flush()

    expect(emitted).toEqual(['2001-10-14'])
  })

  it('reopening re-initializes from the current modelValue, not the leftover state', async () => {
    mountReactive()
    await flush()

    saveBtn().click()
    await flush()
    expect(emitted).toEqual(['1995-03-07'])

    // Close, change the value elsewhere, reopen: the wheels must follow the
    // fresh modelValue (the watch on `open` re-runs initFromModel).
    state.open = false
    await flush()
    state.modelValue = '2010-12-31'
    state.open = true
    await flush()

    saveBtn().click()
    await flush()
    expect(emitted).toEqual(['1995-03-07', '2010-12-31'])
  })
})
