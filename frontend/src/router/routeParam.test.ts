import { describe, expect, it } from 'vitest'
import { routeParam } from './routeParam'

describe('routeParam', () => {
  it('returns the single string value of the param', () => {
    expect(routeParam({ name: 'practice-detail', params: { id: 'p-1' } }, 'id')).toBe('p-1')
  })

  it.each([
    ['is missing', {}],
    ['is empty', { id: '' }],
    ['is repeated', { id: ['a', 'b'] }],
  ])('throws, naming the param and the route, when the param %s', (_label, params) => {
    expect(() => routeParam({ name: 'practice-detail', params }, 'id')).toThrow(
      'Route param "id" of route "practice-detail"',
    )
  })
})
