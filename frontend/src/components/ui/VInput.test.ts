// =============================================================================
// VELO Frontend -- VInput Controlled-Input Tests (T8, PROMPT №434)
// =============================================================================
//
// Written alongside the fix for the defect found in PROMPT №432 (on TopupView)
// and traced to VInput in №433.
//
// THE BUG: VInput was not actually a controlled input. When a parent REJECTS or
// NORMALISES what was typed and lands back on the value it ALREADY held,
// `modelValue` does not change between renders -- so shouldUpdateComponent skips
// the child, the inner <input> is never patched, and the typed text survives.
// The field then displays something the state does not agree with.
//
// The mechanism is NOT "Vue skips the value patch" (Vue always patches `value`);
// the child never re-renders at all. That distinction is why the fix has to live
// in the child rather than in any parent.
//
// The parent in these tests is a MINIMAL harness, not a real screen: the point is
// to prove the CONTRACT at the component boundary, independent of any caller.
// The two real callers that actually hit this are covered in their own view
// tests (TopupView.test.ts, MasterNewPromocodeView.test.ts).
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref } from 'vue'
import VInput from '@/components/ui/VInput.vue'

let app: App | null = null
let host: HTMLElement | null = null

/**
 * Mount VInput under a parent that runs `normalise` over every emitted value --
 * i.e. the shape of a screen that sanitises input.
 */
function mountWith(
  normalise: (v: string) => string,
  initial = '',
  props: Record<string, unknown> = {},
): { input: HTMLInputElement; model: Ref<string> } {
  const model = ref(initial)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(VInput, {
        ...props,
        modelValue: model.value,
        'onUpdate:modelValue': (v: string) => {
          model.value = normalise(v)
        },
      }),
  })
  app.mount(host)
  const input = host.querySelector('input')
  if (!input) throw new Error('VInput rendered no <input>')
  return { input, model }
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
  await nextTick()
  await nextTick()
}

