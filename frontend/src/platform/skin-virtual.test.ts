// =============================================================================
// VELO Frontend -- skin virtual modules tests (FE-157 s5/B)
// =============================================================================
// The plugin serves the token cascade and the brand text from memory: the
// golden build and a skin build must yield different content, and only for
// its own ids.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CORE_SKIN, readSkin } from './skin'
import { SKIN_BRAND_ID, SKIN_MOOD_ID, SKIN_TOKENS_ID, skinVirtualModules } from './skin-virtual'
import { FIXTURE_TOKENS, writeSkinPackage } from './skin.test.fixture'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake frontend/public dir whose skin/ holds a DTCG package (FE-131)
 *  with the given velo.* tokens over the fixture's; the reader anchors tokens.json at public/..,
 *  so the real one is copied beside it. */
function publicWithTokens(tokens: Record<string, unknown>): string {
  const frontend = mkdtempSync(join(tmpdir(), 'velo-skin-virtual-'))
  created.push(frontend)
  copyFileSync(join(process.cwd(), 'tokens.json'), join(frontend, 'tokens.json'))
  const publicDir = join(frontend, 'public')
  mkdirSync(publicDir)
  writeSkinPackage(
    { tokens: { ...FIXTURE_TOKENS, velo: { ...FIXTURE_TOKENS.velo, ...tokens } } },
    join(publicDir, 'skin'),
  )
  return publicDir
}

/** Resolve + load an id through the plugin hooks (no bundler needed). */
function serve(plugin: ReturnType<typeof skinVirtualModules>, id: string): string | null {
  const resolveId = plugin.resolveId as (id: string) => string | null
  const load = plugin.load as (id: string) => string | null
  const resolved = resolveId(id)
  return resolved === null ? null : load(resolved)
}

describe('skinVirtualModules', () => {
  it('core build: empty token stub and the core name (FE-231)', () => {
    const plugin = skinVirtualModules('/nonexistent', null)
    expect(serve(plugin, SKIN_TOKENS_ID)).toContain('cascade stub')
    expect(serve(plugin, SKIN_TOKENS_ID)).not.toContain(':root {')
    expect(serve(plugin, SKIN_BRAND_ID)).toContain(
      `SKIN_BRAND = ${JSON.stringify(CORE_SKIN.displayName)}`,
    )
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_SUPPORT_EMAIL = null')
    // FE-261: the support mark defaults to the logo set.
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_SUPPORT_MARK = "logo"')
  })

  it('skin build: the skin tokens, its display name and support address', () => {
    const dir = publicWithTokens({ primary: { $value: '#123456' } })
    const skin = readSkin(dir)
    if (skin === null) throw new Error('the fixture skin did not load')
    const plugin = skinVirtualModules(dir, {
      ...skin,
      displayName: 'Yoga | {Life}',
      supportEmail: 'help@yoga.example',
    })
    expect(serve(plugin, SKIN_TOKENS_ID)).toContain('--velo-primary: #123456;')
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_BRAND = "Yoga | {Life}"')
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_SUPPORT_EMAIL = "help@yoga.example"')
  })

  it("skin build: the brand record's supportMark reaches the brand module (FE-261)", () => {
    const dir = publicWithTokens({ primary: { $value: '#123456' } })
    const skin = readSkin(dir)
    if (skin === null) throw new Error('the fixture skin did not load')
    const plugin = skinVirtualModules(dir, { ...skin, supportMark: 'icon' })
    expect(serve(plugin, SKIN_BRAND_ID)).toContain('SKIN_SUPPORT_MARK = "icon"')
  })

  it('core build and a package without the set: no mood icons -- the core faces draw (FE-273)', () => {
    expect(serve(skinVirtualModules('/nonexistent', null), SKIN_MOOD_ID)).toBe(
      'export const SKIN_MOOD_ICONS = null\n',
    )
    const dir = publicWithTokens({ primary: { $value: '#123456' } })
    const skin = readSkin(dir)
    if (skin === null) throw new Error('the fixture skin did not load')
    expect(serve(skinVirtualModules(dir, skin), SKIN_MOOD_ID)).toBe(
      'export const SKIN_MOOD_ICONS = null\n',
    )
  })

  it("skin build with the set: the module carries the package's five trees (FE-273)", () => {
    const dir = publicWithTokens({ primary: { $value: '#123456' } })
    const skin = readSkin(dir)
    if (skin === null) throw new Error('the fixture skin did not load')
    const tree = {
      tag: 'svg',
      attrs: { viewBox: '0 0 8 8' },
      children: [{ tag: 'path', attrs: { d: 'M0 0h1v1z' } }],
    }
    const moodIcons = { bad: tree, low: tree, neutral: tree, good: tree, fire: tree }
    const source = serve(skinVirtualModules(dir, { ...skin, moodIcons }), SKIN_MOOD_ID) ?? ''
    expect(source).toBe(`export const SKIN_MOOD_ICONS = ${JSON.stringify(moodIcons)}\n`)
  })

  it('leaves foreign ids alone', () => {
    const plugin = skinVirtualModules('/nonexistent', null)
    expect(serve(plugin, './other.css')).toBeNull()
    const load = plugin.load as (id: string) => string | null
    expect(load('/src/app.ts')).toBeNull()
  })
})
