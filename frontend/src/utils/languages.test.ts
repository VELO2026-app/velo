import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@/locales/ru/languages.json?raw')
  vi.resetModules()
})

describe('LANGUAGES', () => {
  it('lists the two practice languages from the seed as endonyms', async () => {
    const { LANGUAGES } = await import('./languages')
    expect(LANGUAGES).toEqual(['Русский', 'English'])
  })

  it('fails loudly when the seed lists fewer than two languages', async () => {
    vi.resetModules()
    vi.doMock('@/locales/ru/languages.json?raw', () => ({
      default: JSON.stringify({ languages: { list: ['Only one'] } }),
    }))
    await expect(import('./languages')).rejects.toThrow('at least two languages')
  })
})