const rejectNegative = (v: string): string => (parseFloat(v) < 0 ? '' : v)
const clampToOne = (v: string): string => (v !== '' && Number(v) < 1 ? '1' : v)
const passThrough = (v: string): string => v

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('VInput', () => {
  describe('the controlled-input contract (the PROMPT №432 defect)', () => {
    it('REJECTED input is wiped from the FIELD, not just from the state', async () => {
      // THE regression guard, in its purest form: '' -> '-5' -> ''. The parent
      // lands back on the value it already held, so the child is not re-rendered
      // and, before the fix, kept showing «-5».
      const { input, model } = mountWith(rejectNegative, '')

      await type(input, '-5')

      expect(model.value).toBe('')
      expect(input.value).toBe('')
    })

    it('NORMALISED input shows the normalised value even when the state did not change', async () => {
      // The MasterNewPromocodeView clamp, reduced: the field already holds '1',
      // the user types '0', the parent clamps back to '1'. modelValue is '1'
      // before AND after, so nothing re-rendered and the field kept showing «0» --
      // a field that disagrees with what will actually be submitted.
      const { input, model } = mountWith(clampToOne, '1')

      await type(input, '0')

      expect(model.value).toBe('1')
      expect(input.value).toBe('1')
    })

    it('the FIRST normalisation was never broken -- the state genuinely changes there', async () => {
      // '' -> '0' -> '1' re-renders because '' !== '1'. This is why the original
      // MasterNewPromocodeView test passed while the bug was live: it only ever
      // exercised the first clamp. Pinned so the distinction is not lost.
      const { input, model } = mountWith(clampToOne, '')

      await type(input, '0')

      expect(model.value).toBe('1')
      expect(input.value).toBe('1')
    })

    it('survives a REPEATED rejection -- the second attempt is not sticky either', async () => {
      const { input, model } = mountWith(rejectNegative, '')

      await type(input, '-5')
      await type(input, '-9')

      expect(model.value).toBe('')
      expect(input.value).toBe('')
    })

    it('a rejection does not wedge the field -- a later valid value still lands', async () => {
      // The failure mode that would make the fix worse than the bug: an
      // over-eager re-assert that fights the user on every keystroke.
      const { input, model } = mountWith(rejectNegative, '')

      await type(input, '-5')
      await type(input, '25')

      expect(model.value).toBe('25')
      expect(input.value).toBe('25')
    })
  })

  describe('the accepted path is untouched (the other 42 sites)', () => {
    it('an accepted value passes straight through', async () => {
      const { input, model } = mountWith(passThrough, '')

      await type(input, 'hello')

      expect(model.value).toBe('hello')
      expect(input.value).toBe('hello')
    })

    it('does NOT write to the DOM when the parent accepts the value', async () => {
      // The `!==` guard in onInput is what keeps this fix inert for the 42 sites
      // that never reject anything. Writing el.value on every keystroke would
      // move the caret to the end mid-word for every user in the app.
      const { input } = mountWith(passThrough, '')
      const writes: string[] = []
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      Object.defineProperty(input, 'value', {
        configurable: true,
        get() {
          return proto?.get?.call(this)
        },
        set(v: string) {
          writes.push(v)
          proto?.set?.call(this, v)
        },
      })

      await type(input, 'abc')

      // Exactly the one write the test itself made in type(); the component
      // added none of its own.
      expect(writes).toEqual(['abc'])
    })

    it('clearing a field to empty is an accepted change, not a rejection', async () => {
      const { input, model } = mountWith(passThrough, 'abc')

      await type(input, '')

      expect(model.value).toBe('')
      expect(input.value).toBe('')
    })
  })

  describe('all three render paths get the fix (the W10 trap, VInput.vue:108-112)', () => {
    // A previous batch wired @focus onto the PLAIN path only; the floating-label
    // and affix paths each render their OWN <input> and silently missed it. The
    // same trap applies to @input, so each path is asserted separately rather
    // than trusting that one stands for all three.

    it('plain path', async () => {
      const { input, model } = mountWith(rejectNegative, '')
      await type(input, '-5')
      expect(input.value).toBe('')
      expect(model.value).toBe('')
    })

    it('floating-label path', async () => {
      const { input, model } = mountWith(rejectNegative, '', {
        floatingLabel: true,
        label: 'Сумма',
      })
      expect(host?.querySelector('.v-input__field--float')).not.toBeNull()
      await type(input, '-5')
      expect(input.value).toBe('')
      expect(model.value).toBe('')
    })

    it('affix path (prefix slot -- this is the one TopupView actually renders)', async () => {
      const model = ref('')
      host = document.createElement('div')
      document.body.appendChild(host)
      app = createApp({
        render: () =>
          h(
            VInput,
            {
              modelValue: model.value,
              'onUpdate:modelValue': (v: string) => {
                model.value = rejectNegative(v)
              },
            },
            { prefix: () => h('span', '€') },
          ),
      })
      app.mount(host)
      const input = host.querySelector('input')!
      expect(host.querySelector('.v-input__field--bare')).not.toBeNull()

      await type(input, '-5')

      expect(input.value).toBe('')
      expect(model.value).toBe('')
    })
  })

  describe('the rest of the contract (unchanged by the fix)', () => {
    it('renders the label and reflects the model', () => {
      mountWith(passThrough, 'hi', { label: 'Имя' })

      expect(host?.textContent).toContain('Имя')
      expect(host?.querySelector('input')?.value).toBe('hi')
    })

    it('renders an error message and the error modifier', () => {
      mountWith(passThrough, '', { error: 'Обязательное поле' })

      expect(host?.textContent).toContain('Обязательное поле')
      expect(host?.querySelector('.v-input--error')).not.toBeNull()
    })

    it('forwards native attrs onto the inner input, not the wrapper (inheritAttrs:false)', () => {
      mountWith(passThrough, '', { type: 'number', min: 1, max: 500 })
      const input = host?.querySelector('input')

      expect(input?.getAttribute('type')).toBe('number')
      expect(input?.getAttribute('min')).toBe('1')
      expect(host?.querySelector('.v-input')?.hasAttribute('min')).toBe(false)
    })

    it('exposes focus()', () => {
      // Used by TopupView to focus the custom-amount field on reveal
      // (TopupView.vue:152-156).
      mountWith(passThrough, '')
      const input = host?.querySelector('input')
      const spy = vi.spyOn(input!, 'focus')

      const vm = app?._instance?.subTree.component?.exposed as { focus: () => void } | undefined
      vm?.focus()

      expect(spy).toHaveBeenCalled()
    })
  })
})
