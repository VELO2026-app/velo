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

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref } from 'vue'
import VInput from '@/components/ui/VInput.vue'

// FE-144 (P6a-2, pre-@velo/ui-move): the keyboard focus-scroll seam is
// MOCKED per the ticket -- only its WIRING (onFieldFocus bound as @focus on
// each render path) is asserted in the FE-144 section at the bottom, never
// the real scroll machinery.
const onFieldFocus = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useKeyboardFieldScroll', () => ({
  useKeyboardFieldScroll: () => ({ onFieldFocus }),
}))

let app: App | null = null
let host: HTMLElement | null = null

/**
 * Mount VInput under a parent that runs `normalise` over every emitted value --
 * i.e. the shape of a screen that sanitises input.
 *
 * FE-144: the optional `affix` mounts the prefix/suffix slots (the affix
 * render path), so the new sections reuse the same two-way harness.
 */
function mountWith(
  normalise: (v: string) => string,
  initial = '',
  props: Record<string, unknown> = {},
  affix?: 'prefix' | 'suffix' | 'both',
): { input: HTMLInputElement; model: Ref<string> } {
  const model = ref(initial)
  host = document.createElement('div')
  document.body.appendChild(host)
  const slots =
    affix === undefined
      ? undefined
      : {
          ...(affix !== 'suffix' ? { prefix: () => h('span', '€') } : {}),
          ...(affix !== 'prefix' ? { suffix: () => h('span', '₽') } : {}),
        }
  app = createApp({
    render: () =>
      h(
        VInput,
        {
          ...props,
          modelValue: model.value,
          'onUpdate:modelValue': (v: string) => {
            model.value = normalise(v)
          },
        },
        slots,
      ),
  }).use(createTestI18n())
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
      }).use(createTestI18n())
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

    it('T24-6 (PROMPT №639): hideLabel keeps the label in the DOM (accessible name) but visually hides it', () => {
      mountWith(passThrough, '', { label: 'Название', hideLabel: true })

      const label = host?.querySelector('.v-input__label')
      expect(label).not.toBeNull()
      expect(label?.textContent).toBe('Название')
      expect(label?.classList.contains('v-input__label--visually-hidden')).toBe(true)
    })

    it('T24-6: hideLabel is OFF by default -- every existing caller stays byte-identical', () => {
      mountWith(passThrough, '', { label: 'Название' })

      expect(
        host
          ?.querySelector('.v-input__label')
          ?.classList.contains('v-input__label--visually-hidden'),
      ).toBe(false)
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

  // ===========================================================================
  // FE-144 (P6a-2): the pre-@velo/ui-move contract pin. Everything the move
  // must preserve that the controlled-input sections above do not cover:
  // the label↔field wiring, the validation aria wiring, the required seal,
  // the affix order and the focus-scroll seam. Markup + events only
  // (happy-dom: no var() tokens, no computed styles). Zero component edits --
  // anything that would need one is a finding for the FE-144 report.
  // ===========================================================================

  describe('FE-144: the label ↔ field wiring (PROMPT №679)', () => {
    it('plain path: the external label[for] === input.id (the useId association)', () => {
      mountWith(passThrough, '', { label: 'Имя' })

      const label = host?.querySelector('label.v-input__label')
      const input = host?.querySelector('input')
      expect(label?.getAttribute('for')).toBe(input?.id)
      expect(label?.textContent).toBe('Имя')
    })

    it('floating path: NO external label; the internal float label binds the same id; --filled tracks the model', async () => {
      const empty = mountWith(passThrough, '', { floatingLabel: true, label: 'Сумма' })
      expect(host?.querySelector('label.v-input__label')).toBeNull()
      const floatLabel = host?.querySelector('.v-input__float-label')
      expect(floatLabel?.getAttribute('for')).toBe(empty.input.id)
      expect(
        host?.querySelector('.v-input__float')?.classList.contains('v-input__float--filled'),
      ).toBe(false)

      await type(empty.input, 'заполнено')
      expect(
        host?.querySelector('.v-input__float')?.classList.contains('v-input__float--filled'),
      ).toBe(true)
    })

    it('floatingLabel is IGNORED when an affix slot is present: the affix path wins -- and NO label renders (FE-144 finding, pinned as-is)', () => {
      // FE-144 FINDING (not fixed here -- test-only ticket): the external
      // label's v-if is `label && !floatingLabel`, but it is the FLOAT branch
      // that backs off for affix slots. A caller combining floatingLabel with
      // a prefix/suffix slot therefore gets the affix path with NO label of
      // any kind: no external label, no float label -- the bare input loses
      // its accessible name entirely. Pinned as-implemented for the move;
      // see the FE-144 report.
      mountWith(passThrough, '', { floatingLabel: true, label: 'Сумма' }, 'prefix')

      expect(host?.querySelector('.v-input__float')).toBeNull()
      expect(host?.querySelector('.v-input__box')).not.toBeNull()
      expect(host?.querySelector('label.v-input__label')).toBeNull()
      expect(host?.querySelector('.v-input__float-label')).toBeNull()
    })

    it('affix path: the external label binds the inner bare input id too', () => {
      mountWith(passThrough, '', { label: 'Сумма' }, 'prefix')

      const label = host?.querySelector('label.v-input__label')
      const input = host?.querySelector('input.v-input__field--bare')
      expect(label?.getAttribute('for')).toBe(input?.id)
    })
  })

  describe('FE-144: the validation wiring (aria + VFieldError)', () => {
    it('no error: no aria-invalid, no aria-describedby; the always-mounted error row is aria-hidden', () => {
      mountWith(passThrough, '', { label: 'Имя' })
      const input = host?.querySelector('input')

      expect(input?.hasAttribute('aria-invalid')).toBe(false)
      expect(input?.hasAttribute('aria-describedby')).toBe(false)
      expect(host?.querySelector('.v-input--error')).toBeNull()
      expect(host?.querySelector('.v-field-error')?.getAttribute('aria-hidden')).toBe('true')
    })

    it('error (plain path): aria-invalid=true, aria-describedby -> the role=alert line with the text', () => {
      mountWith(passThrough, '', { label: 'Имя', error: 'Обязательное поле' })
      const input = host?.querySelector('input')

      expect(input?.getAttribute('aria-invalid')).toBe('true')
      const describedBy = input?.getAttribute('aria-describedby')
      expect(describedBy).toBe(`${input?.id}-error`)

      const line = host?.querySelector('.v-field-error__text')
      expect(line?.getAttribute('role')).toBe('alert')
      expect(line?.id).toBe(describedBy)
      expect(line?.textContent).toBe('Обязательное поле')
      expect(host?.querySelector('.v-input--error')).not.toBeNull()
    })

    it('error on the FLOATING path wires the same aria onto its own <input> (W10 paranoia)', () => {
      mountWith(passThrough, '', { floatingLabel: true, label: 'Сумма', error: 'Мало' })
      const input = host?.querySelector('input')

      expect(input?.getAttribute('aria-invalid')).toBe('true')
      expect(input?.getAttribute('aria-describedby')).toBe(`${input?.id}-error`)
    })

    it('error on the AFFIX path wires the same aria onto its own <input>', () => {
      mountWith(passThrough, '', { label: 'Сумма', error: 'Мало' }, 'prefix')
      const input = host?.querySelector('input')

      expect(input?.getAttribute('aria-invalid')).toBe('true')
      expect(input?.getAttribute('aria-describedby')).toBe(`${input?.id}-error`)
    })
  })

  describe('FE-144: the required seal (DS marker)', () => {
    it('off by default: no seal renders', () => {
      mountWith(passThrough, '', { label: 'Имя' })
      expect(host?.querySelector('.v-input__seal')).toBeNull()
    })

    it('required + empty renders the seal NOT done; typing flips it done', async () => {
      const { input } = mountWith(passThrough, '', { label: 'Имя', required: true })

      const seal = host?.querySelector('.v-input__seal')
      expect(seal).not.toBeNull()
      expect(seal?.classList.contains('v-input__seal--done')).toBe(false)

      await type(input, 'заполнено')
      expect(host?.querySelector('.v-input__seal')?.classList.contains('v-input__seal--done')).toBe(
        true,
      )
    })
  })

  describe('FE-144: misc markup parity', () => {
    it('placeholder and disabled reach the inner input (plain path)', () => {
      mountWith(passThrough, '', { placeholder: 'Подсказка' })
      expect(host?.querySelector('input')?.getAttribute('placeholder')).toBe('Подсказка')

      mountWith(passThrough, '', { disabled: true })
      expect(host?.querySelector('input')?.disabled).toBe(true)
    })

    it('the affix order is prefix -> input -> suffix inside the box', () => {
      mountWith(passThrough, '', {}, 'both')

      const box = host?.querySelector('.v-input__box')
      const children = Array.from(box?.children ?? [])
      expect(children[0]?.classList.contains('v-input__affix')).toBe(true)
      expect(children[0]?.textContent).toBe('€')
      expect(children[1]?.tagName).toBe('INPUT')
      expect(children[2]?.classList.contains('v-input__affix')).toBe(true)
      expect(children[2]?.textContent).toBe('₽')
    })
  })

  describe('FE-144: the keyboard focus-scroll seam (useKeyboardFieldScroll mocked)', () => {
    // The DS-wide default wiring (the W10 lesson): every render path binds
    // @focus -> onFieldFocus. The composable is mocked, so only the BINDING
    // is asserted -- never the real scroll.

    it('plain path input focus calls onFieldFocus', async () => {
      const { input } = mountWith(passThrough, '', { label: 'Имя' })
      input.focus()
      expect(onFieldFocus).toHaveBeenCalledTimes(1)
    })

    it('floating path input focus calls onFieldFocus', async () => {
      const { input } = mountWith(passThrough, '', { floatingLabel: true, label: 'Сумма' })
      input.focus()
      expect(onFieldFocus).toHaveBeenCalledTimes(1)
    })

    it('affix path input focus calls onFieldFocus', async () => {
      const { input } = mountWith(passThrough, '', { label: 'Сумма' }, 'prefix')
      input.focus()
      expect(onFieldFocus).toHaveBeenCalledTimes(1)
    })
  })
})
