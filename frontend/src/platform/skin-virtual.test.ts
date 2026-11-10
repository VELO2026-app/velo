// =============================================================================
// VELO Frontend -- skin virtual modules tests (FE-157 s5/B)
// =============================================================================
// The plugin serves the token cascade and the brand text from memory: the
// golden build and a skin build must yield different content, and only for
// its own ids.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GOLDEN_SKIN } from './skin'
import { SKIN_BRAND_ID, SKIN_TOKENS_ID, skinVirtualModules } from './skin-virtual'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake public/ dir holding a skin package with the given tokens. */
function publicWithTokens(tokens: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'velo-skin-virtual-'))
  created.push(dir)
  mkdirSync(join(dir, 'skin'), { recursive: true })
  writeFileSync(join(dir, 'skin', 'tokens.css'), tokens)
  return dir
}

/** Resolve + load an id through the plugin hooks (no bundler needed). */
function serve(plugin: ReturnType<typeof skinVirtualModules>, id: string): string | null {
  const resolveId = plugin.resolveId as (id: string) => string | null
  const load = plugin.load as (id: string) => string | null
  const resolved = resolveId(id)
  return resolved === null ? null : load(resolved)
}

describe('skinVirtualModules', () => {
  it('golden build: empty token stub and a null brand', () => {
    const plugin = skinVirtualModules('/nonexistent', null)
    expect(serve(plugin, SKIN_TOKENS_ID)).toContain('cascade stub')
    expect(serve(plugin, SKIN_TOKENS_ID)).not.toContain(':root {')
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_BRAND = null')
  })

  it('skin build: the skin tokens and its display name', () => {
    const dir = publicWithTokens('--velo-accent: #123456;')
    const plugin = skinVirtualModules(dir, { ...GOLDEN_SKIN, displayName: 'Yoga | {Life}' })
    expect(serve(plugin, SKIN_TOKENS_ID)).toContain('--velo-accent: #123456;')
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_BRAND = "Yoga | {Life}"')
  })

  it('leaves foreign ids alone', () => {
    const plugin = skinVirtualModules('/nonexistent', null)
    expect(serve(plugin, './other.css')).toBeNull()
    const load = plugin.load as (id: string) => string | null
    expect(load('/src/app.ts')).toBeNull()
  })
})
