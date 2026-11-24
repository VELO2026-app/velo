import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { VSelect } from '@/components/ui'

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
