import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VSelect from './VSelect.vue'

// FE-241: a select whose name is a heading elsewhere on the screen gets its
// accessible name from `ariaLabel`; a visible `label` still wins.
describe('VSelect accessible name', () => {
  const options = [{ value: 'a', label: 'A' }]

  it('uses ariaLabel when there is no visible label', () => {
    const w = mount(VSelect, { props: { options, ariaLabel: 'Date format' } })
    expect(w.find('select').attributes('aria-label')).toBe('Date format')
  })

  it('leaves the name to the visible label when one is given', () => {
    const w = mount(VSelect, { props: { options, label: 'Format', ariaLabel: 'Date format' } })
    expect(w.find('select').attributes('aria-label')).toBeUndefined()
  })
})

// FE-275: a select on the page, not in a form, takes the gap away and
// outlines its field; a plain one in a form keeps both as they were.
describe('VSelect on the page', () => {
  const options = [{ value: 'a', label: 'A' }]

  it('is a plain form field unless asked', () => {
    const w = mount(VSelect, { props: { options } })
    expect(w.classes()).not.toContain('v-select--flush')
    expect(w.classes()).not.toContain('v-select--outlined')
  })

  it('takes the form gap away with `flush` and outlines the field with `outlined`', () => {
    const w = mount(VSelect, { props: { options, flush: true, outlined: true } })
    expect(w.classes()).toEqual(expect.arrayContaining(['v-select--flush', 'v-select--outlined']))
  })
})
