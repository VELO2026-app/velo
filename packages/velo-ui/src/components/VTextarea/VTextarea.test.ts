// =============================================================================
// @velo/ui -- VTextarea Unit Tests (FE-144: written BEFORE the @velo/ui move;
// moved with the component by FE-153)
// =============================================================================
//
// P6a-2 safety net, same pattern as VModal.test.ts from FE-142: VTextarea
// moves to @velo/ui under FE-121 (P6) and its only tests today are the VOICE
// cases (VTextarea.voice.test.ts, FE-94) -- the plain field contract was
// unpinned. "moving untested code is forbidden". These pin the CURRENT
// component's markup/events as-is. Zero component edits: anything that could
// only pass after an edit is a component finding for the FE-144 report, not
// a fix in here.
//
// What is pinned (markup + events ONLY -- happy-dom: no var() tokens, no
// computed-style assertions; scrollHeight itself is never asserted, only that
// the autogrow seam SET the inline height):
//   - the label ↔ field wiring (useId fieldId, hideLabel keeps the label in
//     the DOM), placeholder/rows/disabled/maxlength (inheritAttrs:false puts
//     caller attrs on the <textarea>, never the wrapper);
//   - the v-model contract: typing emits update:modelValue, the model
//     re-binds the field;
//   - the variants as implemented: borderedAtRest and the autogrow class;
//   - autogrow BY FACT drives an INLINE height (JS resize on mount, on input
//     and on programmatic model changes) -- the non-autogrow field is never
//     touched. In happy-dom scrollHeight is 0, so the driven height is '0px';
//     that exact value pins that the resize seam ran, nothing more;
//   - the validation wiring: aria-invalid + aria-describedby -> the
//     role=alert line inside VFieldError, the --error modifier;
//   - the required seal trio (off / empty / done).
//
// FE-153 cut the voice seam: the field knows no voice, it offers the
// #takeover/#trailing slots and an exposed blur() instead (pinned at the
// bottom). The voice behaviour itself is the app's VoiceTextarea and its
// own test. useKeyboardFieldScroll is MOCKED per the FE-144 order -- only its
// WIRING (onFieldFocus bound as @focus) is asserted, never the real scroll.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1 (no
// @vue/test-utils). The parent is a MINIMAL two-way harness, so the DOM
// re-bind assertions test the component boundary, not any real screen.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref, type VNode } from 'vue'
import VTextarea from './VTextarea.vue'

// FE-144: the keyboard focus-scroll seam -- mocked, only the binding asserted.
const onFieldFocus = vi.hoisted(() => vi.fn())
vi.mock('../../keyboardFieldScroll', () => ({
  useKeyboardFieldScroll: () => ({ onFieldFocus }),
}))

// -- mount ------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

/** Two-way mount: the parent echoes every emit back into the model. */
async function mountField(
  props: Record<string, unknown> = {},
  initial = '',
  slots?: Record<string, () => VNode>,
): Promise<{ field: HTMLTextAreaElement; model: Ref<string> }> {
  const model = ref(initial)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        VTextarea,
        {
          ...props,
          modelValue: model.value,
          'onUpdate:modelValue': (v: string) => {
            model.value = v
          },
        },
        slots,
      ),
  })
  app.mount(host)
  await flush(2)
  const field = host.querySelector('textarea')
  if (!field) throw new Error('VTextarea rendered no <textarea>')
  return { field, model }
}

async function flush(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await nextTick()
}

async function type(field: HTMLTextAreaElement, value: string): Promise<void> {
  field.value = value
  field.dispatchEvent(new Event('input'))
  await flush()
}

function label(): HTMLLabelElement | null {
  return host?.querySelector('label.v-textarea__label') ?? null
}

/** FE-153: the takeover region (present only while `takeover` is on). */
function takeoverRegion(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('.v-textarea__takeover') ?? null
}

/** The live error line inside the always-mounted VFieldError row. */
function errorText(): HTMLParagraphElement | null {
  return host?.querySelector('.v-field-error__text') ?? null
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  onFieldFocus.mockClear()
  vi.clearAllMocks()
})

// -- tests -------------------------------------------------------------------

