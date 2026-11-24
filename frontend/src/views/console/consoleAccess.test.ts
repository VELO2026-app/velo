import { describe, expect, it } from 'vitest'
import { consoleBlock } from '@/views/console/consoleAccess'

describe('consoleBlock', () => {
  it.each([
    ['telegram', true, 'telegram'],
    ['telegram', false, 'telegram'],
    ['standalone', false, 'narrow'],
    ['standalone', true, null],
  ] as const)('on %s with a wide window %s gives %s', (platformName, wide, expected) => {
    expect(consoleBlock(platformName, wide)).toBe(expected)
  })
})
