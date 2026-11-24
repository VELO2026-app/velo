import { describe, expect, it } from 'vitest'
import { optionalRouteParam, routeParam } from './routeParam'

const NOT_A_SINGLE_VALUE: [string, Record<string, string | string[]>][] = [
  ['is missing', {}],
  ['is empty', { id: '' }],
  ['is repeated', { id: ['a', 'b'] }],
]

describe('optionalRouteParam', () => {
  it('returns the single string value of the param', () => {
    expect(optionalRouteParam({ name: 'practice-detail', params: { id: 'p-1' } }, 'id')).toBe('p-1')
  })

  it.each(NOT_A_SINGLE_VALUE)('returns null when the param %s', (_label, params) => {
    expect(optionalRouteParam({ name: 'practice-detail', params }, 'id')).toBeNull()
  })
})

describe('routeParam', () => {
  it('returns the single string value of the param', () => {
    expect(routeParam({ name: 'practice-detail', params: { id: 'p-1' } }, 'id')).toBe('p-1')
  })

  it.each(NOT_A_SINGLE_VALUE)(
    'throws, naming the param and the route, when the param %s',
    (_label, params) => {
      expect(() => routeParam({ name: 'practice-detail', params }, 'id')).toThrow(
        'Route param "id" of route "practice-detail" is missing or not a single value',
      )
    },
  )

  it('names only the param when the route has no name', () => {
    expect(() => routeParam({ name: undefined, params: {} }, 'id')).toThrow(
      'Route param "id" is missing or not a single value',
    )
  })
})