describe('VTextarea (markup basics)', () => {
  it('label[for] === textarea.id (the useId association), placeholder and the default rows=3 on the field', async () => {
    const { field } = await mountField({ label: 'О себе', placeholder: 'Расскажите...' })

    expect(label()?.getAttribute('for')).toBe(field.id)
    expect(label()?.textContent).toBe('О себе')
    expect(field.classList.contains('v-textarea__field')).toBe(true)
    expect(field.getAttribute('placeholder')).toBe('Расскажите...')
    expect(field.getAttribute('rows')).toBe('3')
  })

  it('a custom :rows lands on the field', async () => {
    const { field } = await mountField({ label: 'Описание', rows: 4 })
    expect(field.getAttribute('rows')).toBe('4')
  })

  it('hideLabel keeps the label in the DOM (accessible name) but visually hides it', async () => {
    await mountField({ label: 'Описание', hideLabel: true })

    expect(label()?.textContent).toBe('Описание')
    expect(label()?.classList.contains('v-textarea__label--visually-hidden')).toBe(true)
  })

  it('hideLabel is OFF by default -- the visible label stays for every existing caller', async () => {
    await mountField({ label: 'Описание' })
    expect(label()?.classList.contains('v-textarea__label--visually-hidden')).toBe(false)
  })

  it('no label prop renders no label element at all', async () => {
    await mountField()
    expect(label()).toBeNull()
  })

  it('caller attrs land on the <textarea>, not the wrapper (inheritAttrs:false)', async () => {
    const { field } = await mountField({ maxlength: 2000 })

    expect(field.getAttribute('maxlength')).toBe('2000')
    expect(host?.querySelector('.v-textarea')?.hasAttribute('maxlength')).toBe(false)
  })

  it('disabled reaches the field', async () => {
    const { field } = await mountField({ label: 'Описание', disabled: true })
    expect(field.disabled).toBe(true)
  })
})

describe('VTextarea (variants as implemented)', () => {
  it('borderedAtRest adds the modifier; the default field stays borderless-at-rest class-wise', async () => {
    const plain = await mountField({ label: 'Описание' })
    expect(plain.field.classList.contains('v-textarea__field--bordered-rest')).toBe(false)
    host?.remove()
    host = null

    const bordered = await mountField({ label: 'Описание', borderedAtRest: true })
    expect(bordered.field.classList.contains('v-textarea__field--bordered-rest')).toBe(true)
  })

  it('autogrow adds the --autogrow class; off by default', async () => {
    const fixed = await mountField({ label: 'Описание' })
    expect(fixed.field.classList.contains('v-textarea__field--autogrow')).toBe(false)
    host?.remove()
    host = null

    const grow = await mountField({ label: 'Описание', autogrow: true })
    expect(grow.field.classList.contains('v-textarea__field--autogrow')).toBe(true)
  })
})

describe('VTextarea (autogrow drives an INLINE height -- happy-dom: scrollHeight is 0)', () => {
  it('autogrow sets style.height on mount AND on input (the JS resize seam ran)', async () => {
    const { field } = await mountField({ label: 'Описание', autogrow: true }, '')
    // onMounted -> nextTick(resize): happy-dom measures scrollHeight 0, so the
    // driven height is exactly '0px'. The VALUE is meaningless; the SET is
    // the contract (CSS caps it in a real browser, never asserted here).
    expect(field.style.height).toBe('0px')

    await type(field, 'первая строка')
    expect(field.style.height).toBe('0px')
  })

  it('without autogrow the inline height is never touched', async () => {
    const { field } = await mountField({ label: 'Описание' })
    await type(field, 'текст в фиксированном поле')
    expect(field.style.height).toBe('')
  })

  it('a PROGRAMMATIC model change re-runs the resize (the edit form populating after load)', async () => {
    const { field, model } = await mountField({ label: 'Описание', autogrow: true }, '')
    expect(field.style.height).toBe('0px')

    field.style.height = '' // pretend an earlier resize never happened
    model.value = 'длинный текст, пришедший из формы редактирования'
    await flush()
    expect(field.style.height).toBe('0px')
  })
})

describe('VTextarea (v-model)', () => {
  it('typing emits update:modelValue and the echoed model re-binds the field', async () => {
    const { field, model } = await mountField({ label: 'О себе' })

    await type(field, 'привет')
    expect(model.value).toBe('привет')
    expect(field.value).toBe('привет')

    await type(field, 'привет, мир')
    expect(model.value).toBe('привет, мир')
    expect(field.value).toBe('привет, мир')
  })
})

