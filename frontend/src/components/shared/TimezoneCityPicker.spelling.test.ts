// =============================================================================
// VELO Frontend -- TimezoneCityPicker: rows from the backend catalog (BE-157)
// =============================================================================
// The backend stores ONE spelling of a zone ("Asia/Kathmandu"); engines differ:
// V8 lists and resolves "Asia/Katmandu", JavaScriptCore returns a name AS
// GIVEN. The owner's Telegram Desktop on macOS (WKWebView) combined an old
// list with as-given names, so a picker comparing through Intl missed the
// saved zone there while every V8-based test stayed green.
//
// This file runs the picker under exactly that engine: Intl.DateTimeFormat
// reports the zone as given and Intl.supportedValuesOf returns old spellings
// -- the guard below proves the replacement is in effect, so the picker's
// result here cannot come from Node's own V8. Rows must come from the mocked
// backend catalog, matched with ===, searchable by every accepted spelling and
// by the Russian CLDR names; the saved zone is a row even without a catalog.
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Component } from 'vue'

const api = vi.hoisted(() => ({ getTimezoneCatalog: vi.fn() }))
vi.mock('@/api/users', () => api)

const OLD_LIST = ['Asia/Katmandu', 'Europe/Kiev', 'Asia/Calcutta', 'America/Halifax']

const CATALOG = {
  names: [
    'America/Halifax',
    'Asia/Kathmandu',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Etc/GMT+5',
    'Europe/Amsterdam',
    'Europe/Kyiv',
    'UTC',
  ],
  aliases: {
    'Asia/Calcutta': 'Asia/Kolkata',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'Europe/Kiev': 'Europe/Kyiv',
  },
  labels: {
    'America/Halifax': { city_ru: 'Галифакс', country_ru: 'Канада' },
    'Asia/Kathmandu': { city_ru: 'Катманду', country_ru: 'Непал' },
    'Europe/Kyiv': { city_ru: 'Киев', country_ru: 'Украина' },
  },
}

// -- An engine like the owner's WKWebView ------------------------------------
const RealDateTimeFormat = Intl.DateTimeFormat
const realSupportedValuesOf = (Intl as unknown as { supportedValuesOf: unknown }).supportedValuesOf

