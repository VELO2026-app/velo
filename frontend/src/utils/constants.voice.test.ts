// =============================================================================
// VELO Frontend -- constants (voice flags): voice input follows the `llm` option (FE-163)
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(async () => {
  const { applyInstanceConfig } = await import('@/platform/instance')
  applyInstanceConfig(null)
  vi.resetModules()
})

async function constantsWith(llm: string | null) {
  vi.resetModules()
  const { applyInstanceConfig } = await import('@/platform/instance')
  applyInstanceConfig(llm === null ? null : { options: { llm } })
  return import('@/utils/constants')
}

describe('voice input flags', () => {
  it('golden build (no options block): the mic is on', async () => {
    const c = await constantsWith(null)
    expect(c.COMPOSER_VOICE_INPUT).toBe(true)
    expect(c.TEXTAREA_VOICE_INPUT).toBe(true)
  })

  it('llm on: the mic is on', async () => {
    const c = await constantsWith('true')
    expect(c.COMPOSER_VOICE_INPUT).toBe(true)
    expect(c.TEXTAREA_VOICE_INPUT).toBe(true)
  })

  it('llm off: no mic in composers or fields', async () => {
    const c = await constantsWith('false')
    expect(c.COMPOSER_VOICE_INPUT).toBe(false)
    expect(c.TEXTAREA_VOICE_INPUT).toBe(false)
  })
})
