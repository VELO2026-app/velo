// =============================================================================
// VELO Frontend -- TimezoneCityPicker: one zone, two spellings (BE-157)
// =============================================================================
// The backend stores the canonical IANA name ("Asia/Kathmandu"); V8 lists the
// old one ("Asia/Katmandu") and the generated rows carry it. The saved zone
// must still light up its row, and a curated canonical row must not get a
// second, engine-spelled twin.
//
// The engine's zone LIST is replaced by a fixed one before the module loads,
// so the result does not depend on the Node / ICU version running the suite.
// Comparing spellings still goes through the real Intl -- every engine that
// knows both spellings maps them to one id, whichever id that is.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

const ENGINE_LIST = ['Asia/Katmandu', 'Europe/Kiev', 'Asia/Tokyo', 'Etc/UTC']

let Picker: Component
let TIMEZONE_CITIES: { city: string; iana: string }[]
let sameZone: (a: string, b: string) => boolean

beforeAll(async () => {
  vi.spyOn(Intl as unknown as { supportedValuesOf: () => string[] }, 'supportedValuesOf')
    .mockReturnValue(ENGINE_LIST)
  vi.resetModules()
  ;({ TIMEZONE_CITIES, sameZone } = await import('@/utils/timezoneCities'))
  Picker = (await import('./TimezoneCityPicker.vue')).default
})

afterAll(() => {
  vi.restoreAllMocks()
})

function mountPicker(modelValue = '') {
  return mount(Picker, { props: { modelValue } })
}

describe('sameZone', () => {
  it('matches the two spellings of one zone, either way round', () => {
    expect(sameZone('Asia/Kathmandu', 'Asia/Katmandu')).toBe(true)
    expect(sameZone('Europe/Kiev', 'Europe/Kyiv')).toBe(true)
  })

  it('keeps distinct zones apart, also the ones IANA merged', () => {
    expect(sameZone('Europe/Amsterdam', 'Europe/Brussels')).toBe(false)
    expect(sameZone('Asia/Tokyo', 'Asia/Kathmandu')).toBe(false)
  })

  it('a zone the engine does not know matches only itself, and never throws', () => {
    expect(sameZone('Mars/Base', 'Mars/Base')).toBe(true)
    expect(sameZone('Mars/Base', 'UTC')).toBe(false)
    expect(sameZone('', 'UTC')).toBe(false)
  })
})

describe('TimezoneCityPicker -- the saved zone in either spelling', () => {
  it('the saved canonical name lights up the engine-spelled row and leads the list', () => {
    const wrapper = mountPicker('Asia/Kathmandu')
    const rows = wrapper.findAll('.tz-picker__row')
    expect(rows[0]!.find('.tz-picker__zone').text()).toBe('Asia/Katmandu')
    expect(rows[0]!.classes()).toContain('tz-picker__row--active')
    expect(rows[0]!.find('.tz-picker__check').exists()).toBe(true)
    expect(wrapper.findAll('.tz-picker__row--active')).toHaveLength(1)
    wrapper.unmount()
  })

  it('a curated canonical zone gets no engine-spelled twin (Киев, not Kiev)', () => {
    const zones = TIMEZONE_CITIES.map((c) => c.iana)
    expect(zones).toContain('Europe/Kyiv')
    expect(zones).not.toContain('Europe/Kiev')
    // the engine's other zones are still generated (Katmandu is not curated)
    expect(zones).toContain('Asia/Katmandu')
  })

  it('the list really comes from the replaced engine list (guard of this file)', () => {
    // America/Halifax is in every real engine list and in no curated row:
    // were the replacement not in effect, it would be generated here.
    expect(TIMEZONE_CITIES.map((c) => c.iana)).not.toContain('America/Halifax')
    expect(Intl.supportedValuesOf('timeZone')).toEqual(ENGINE_LIST)
  })

  it('a saved zone with one row lights up exactly that row', () => {
    const wrapper = mountPicker('Europe/Kyiv')
    const active = wrapper.findAll('.tz-picker__row--active')
    expect(active).toHaveLength(1)
    expect(active[0]!.text()).toContain('Киев')
    wrapper.unmount()
  })

  it('tapping the engine-spelled row emits that row value as-is', async () => {
    const wrapper = mountPicker('UTC')
    await wrapper.find('input').setValue('katmandu')
    await wrapper.find('.tz-picker__row').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['Asia/Katmandu']])
    wrapper.unmount()
  })

  it('a saved zone the engine does not know renders the full list with no active row', () => {
    const wrapper = mountPicker('Mars/Base')
    expect(wrapper.findAll('.tz-picker__row')).toHaveLength(TIMEZONE_CITIES.length)
    expect(wrapper.findAll('.tz-picker__row--active')).toHaveLength(0)
    wrapper.unmount()
  })

  it('no saved zone lights up nothing', () => {
    const wrapper = mountPicker('')
    expect(wrapper.findAll('.tz-picker__row').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.tz-picker__row--active')).toHaveLength(0)
    wrapper.unmount()
  })
})
