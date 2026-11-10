// =============================================================================
// VELO Frontend -- skin package validator (tz-whitelabel §3, F2; FE-131)
// =============================================================================
// A skin package (public/skin/) is checked BEFORE it is applied: a package
// that fails here must not ship. The package is the deploy machine's DTCG
// format (FE-131, tz-whitelabel §3.2) -- structure, manifest, token paths and
// the brand record are read by scripts/lib/skin-package.mjs, the SAME engine
// the build converts it with. On top of that, the contract §3 content checks
// (static only -- no rasterizer, no browser: "we test the contract, not every
// skin"):
//
//   structure    primer-package.yaml (schema 1, contract "1.x"), tokens/,
//                the mandatory assets/ set, nothing else (lib/skin-package)
//   brand        $extensions["velo-skin"]: display/short names (short <= 12),
//                6-digit hex colors, self-hosted fonts only
//   tokens       every token path is a token of tokens.json (a typo would
//                silently theme nothing); velo.* and bare.font-body only; the
//                single-source rule (§1): velo.tg.header == brand themeColor
//   contrast     WCAG ratios for the overridden text/background pairs
//                (4.5:1 body text; 3:1 for the Telegram header chrome, whose
//                text is white) -- thresholds per the variables.css comments
//   PNG          dimensions from IHDR; the apple-touch icon must have NO
//                alpha channel (iOS paints transparency black)
//   manual       maskable safe-zone (80%) needs pixel inspection -- reported
//                as MANUAL, owner's acceptance (tz-whitelabel §3: snapshots
//                are manual)
//
// Usage: node scripts/validate-skin.mjs [skinDir] [--build]  (default: public/skin)
// Exits 1 on any FAIL. --build is the `pnpm build` gate (FE-148): an absent
// package passes (golden build), a present one must pass in full (the slot
// of an apply:build package has no `validate:` -- contract 3 rule 31 -- so
// this gate inside the build IS the package check).
// validateSkin() and skinBuildGate() are exported for the unit suite.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ASSET_DIRS,
  loadSkinPackage,
  readGoldenTokens,
  goldenTokenMap,
} from './lib/skin-package.mjs'

const PNG_SIZES = {
  'icon-192.png': [192, 192],
  'icon-512.png': [512, 512],
  'icon-maskable-512.png': [512, 512],
  'apple-touch-icon-180.png': [180, 180],
}
/** Text/background pairs checked when the skin overrides either side. */
const CONTRAST_PAIRS = [
  ['--velo-text-primary', '--velo-bg-card-solid', 4.5],
  ['--velo-text-secondary', '--velo-bg-card-solid', 4.5],
  ['--velo-tg-header', '#ffffff', 3.0],
]

// -- tiny helpers ------------------------------------------------------------

function fail(out, message) {
  out.fails.push(message)
}
function warn(out, message) {
  out.warns.push(message)
}
function ok(out, message) {
  out.passed.push(message)
}

/** PNG IHDR facts (width/height/colorType); null when not a readable PNG.
 *  Exported for scripts/instance-checklist.mjs (dist icon dimension facts). */
export function pngInfo(file) {
  const buf = readFileSync(file)
  const signature = '89504e470d0a1a0a'
  if (buf.subarray(0, 8).toString('hex') !== signature) return null
  // First chunk must be IHDR: length(4) 'IHDR' width(4) height(4) ... colorType(offset 25).
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25], // 0 gray, 2 rgb, 3 palette, 4 gray+alpha, 6 rgba
  }
}

/** WCAG relative luminance with alpha composited over white. */
function luminance(color) {
  let value = color.trim()
  let alpha = 1
  // Anchored: the WHOLE value must be the color -- an rgb() nested inside
  // color-mix() or a var() fallback is not the value's color.
  const rgba = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/,
  )
  if (rgba) {
    alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
    return { lum: channelLum([+rgba[1], +rgba[2], +rgba[3]], alpha), alpha }
  }
  const hex = value.match(/^#([0-9a-fA-F]{6})$/)
  if (!hex) return null
  const int = parseInt(hex[1], 16)
  return {
    lum: channelLum([(int >> 16) & 255, (int >> 8) & 255, int & 255], alpha),
    alpha,
  }
}
/** sRGB channel (0-255) -> linear luminance component, alpha-composited on
 * white (a translucent token sits on the app's white card, not on void). */