function AsGivenDateTimeFormat(
  locales?: string | string[],
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const inner = new RealDateTimeFormat(locales, options)
  const given = options?.timeZone
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'resolvedOptions') {
        return () => ({ ...target.resolvedOptions(), ...(given ? { timeZone: given } : {}) })
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

beforeAll(() => {
  Object.defineProperty(Intl, 'DateTimeFormat', {
    value: AsGivenDateTimeFormat,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(Intl, 'supportedValuesOf', {
    value: () => OLD_LIST,
    configurable: true,
    writable: true,
  })
})

afterAll(() => {
  Object.defineProperty(Intl, 'DateTimeFormat', {
    value: RealDateTimeFormat,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(Intl, 'supportedValuesOf', {
    value: realSupportedValuesOf,
    configurable: true,
    writable: true,
  })
})

// -- Fresh module state per test (the catalog is cached per module) ----------
let Picker: Component
let CURATED_COUNT: number

beforeEach(async () => {
  api.getTimezoneCatalog.mockReset()
  api.getTimezoneCatalog.mockResolvedValue(CATALOG)
  vi.resetModules()
  Picker = (await import('./TimezoneCityPicker.vue')).default
  CURATED_COUNT = (await import('@/utils/timezoneCities')).CURATED_CITIES.length
})

async function mountPicker(modelValue = '') {
  const wrapper = mount(Picker, { props: { modelValue } })
  await flushPromises()
  return wrapper
}

function zones(wrapper: Awaited<ReturnType<typeof mountPicker>>): string[] {
  return wrapper.findAll('.tz-picker__zone').map((z) => z.text())
}

describe('the engine is replaced (guard of this file)', () => {
  it('names come back as given, and the zone list is the old one', () => {
    const resolved = (z: string) =>
      new Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions().timeZone
    expect(resolved('Asia/Kathmandu')).toBe('Asia/Kathmandu')
    expect(resolved('Asia/Katmandu')).toBe('Asia/Katmandu')
    expect(Intl.supportedValuesOf('timeZone')).toEqual(OLD_LIST)
  })
})

describe('TimezoneCityPicker -- rows from the backend catalog', () => {
  it('the saved canonical zone is the first row, checked, with its Russian caption', async () => {
    const wrapper = await mountPicker('Asia/Kathmandu')
    const first = wrapper.findAll('.tz-picker__row')[0]!
    expect(first.find('.tz-picker__zone').text()).toBe('Asia/Kathmandu')
    expect(first.find('.tz-picker__city').text()).toBe('Катманду')
    expect(first.classes()).toContain('tz-picker__row--active')
    expect(first.find('.tz-picker__check').exists()).toBe(true)
    expect(wrapper.findAll('.tz-picker__row--active')).toHaveLength(1)
    wrapper.unmount()
  })

  it('no row carries an engine spelling', async () => {
    const wrapper = await mountPicker('Asia/Kathmandu')
    for (const old of OLD_LIST.filter((z) => z !== 'America/Halifax')) {
      expect(zones(wrapper)).not.toContain(old)
    }
    wrapper.unmount()
  })

  it.each(['katmandu', 'катманду', 'непал', 'Kathmandu'])(
    'search «%s» finds Asia/Kathmandu',
    async (query) => {
      const wrapper = await mountPicker('UTC')
      await wrapper.find('input').setValue(query)
      expect(zones(wrapper)).toContain('Asia/Kathmandu')
      wrapper.unmount()
    },
  )

  it.each(['киев', 'kiev', 'kyiv', 'украина'])(
    'search «%s» gives one row, «Киев»',
    async (query) => {
      const wrapper = await mountPicker()
      await wrapper.find('input').setValue(query)
      const rows = wrapper.findAll('.tz-picker__row')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.find('.tz-picker__city').text()).toBe('Киев')
      expect(rows[0]!.find('.tz-picker__zone').text()).toBe('Europe/Kyiv')
      wrapper.unmount()
    },
  )

  it('tapping the found row emits the name the backend stores', async () => {
    const wrapper = await mountPicker('UTC')
    await wrapper.find('input').setValue('катманду')
    await wrapper.find('.tz-picker__row').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['Asia/Kathmandu']])
    wrapper.unmount()
  })

  it('Etc/* and UTC of the catalog are not rows; the rest are', async () => {
    const wrapper = await mountPicker()
    expect(zones(wrapper)).not.toContain('Etc/GMT+5')
    expect(zones(wrapper)).not.toContain('UTC')
    expect(zones(wrapper)).toContain('America/Halifax')
    wrapper.unmount()
  })

  it('a query with no match says «Город не найден»', async () => {
    const wrapper = await mountPicker()
    await wrapper.find('input').setValue('zzzz-no-such-city')
    expect(wrapper.find('.tz-picker__empty').text()).toBe('Город не найден, уточните написание.')
    wrapper.unmount()
  })
})

describe('TimezoneCityPicker -- the saved zone without a catalog', () => {
  async function expectSavedRowFirst(state: string) {
    const wrapper = await mountPicker('Asia/Kathmandu')
    const rows = wrapper.findAll('.tz-picker__row')
    expect(rows, state).toHaveLength(CURATED_COUNT + 1)
    expect(rows[0]!.find('.tz-picker__zone').text()).toBe('Asia/Kathmandu')
    expect(rows[0]!.classes()).toContain('tz-picker__row--active')
    expect(rows[0]!.find('.tz-picker__check').exists()).toBe(true)
    wrapper.unmount()
  }

  it('the catalog failed to load: the saved zone is still the first row, checked', async () => {
    api.getTimezoneCatalog.mockRejectedValue(new Error('offline'))
    await expectSavedRowFirst('failed')
  })

  it('the catalog is still loading: same', async () => {
    api.getTimezoneCatalog.mockReturnValue(new Promise(() => {}))
    await expectSavedRowFirst('loading')
  })

  it('a malformed catalog counts as a failed load', async () => {
    api.getTimezoneCatalog.mockResolvedValue(undefined)
    await expectSavedRowFirst('malformed')
  })
})

describe('TimezoneCityPicker -- one request per session', () => {
  it('two pickers share one request', async () => {
    const a = await mountPicker()
    const b = await mountPicker()
    expect(api.getTimezoneCatalog).toHaveBeenCalledTimes(1)
    a.unmount()
    b.unmount()
  })

  it('a failed load is tried again on the next mount', async () => {
    api.getTimezoneCatalog.mockRejectedValueOnce(new Error('offline'))
    const a = await mountPicker()
    a.unmount()
    const b = await mountPicker('Asia/Kathmandu')
    expect(api.getTimezoneCatalog).toHaveBeenCalledTimes(2)
    expect(b.find('.tz-picker__city').text()).toBe('Катманду')
    b.unmount()
  })
})
