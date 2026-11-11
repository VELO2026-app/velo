// =============================================================================
// VELO Frontend -- perLocaleManifest writes into the RESOLVED outDir (FE-157)
// =============================================================================
// A build into another outDir (bundle-report --modules) must read and write
// that directory -- never frontend/dist, which may be missing (clean checkout)
// or hold an earlier build whose manifests must stay untouched.
// =============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MANIFEST_LOCALES } from './manifest'
import { perLocaleManifest } from './manifest-locales'

type Hook = (...args: unknown[]) => void

describe('perLocaleManifest', () => {
  it('derives the per-locale manifests in the resolved outDir, not frontend/dist', () => {
    const root = mkdtempSync(join(tmpdir(), 'velo-mf-'))
    const frontendDir = join(root, 'frontend')
    for (const locale of MANIFEST_LOCALES) {
      mkdirSync(join(frontendDir, 'src', 'locales', locale), { recursive: true })
      writeFileSync(
        join(frontendDir, 'src', 'locales', locale, 'common.json'),
        JSON.stringify({ common: { pwaDescription: `desc-${locale}` } }),
      )
    }
    const outDir = join(root, 'elsewhere')
    mkdirSync(outDir)
    writeFileSync(join(outDir, 'manifest.webmanifest'), JSON.stringify({ name: 'VELO' }))

    const plugin = perLocaleManifest(frontendDir)
    ;(plugin.configResolved as Hook)({ root: frontendDir, build: { outDir } })
    ;(plugin.closeBundle as unknown as { handler: Hook }).handler()

    for (const locale of MANIFEST_LOCALES) {
      const written = JSON.parse(
        readFileSync(join(outDir, `manifest.${locale}.webmanifest`), 'utf8'),
      ) as { description?: string }
      expect(written.description).toBe(`desc-${locale}`)
    }
    expect(existsSync(join(frontendDir, 'dist'))).toBe(false)
  })
})
