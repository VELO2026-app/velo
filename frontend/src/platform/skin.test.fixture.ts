// =============================================================================
// VELO Frontend -- skin package fixtures for the unit suite (FE-131)
// =============================================================================
// Writes a complete, minimal skin package of the deploy machine's format
// (primer-package.yaml + tokens/*.tokens.json + assets/) into a temp dir.
// velo carries no skins (FE-131): the suites write their own packages. The validator reads PNG facts
// from IHDR only, so a signature + IHDR chunk is a complete enough PNG.
// Test-only: imported by *.test.ts, never by the app.
// =============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

/** A fresh temp dir, removed by cleanupSkinFixtures().
 *  @internal */
export function tempDir(prefix = 'velo-skin-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** Removes every temp dir the fixtures made (call from afterEach).
 *  @internal */
export function cleanupSkinFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A PNG the validator can read: signature + an IHDR chunk. colorType 2 =
 *  RGB (no alpha), 6 = RGBA.
 *  @internal */
export function png(width: number, height: number, colorType = 2): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8 // bit depth
  ihdr[17] = colorType
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr])
}

/** The brand record of the default fixture (a light skin with a font).
 *  @internal */
export const FIXTURE_BRAND = {
  displayName: 'Fixture School',
  shortName: 'Fixture',
  themeColor: '#1b2a41',
  backgroundColor: '#f5f1ea',
  fonts: [{ family: 'Rubik', file: 'assets/fonts/rubik-400.woff2', weight: 400 }],
}

/** The token document of the default fixture (DTCG, tokens.json paths).
 *  @internal */
export const FIXTURE_TOKENS = {
  velo: {
    primary: { $value: '#2c4a6e' },
    tg: { header: { $value: '#1b2a41' } },
  },
  bare: { 'font-body': { $type: 'fontFamily', $value: ['Rubik', 'Noto Sans', 'sans-serif'] } },
}

/** What a fixture package may change. @internal */
export interface FixturePatch {
  /** The `$extensions["velo-skin"]` record (default FIXTURE_BRAND). */
  brand?: object
  /** tokens/skin.tokens.json (default FIXTURE_TOKENS). */
  tokens?: object
  /** primer-package.yaml text. */
  manifest?: string
  /** Ship assets/bg/background.png. */
  bg?: boolean
  /** Extra files: package-relative path to content. */
  extra?: Record<string, string | Buffer>
}

/** Writes a complete, valid LIGHT skin package (dark text on the golden
 *  photo is fine, so no bg/ is needed) into `dir` (default: a fresh temp
 *  dir) and returns the directory.
 *  @internal */
export function writeSkinPackage(patch: FixturePatch = {}, dir?: string): string {
  const root = dir ?? tempDir()
  const put = (rel: string, content: string | Buffer): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  put('primer-package.yaml', patch.manifest ?? 'schema: 1\ncontract: "2.0"\n')
  put(
    'tokens/brand.tokens.json',
    JSON.stringify({ $extensions: { 'velo-skin': patch.brand ?? FIXTURE_BRAND } }),
  )
  put('tokens/skin.tokens.json', JSON.stringify(patch.tokens ?? FIXTURE_TOKENS))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  for (const name of ['velo-word-filled', 'velo-word-blue', 'logo-white', 'favicon'])
    put(`assets/${name}.svg`, svg)
  put('assets/mandala-white.png', png(64, 64, 6))
  put('assets/mandala-blue.png', png(64, 64, 6))
  put('assets/icon-192.png', png(192, 192, 6))
  put('assets/icon-512.png', png(512, 512, 6))
  put('assets/icon-maskable-512.png', png(512, 512, 6))
  put('assets/apple-touch-icon-180.png', png(180, 180, 2))
  put('assets/fonts/rubik-400.woff2', 'wOF2')
  if (patch.bg) put('assets/bg/background.png', png(1080, 1920))
  for (const [rel, content] of Object.entries(patch.extra ?? {})) put(rel, content)
  return root
}