function channelLum([r, g, b], alpha) {
  const lin = (c) => {
    const v = (c / 255) * alpha + (1 - alpha)
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  if (!la || !lb) return null
  const [hi, lo] = la.lum >= lb.lum ? [la.lum, lb.lum] : [lb.lum, la.lum]
  return (hi + 0.05) / (lo + 0.05)
}

// -- the check ---------------------------------------------------------------

/** Validates the skin package at `skinDir`. `frontendDir` anchors
 * tokens.json (the token names a skin may set, and the golden values the
 * contrast pairs resolve against). Returns the report; `fails.length === 0`
 * means the package may ship. */
export function validateSkin(skinDir, frontendDir) {
  const out = { fails: [], warns: [], manual: [], passed: [] }
  skinDir = resolve(skinDir)
  const assets = join(skinDir, 'assets')

  // 1-3. structure, manifest, brand record, token paths -- the engine ------------
  const goldenDoc = readGoldenTokens(frontendDir)
  const pkg = loadSkinPackage(skinDir, goldenDoc)
  for (const problem of pkg.problems) fail(out, `FAIL ${problem}`)
  if (out.fails.length > 0) return out
  const brand = pkg.brand
  ok(out, `primer-package.yaml: contract "${pkg.contract}"`)
  ok(out, `brand: "${brand.displayName}" / "${brand.shortName}"`)
  for (const dir of ASSET_DIRS) {
    const count = pkg.files.filter((f) => f.startsWith(`assets/${dir}/`)).length
    if (count > 0) ok(out, `optional dir present: assets/${dir}/ (${count} file(s))`)
  }
  const tokens = Object.fromEntries(pkg.decls)
  const tokenNames = Object.keys(tokens)
  if (tokenNames.length === 0) warn(out, 'the package sets no tokens')
  else ok(out, `tokens: ${tokenNames.length} override(s), all known to tokens.json`)

  for (const family of new Set(brand.fonts.map((f) => f.family)))
    ok(out, `font: --font-body carries the self-hosted family "${family}"`)
  if (tokens['--velo-tg-header'] !== undefined) {
    const declared = tokens['--velo-tg-header'].toLowerCase()
    const brandColor = brand.themeColor.toLowerCase()
    if (declared !== brandColor) {
      fail(
        out,
        `FAIL §1 single source: velo.tg.header (${declared}) != brand themeColor (${brandColor})`,
      )
    } else ok(out, '§1 single source: velo.tg.header == brand themeColor')
  } else {
    warn(
      out,
      'the package does not override velo.tg.header: the Telegram header stays the golden #334d6e',
    )
    if (brand.themeColor.toLowerCase() !== '#334d6e') {
      // The HTML meta and the manifest WILL carry themeColor (materialized),
      // so a mismatched native header is almost certainly unintended.
      fail(
        out,
        'FAIL §1 single source: themeColor != #334d6e but the package never overrides velo.tg.header -- the Telegram header would stay VELO-colored',
      )
    }
  }

  // 4. contrast ---------------------------------------------------------------
  // Values resolve against the GOLDEN tokens: a skin that darkens a surface
  // without retouching the text on it fails right here.
  const baseTokens = Object.fromEntries(
    [...goldenTokenMap(goldenDoc).values()].map((t) => [t.cssName, t.value]),
  )
  // A value may be a reference (var(--x), from a DTCG {ref}) -- follow it
  // through the package's overrides, then the golden tokens, so a reference
  // cannot dodge the gate.
  const resolveToken = (name) => {
    let value = tokens[name] ?? baseTokens[name]
    for (let hop = 0; value !== undefined && hop < 16; hop++) {
      // var(--x) and var(--x, fallback): the defined --x wins, the
      // fallback is never the value of a known token.
      const ref = value.trim().match(/^var\(\s*(--[A-Za-z0-9-]+)\s*(,[\s\S]*)?\)$/)
      if (!ref) break
      value = tokens[ref[1]] ?? baseTokens[ref[1]]
    }
    return value
  }
  for (const [fgName, bgName, min] of CONTRAST_PAIRS) {
    const fg = resolveToken(fgName)
    const bg = bgName.startsWith('--') ? resolveToken(bgName) : bgName
    if (tokens[fgName] === undefined && tokens[bgName] === undefined && !bgName.startsWith('#'))
      continue // nothing overridden -- the golden pair is already accepted
    const ratio = fg === undefined || bg === undefined ? null : contrast(fg, bg)
    if (ratio === null) {
      // An overridden pair the gate cannot evaluate is refused, not waved
      // through: the contrast promise of the contract holds for every skin.
      fail(
        out,
        `FAIL contrast: cannot evaluate ${fgName} on ${bgName} (${fg} on ${bg}) -- give the pair plain hex/rgb() colors`,
      )
      continue
    }
    if (ratio < min)
      fail(out, `FAIL contrast: ${fgName} on ${bgName} is ${ratio.toFixed(2)}:1 < ${min}:1`)
    else ok(out, `contrast: ${fgName} on ${bgName} ${ratio.toFixed(2)}:1 >= ${min}:1`)
  }
  // The background photo is the one optional asset that can quietly break a
  // theme: it is the app's bottom layer, and the GOLDEN one is light. A skin
  // that flips --velo-text-primary to a light color while shipping no
  // bg/background.png paints light text over the light photo -- unreadable
  // (the velo_test_front_bot incident). Light-on-light skins may omit it.
  if (!existsSync(join(assets, 'bg', 'background.png'))) {
    const textPrimary = luminance(resolveToken('--velo-text-primary') ?? '')
    if (tokens['--velo-text-primary'] !== undefined && !textPrimary) {
      fail(
        out,
        'FAIL assets/bg/background.png: missing and --velo-text-primary cannot be evaluated -- ship assets/bg/ or give the text a plain color',
      )
    } else if (textPrimary && textPrimary.lum > 0.35) {
      fail(
        out,
        'FAIL assets/bg/background.png: missing while --velo-text-primary is LIGHT -- the golden light photo stays and the light text on it is unreadable. Ship the full package including assets/bg/, or use dark text tokens.',
      )
    } else {
      warn(out, 'assets/bg/background.png missing: the golden light photo stays (fine for a light-on-light skin)')
    }
  } else ok(out, 'assets/bg/background.png present')
  // The manifest/HTML background: themeColor text on backgroundColor surface.
  const splash = contrast(brand.themeColor, brand.backgroundColor)
  if (splash !== null && splash < 3)
    warn(
      out,
      `contrast: themeColor on backgroundColor is ${splash.toFixed(2)}:1 -- check the Android splash reads`,
    )

  // 5. PNG dimensions + apple-touch opacity -----------------------------------
  for (const [asset, [w, h]] of Object.entries(PNG_SIZES)) {
    const info = pngInfo(join(assets, asset))
    if (!info) {
      fail(out, `FAIL assets/${asset}: not a readable PNG (bad signature/IHDR)`)
      continue
    }
    if (info.width !== w || info.height !== h)
      fail(out, `FAIL assets/${asset}: ${info.width}x${info.height}, expected ${w}x${h}`)
    else ok(out, `${asset}: ${info.width}x${info.height}`)
    if (asset.startsWith('apple-touch') && (info.colorType === 4 || info.colorType === 6))
      fail(out, `FAIL assets/${asset}: has an alpha channel (colorType ${info.colorType}) -- iOS paints transparency black`)
  }
  for (const asset of ['favicon.svg', 'velo-word-filled.svg', 'velo-word-blue.svg']) {
    const head = readFileSync(join(assets, asset), 'utf8').slice(0, 200)
    if (!/<svg|<\?xml/.test(head)) fail(out, `FAIL assets/${asset}: does not look like an SVG`)
  }

  // 6. manual items -----------------------------------------------------------
  out.manual.push(
    'MANUAL assets/icon-maskable-512.png: the 80% safe zone needs pixel inspection (no rasterizer in this validator)',
  )
  out.manual.push(
    'MANUAL screens: the skin is pixel-checked against the reference snapshots (tz-whitelabel §3)',
  )
  return out
}

// -- build gate -----------------------------------------------------------------

/** The build-time gate (FE-148): an invalid skin package fails the build.
 * No `skinDir` at all = the golden build, nothing to check (returns null).
 * A PRESENT directory is validated in full -- including one without
 * primer-package.yaml, which the build itself would silently treat as "no
 * skin" (`readSkin` keys on the manifest), so a half-delivered package can
 * never pass as golden. */
export function skinBuildGate(skinDir, frontendDir) {
  if (!existsSync(resolve(skinDir))) return null
  return validateSkin(skinDir, frontendDir)
}

// -- CLI ----------------------------------------------------------------------
// --build: the gate mode of `pnpm build` -- an absent public/skin passes.

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const buildMode = args.includes('--build')
  const skinDir = args.find((a) => !a.startsWith('--')) ?? 'public/skin'
  const frontendDir = resolve(import.meta.dirname, '..')
  const report = buildMode ? skinBuildGate(skinDir, frontendDir) : validateSkin(skinDir, frontendDir)
  if (report === null) {
    console.log(`validate-skin: no skin package at ${skinDir} -- golden build`)
    process.exit(0)
  }
  for (const line of [...report.fails, ...report.warns, ...report.manual, ...report.passed])
    console.log(line)
  console.log(
    `\nvalidate-skin: ${report.fails.length} fail(s), ${report.warns.length} warn(s), ${report.passed.length} check(s) passed`,
  )
  process.exit(report.fails.length > 0 ? 1 : 0)
}