describe('VTextarea (validation wiring)', () => {
  it('no error: no aria-invalid, no aria-describedby, the error row is collapsed+aria-hidden', async () => {
    const { field } = await mountField({ label: 'Описание' })

    expect(field.hasAttribute('aria-invalid')).toBe(false)
    expect(field.hasAttribute('aria-describedby')).toBe(false)
    expect(host?.querySelector('.v-textarea--error')).toBeNull()
    expect(host?.querySelector('.v-field-error')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('error: aria-invalid=true, aria-describedby -> the role=alert line with the text, the --error modifier', async () => {
    const { field } = await mountField({ label: 'Описание', error: 'Обязательное поле' })

    expect(field.getAttribute('aria-invalid')).toBe('true')
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy).toBe(`${field.id}-error`)

    const line = errorText()
    expect(line?.getAttribute('role')).toBe('alert')
    expect(line?.id).toBe(describedBy)
    expect(line?.textContent).toBe('Обязательное поле')
    expect(host?.querySelector('.v-textarea--error')).not.toBeNull()
  })
})

describe('VTextarea (the required seal)', () => {
  it('off by default: no seal renders', async () => {
    await mountField({ label: 'Описание', modelValue: '' })
    expect(host?.querySelector('.v-textarea__seal')).toBeNull()
  })

  it('required + empty renders the seal NOT done; filling the model flips it done', async () => {
    const { model } = await mountField({ label: 'Описание', required: true }, '')

    const seal = host?.querySelector('.v-textarea__seal')
    expect(seal).not.toBeNull()
    expect(seal?.classList.contains('v-textarea__seal--done')).toBe(false)

    model.value = 'заполнено'
    await flush()
    expect(
      host?.querySelector('.v-textarea__seal')?.classList.contains('v-textarea__seal--done'),
    ).toBe(true)
  })
})

describe('VTextarea (the keyboard focus-scroll seam -- useKeyboardFieldScroll mocked)', () => {
  it('focusing the field calls onFieldFocus (the DS-wide default wiring)', async () => {
    const { field } = await mountField({ label: 'Описание' })

    field.focus()

    expect(onFieldFocus).toHaveBeenCalledTimes(1)
  })
})

describe('VTextarea (FE-153: the takeover/trailing slots -- the voice seam, cut)', () => {
  it('takeover OFF (the default): the field shows, no takeover region, the slot content is not rendered', async () => {
    const { field } = await mountField({ label: 'Описание' }, '', {
      takeover: () => h('span', { class: 'probe-takeover' }, 'panel'),
    })
    expect(field.style.display).not.toBe('none')
    expect(takeoverRegion()).toBeNull()
    expect(host?.querySelector('.probe-takeover')).toBeNull()
  })

  it('takeover ON: the field hides but stays mounted, the slot renders in its place', async () => {
    const { field } = await mountField({ label: 'Описание', takeover: true }, 'текст', {
      takeover: () => h('span', { class: 'probe-takeover' }, 'panel'),
    })
    expect(field.style.display).toBe('none')
    expect(field.value).toBe('текст')
    const region = takeoverRegion()
    expect(region?.querySelector('.probe-takeover')).not.toBeNull()
  })

  it('an EMPTY takeover still holds the band (the voice permission-prompt freeze)', async () => {
    await mountField({ label: 'Описание', takeover: true })
    const region = takeoverRegion()
    expect(region).not.toBeNull()
    expect(region?.children.length).toBe(0)
  })

  it('the fixed-rows variant wears the plate; autogrow stays transparent', async () => {
    await mountField({ label: 'Описание', takeover: true })
    expect(takeoverRegion()?.classList.contains('v-textarea__takeover--plate')).toBe(true)
    host?.remove()
    host = null

    await mountField({ label: 'Описание', takeover: true, autogrow: true })
    expect(takeoverRegion()?.classList.contains('v-textarea__takeover--plate')).toBe(false)
  })

  it('autogrow pauses for the takeover and re-measures when it ends', async () => {
    const takeover = ref(true)
    const model = ref('')
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () =>
        h(VTextarea, {
          autogrow: true,
          takeover: takeover.value,
          modelValue: model.value,
        }),
    })
    app.mount(host)
    await flush()
    const field = host.querySelector('textarea')!
    // Mounted under a takeover: the hidden field is never measured.
    expect(field.style.height).toBe('')
    model.value = 'пришло, пока поле скрыто'
    await flush()
    expect(field.style.height).toBe('')

    takeover.value = false
    await flush()
    expect(field.style.height).toBe('0px')
  })

  it('#trailing renders at the row end, after the required seal', async () => {
    await mountField({ label: 'Описание', required: true }, '', {
      trailing: () => h('button', { class: 'probe-trailing' }, 'mic'),
    })
    const row = host?.querySelector('.v-textarea__row')
    const last = row?.lastElementChild
    expect(last?.classList.contains('probe-trailing')).toBe(true)
    expect(last?.previousElementSibling?.classList.contains('v-textarea__seal')).toBe(true)
  })

  it('the exposed blur() drops focus from the field', async () => {
    const exposed = ref<{ blur: () => void } | null>(null)
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(VTextarea, { ref: exposed, label: 'Описание' }),
    })
    app.mount(host)
    await flush()
    const field = host.querySelector('textarea')!
    field.focus()
    expect(document.activeElement).toBe(field)

    exposed.value?.blur()
    expect(document.activeElement).not.toBe(field)
  })
})
