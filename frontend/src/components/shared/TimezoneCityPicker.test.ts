// =============================================================================
// VELO Frontend -- TimezoneCityPicker unit tests
// =============================================================================
// Owner ruling: the SELECTED zone leads the list (the current choice must be
// visible without scrolling). Rows sharing the selected IANA float together
// (the check is per-iana), the rest keep the curated/generated order, and
// search still filters with a selected match leading its results.
//
// The backend catalog (BE-157) is mocked to fail here, so the rows are the
// curated ones (CURATED_CITIES) -- every zone below is curated, which is the
// order these tests are about. Catalog rows and spellings:
// TimezoneCityPicker.spelling.test.ts.
// =============================================================================

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Picker from './TimezoneCityPicker.vue'
import { CURATED_CITIES } from '@/utils/timezoneCities'

vi.mock('@/api/users', () => ({
  getTimezoneCatalog: vi.fn(() => Promise.reject(new Error('offline'))),
}))

function mountPicker(modelValue = '') {
  return mount(Picker, { props: { modelValue } })
}

describe('TimezoneCityPicker -- the selected zone leads the list', () => {
  it('a deep-in-the-list selection becomes the first row, still checked', () => {
    const wrapper = mountPicker('Asia/Tokyo')
    const list = wrapper.findAll('.tz-picker__row')
    expect(list).toHaveLength(CURATED_CITIES.length)
    expect(list[0]!.text()).toContain('Токио')
    expect(list[0]!.classes()).toContain('tz-picker__row--active')
    expect(list[0]!.find('.tz-picker__check').exists()).toBe(true)
    // the rest keeps the curated order: the floated block is exactly one row
    expect(list[1]!.text()).not.toContain('Токио')
    expect(list[1]!.find('.tz-picker__check').exists()).toBe(false)
    wrapper.unmount()
  })

  it('cities sharing the selected zone float together (the check is per-iana)', () => {
    const wrapper = mountPicker('Europe/Moscow')
    const list = wrapper.findAll('.tz-picker__row')
    expect(list[0]!.text()).toContain('Москва')
    expect(list[1]!.text()).toContain('Санкт-Петербург')
    expect(list[0]!.classes()).toContain('tz-picker__row--active')
    expect(list[1]!.classes()).toContain('tz-picker__row--active')
    wrapper.unmount()
  })

  it('no selection leaves the list order untouched', () => {
    const wrapper = mountPicker()
    expect(wrapper.findAll('.tz-picker__row')[0]!.text()).toContain('Москва')
    wrapper.unmount()
  })

  it('search still filters, and a selected match leads its results', async () => {
    const wrapper = mountPicker('Europe/Moscow')
    await wrapper.find('input').setValue('моск')
    const list = wrapper.findAll('.tz-picker__row')
    expect(list[0]!.text()).toContain('Москва')
    expect(list[0]!.classes()).toContain('tz-picker__row--active')
    wrapper.unmount()
  })
})

describe('TimezoneCityPicker -- keyboard navigation (combobox)', () => {
  function key(wrapper: ReturnType<typeof mountPicker>, k: string) {
    return wrapper.find('input').trigger('keydown', { key: k })
  }

  it('ArrowDown highlights the first row and points aria-activedescendant at it', async () => {
    const wrapper = mountPicker()
    await key(wrapper, 'ArrowDown')
    const input = wrapper.find('input')
    const rows = wrapper.findAll('[role="option"]')
    expect(rows[0]!.classes()).toContain('velo-listbox-active')
    expect(input.attributes('aria-activedescendant')).toBe(rows[0]!.attributes('id'))
    expect(input.attributes('role')).toBe('combobox')
    expect(wrapper.find('[role="listbox"]').attributes('id')).toBe(
      input.attributes('aria-controls'),
    )
    wrapper.unmount()
  })

  it('ArrowUp from nothing wraps to the last row', async () => {
    const wrapper = mountPicker()
    await key(wrapper, 'ArrowUp')
    const rows = wrapper.findAll('[role="option"]')
    expect(rows[rows.length - 1]!.classes()).toContain('velo-listbox-active')
    wrapper.unmount()
  })

  it('Enter picks the highlighted row', async () => {
    const wrapper = mountPicker('')
    await key(wrapper, 'ArrowDown')
    await key(wrapper, 'ArrowDown')
    await key(wrapper, 'Enter')
    // The row the user sees as highlighted is the one that gets picked.
    const highlighted = wrapper.find('[role="option"].velo-listbox-active')
    const expected = highlighted.find('.tz-picker__zone').text()
    expect(expected).toBe(CURATED_CITIES[1]!.iana)
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([expected])
    wrapper.unmount()
  })

  it('ArrowDown from the last row wraps to the first', async () => {
    const wrapper = mountPicker()
    await key(wrapper, 'ArrowUp')
    await key(wrapper, 'ArrowDown')
    const rows = wrapper.findAll('[role="option"]')
    expect(rows[0]!.classes()).toContain('velo-listbox-active')
    expect(wrapper.findAll('.velo-listbox-active')).toHaveLength(1)
    wrapper.unmount()
  })

  it('aria-selected marks the saved zone only', () => {
    const wrapper = mountPicker('Asia/Tokyo')
    const selected = wrapper.findAll('[role="option"][aria-selected="true"]')
    expect(selected).toHaveLength(1)
    expect(selected[0]!.find('.tz-picker__zone').text()).toBe('Asia/Tokyo')
    wrapper.unmount()
  })

  it('Enter with nothing highlighted selects nothing', async () => {
    const wrapper = mountPicker()
    await key(wrapper, 'Enter')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('typing clears the highlight', async () => {
    const wrapper = mountPicker()
    await key(wrapper, 'ArrowDown')
    await wrapper.find('input').setValue('моск')
    expect(wrapper.find('input').attributes('aria-activedescendant')).toBeUndefined()
    expect(wrapper.find('.velo-listbox-active').exists()).toBe(false)
    wrapper.unmount()
  })
})
