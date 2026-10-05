// =============================================================================
// VELO Frontend -- TimezoneCityPicker unit tests
// =============================================================================
// Owner ruling: the SELECTED zone leads the list (the current choice must be
// visible without scrolling). Rows sharing the selected IANA float together
// (the check is per-iana), the rest keep the curated/generated order, and
// search still filters with a selected match leading its results.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Picker from './TimezoneCityPicker.vue'
import { TIMEZONE_CITIES } from '@/utils/timezoneCities'

function mountPicker(modelValue = '') {
  return mount(Picker, { props: { modelValue } })
}

describe('TimezoneCityPicker -- the selected zone leads the list', () => {
  it('a deep-in-the-list selection becomes the first row, still checked', () => {
    const wrapper = mountPicker('Asia/Tokyo')
    const list = wrapper.findAll('.tz-picker__row')
    expect(list).toHaveLength(TIMEZONE_CITIES.length)
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
