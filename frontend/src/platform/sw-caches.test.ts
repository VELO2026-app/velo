// =============================================================================
// VELO Frontend -- platform/sw-caches.ts tests (FE-157 s2)
// =============================================================================

import { describe, expect, it, vi } from 'vitest'
import { dropLegacyCaches, LEGACY_CACHES } from '@/platform/sw-caches'

describe('dropLegacyCaches', () => {
  it('deletes every legacy runtime cache and nothing else', async () => {
    const del = vi.fn(async (_name: string) => true)
    await dropLegacyCaches({ delete: del } as unknown as CacheStorage)
    expect(del.mock.calls.map((c) => c[0])).toEqual([...LEGACY_CACHES])
    expect(LEGACY_CACHES).toContain('velo-runtime')
    expect(LEGACY_CACHES).not.toContain('velo-assets')
  })

  it('no Cache API (insecure context, old webview): a quiet no-op', async () => {
    await expect(dropLegacyCaches(undefined)).resolves.toBeUndefined()
  })

  it('a failing delete is swallowed', async () => {
    const del = vi.fn(async () => {
      throw new Error('quota')
    })
    await expect(
      dropLegacyCaches({ delete: del } as unknown as CacheStorage),
    ).resolves.toBeUndefined()
  })
})
