// FE-133 -- an instance overlay is cut to the shape of the catalogs it lands on.
import { describe, expect, it } from 'vitest'

import i18n, { applyInstanceOverrides, setLocale } from '@/locales'
import { conformOverlay, MAX_OVERLAY_DEPTH } from '@/locales/overlayShape'

const base = {
  common: { save: 'x', group: { a: 'b' } },
  dates: { shortMonths: ['a', 'b'] },
}

describe('conformOverlay', () => {
  it('keeps what fits, including a key the base does not have', () => {
    const overlay = { common: { save: 'Ok', fresh: 'new' }, dates: { shortMonths: ['c', 'd'] } }
    expect(conformOverlay(overlay, base)).toEqual(overlay)
  })

  it('drops a node of another kind: a lone string cannot replace a group', () => {
    expect(conformOverlay({ common: 'flat' }, base)).toEqual({})
    expect(conformOverlay({ common: { save: { x: 'y' } } }, base)).toEqual({ common: {} })
    expect(conformOverlay({ dates: { shortMonths: 'x' } }, base)).toEqual({ dates: {} })
  })

  it('drops a list of another length or with a non-message in it', () => {
    expect(conformOverlay({ dates: { shortMonths: ['c'] } }, base)).toEqual({ dates: {} })
    expect(conformOverlay({ dates: { shortMonths: ['c', { x: 1 }] } }, base)).toEqual({ dates: {} })
  })

  it('drops forbidden keys and the root brand, not a nested brand', () => {
    const raw = JSON.parse(
      '{"__proto__":{"x":"y"},"brand":"Goodo","common":{"constructor":"c","brand":"ok","save":"s"}}',
    ) as Record<string, unknown>
    expect(conformOverlay(raw, base)).toEqual({ common: { brand: 'ok', save: 's' } })
    expect(Object.getPrototypeOf(conformOverlay(raw, base))).toBe(Object.prototype)
  })

  it('cuts nodes deeper than the cap, however deep the input', () => {
    let deep: unknown = 'x'
    for (let i = 0; i < 5000; i++) deep = { k: deep }
    const out = conformOverlay({ top: deep } as Record<string, unknown>, {})
    let depth = 0
    for (
      let n: unknown = out;
      n && typeof n === 'object';
      n = (n as Record<string, unknown>).k ?? (n as Record<string, unknown>).top
    )
      depth++
    expect(depth).toBeLessThanOrEqual(MAX_OVERLAY_DEPTH + 1)
  })
})

describe('applyInstanceOverrides keeps the catalogs whole', () => {
  it('a group replaced by a string in an overlay does not erase the group', async () => {
    await setLocale('ru')
    const before = i18n.global.t('common.save')
    applyInstanceOverrides({ ru: { common: 'flat', brand: 'Evil' } })
    expect(i18n.global.t('common.save')).toBe(before)
    expect(i18n.global.t('brand')).not.toBe('Evil')
  })
})
