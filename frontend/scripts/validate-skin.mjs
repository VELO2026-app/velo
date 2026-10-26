// =============================================================================
// VELO Frontend -- skin package validator (tz-whitelabel §3, F2)
// =============================================================================
// A skin package (public/skin/) is checked BEFORE it is applied: a package
// that fails here must not ship. Static checks only -- no rasterizer, no
// browser (tz-whitelabel §3: «тестируем контракт, а не каждый скин»):
//
//   structure    brand.json + tokens.css + the mandatory asset set (§3 table)
//   brand.json   display/short names (short_name <= 12, the PWA convention),
//                6-digit hex colors, https fontUrl
//   tokens.css   every custom property is a KNOWN --velo-* token of
//                variables.css (a typo would silently theme nothing); the
//                single-source rule (§1): a tokens.css --velo-tg-header must
//                equal brand.json themeColor
//   contrast     WCAG ratios for the overridden text/background pairs
//                (4.5:1 body text; 3:1 for the Telegram header chrome, whose
//                text is white) -- thresholds per the variables.css comments
//   PNG          dimensions from IHDR; the apple-touch icon must have NO
//                alpha channel (iOS paints transparency black)
//   manual       maskable safe-zone (80%) needs pixel inspection -- reported
//                as MANUAL, owner's acceptance (tz-whitelabel §3: snapshots
//                are manual)
//
// Usage: node scripts/validate-skin.mjs [skinDir]   (default: public/skin)
// Exits 1 on any FAIL. validateSkin() is exported for the unit suite.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MANDATORY_ASSETS = [
  'mandala-white.png',
  'mandala-blue.png',
  'velo-word-filled.svg',
  'velo-word-blue.svg',
  'logo-white.svg',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon-180.png',
]
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

/** Strip block and line comments (line-wise is enough for token lines). */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The declared custom properties of a tokens.css: { name: value }. */
function parseTokens(css) {
  const tokens = {}
  for (const line of stripCssComments(css).split('\n')) {
    const m = line.match(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/)
    if (m) tokens[m[1]] = m[2].trim()
  }
  return tokens
}

function knownVeloTokens(frontendDir) {
  const css = readFileSync(join(frontendDir, 'src', 'styles', 'variables.css'), 'utf8')
  return new Set([...css.matchAll(/(--velo-[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))
}

function pngInfo(file) {
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
  const rgba = value.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/,
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
 * variables.css (token-name check). Returns the report; `fails.length === 0`
 * means the package may ship. */
export function validateSkin(skinDir, frontendDir) {
  const out = { fails: [], warns: [], manual: [], passed: [] }
  skinDir = resolve(skinDir)

  // 1. structure ------------------------------------------------------------
  const brandPath = join(skinDir, 'brand.json')
  const tokensPath = join(skinDir, 'tokens.css')
  if (!existsSync(brandPath)) fail(out, 'FAIL brand.json: missing')
  if (!existsSync(tokensPath)) fail(out, 'FAIL tokens.css: missing')
  for (const asset of MANDATORY_ASSETS) {
    if (!existsSync(join(skinDir, asset))) fail(out, `FAIL asset: missing ${asset}`)
    else ok(out, `asset present: ${asset}`)
  }
  const optional = ['bg', 'onboarding']
  for (const dir of optional) {
    const p = join(skinDir, dir)
    if (existsSync(p) && statSync(p).isDirectory()) {
      const count = readdirSync(p).length
      ok(out, `optional dir present: ${dir}/ (${count} file(s))`)
    }
  }
  if (out.fails.length > 0) return out

  // 2. brand.json ------------------------------------------------------------
  let brand
  try {
    brand = JSON.parse(readFileSync(brandPath, 'utf8'))
  } catch {
    fail(out, 'FAIL brand.json: not valid JSON')
    return out
  }
  const str = (key) => typeof brand[key] === 'string' && brand[key].trim() !== ''
  if (!str('displayName')) fail(out, 'FAIL brand.json: displayName must be a non-empty string')
  if (!str('shortName')) fail(out, 'FAIL brand.json: shortName must be a non-empty string')
  else if (brand['shortName'].trim().length > 12)
    fail(out, `FAIL brand.json: shortName "${brand['shortName']}" exceeds 12 chars (PWA convention)`)
  const hex6 = (key) => str(key) && /^#[0-9a-fA-F]{6}$/.test(brand[key].trim())
  if (!hex6('themeColor')) fail(out, 'FAIL brand.json: themeColor must be 6-digit hex')
  if (!hex6('backgroundColor')) fail(out, 'FAIL brand.json: backgroundColor must be 6-digit hex')
  if (brand['fontUrl'] !== undefined && !/^https:\/\//.test(String(brand['fontUrl'])))
    fail(out, 'FAIL brand.json: fontUrl must be https://')
  if (out.fails.length === 0) ok(out, `brand.json: "${brand['displayName']}" / "${brand['shortName']}"`)

  // 3. tokens.css: names + the §1 single source -------------------------------
  const tokens = parseTokens(readFileSync(tokensPath, 'utf8'))
  const tokenNames = Object.keys(tokens)
  if (tokenNames.length === 0) warn(out, 'tokens.css declares no custom properties')
  const known = knownVeloTokens(frontendDir)
  for (const name of tokenNames) {
    if (!name.startsWith('--velo-')) continue // bare tokens: judged by BARE_ALLOWED below
    if (!known.has(name))
      fail(out, `FAIL tokens.css: ${name} does not exist in variables.css (a typo themes nothing)`)
  }
  if (tokenNames.length > 0 && !tokenNames.some((n) => !n.startsWith('--')))
    ok(out, `tokens.css: ${tokenNames.length} token(s), all known --velo-*`)
  // The ONE bare token a skin may set: --font-body (the family swaps with the
  // brand.json fontUrl link -- tz-whitelabel §7 «подстановка ссылки и токена»;
  // every OTHER bare token stays golden, the frozen split owns them).
  const BARE_ALLOWED = new Set(['--font-body'])
  for (const name of tokenNames) {
    if (!name.startsWith('--velo-') && !BARE_ALLOWED.has(name))
      fail(out, `FAIL tokens.css: ${name} is neither a --velo-* token nor the allowed --font-body`)
  }
  const brandFamily = (() => {
    const url = String(brand['fontUrl'] ?? '')
    const m = url.match(/family=([^&:]+)/)
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null
  })()
  if (brand['fontUrl'] !== undefined && brandFamily) {
    const body = tokens['--font-body']
    if (body === undefined)
      fail(
        out,
        `FAIL tokens.css: fontUrl is set but --font-body is not overridden -- the link loads a font the app never uses`,
      )
    else if (!body.includes(brandFamily))
      fail(
        out,
        `FAIL tokens.css: --font-body must name the fontUrl family "${brandFamily}", got: ${body}`,
      )
    else ok(out, `font: --font-body carries the fontUrl family "${brandFamily}"`)
  }
  if (tokens['--velo-tg-header'] !== undefined) {
    const declared = tokens['--velo-tg-header'].toLowerCase()
    const brandColor = brand['themeColor'].trim().toLowerCase()
    if (declared !== brandColor) {
      fail(
        out,
        `FAIL §1 single source: tokens.css --velo-tg-header (${declared}) != brand.json themeColor (${brandColor})`,
      )
    } else ok(out, '§1 single source: --velo-tg-header == brand.json themeColor')
  } else {
    warn(
      out,
      'tokens.css does not override --velo-tg-header: the Telegram header stays the golden #334d6e while brand.json themeColor differs from it',
    )
    if (brand['themeColor'].trim().toLowerCase() !== '#334d6e') {
      // The HTML meta and the manifest WILL carry themeColor (materialized),
      // so a mismatched native header is almost certainly unintended.
      fail(
        out,
        'FAIL §1 single source: themeColor != #334d6e but tokens.css never overrides --velo-tg-header -- the Telegram header would stay VELO-colored',
      )
    }
  }

  // 4. contrast ---------------------------------------------------------------
  // Values resolve against the GOLDEN tokens: a skin that darkens a surface
  // without retouching the text on it fails right here.
  const baseTokens = parseTokens(readFileSync(join(frontendDir, 'src', 'styles', 'variables.css'), 'utf8'))
  for (const [fgName, bgName, min] of CONTRAST_PAIRS) {
    const fg = tokens[fgName] ?? baseTokens[fgName]
    const bg = bgName.startsWith('--') ? (tokens[bgName] ?? baseTokens[bgName]) : bgName
    if (fg === undefined || bg === undefined) continue
    if (tokens[fgName] === undefined && tokens[bgName] === undefined && !bgName.startsWith('#'))
      continue // nothing overridden -- the golden pair is already accepted
    const ratio = contrast(fg, bg)
    if (ratio === null) {
      warn(out, `contrast: cannot evaluate ${fgName} on ${bgName} (unsupported value format)`)
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
  if (!existsSync(join(skinDir, 'bg', 'background.png'))) {
    const textPrimary = luminance(tokens['--velo-text-primary'] ?? baseTokens['--velo-text-primary'])
    if (textPrimary && textPrimary.lum > 0.35) {
      fail(
        out,
        'FAIL bg/background.png: missing while --velo-text-primary is LIGHT -- the golden light photo stays and the light text on it is unreadable. Ship the full package including bg/, or use dark text tokens.',
      )
    } else {
      warn(out, 'bg/background.png missing: the golden light photo stays (fine for a light-on-light skin)')
    }
  } else ok(out, 'bg/background.png present')
  // The manifest/HTML background: themeColor text on backgroundColor surface.
  const splash = contrast(brand['themeColor'], brand['backgroundColor'])
  if (splash !== null && splash < 3)
    warn(
      out,
      `contrast: themeColor on backgroundColor is ${splash.toFixed(2)}:1 -- check the Android splash reads`,
    )

  // 5. PNG dimensions + apple-touch opacity -----------------------------------
  for (const [asset, [w, h]] of Object.entries(PNG_SIZES)) {
    const info = pngInfo(join(skinDir, asset))
    if (!info) {
      fail(out, `FAIL ${asset}: not a readable PNG (bad signature/IHDR)`)
      continue
    }
    if (info.width !== w || info.height !== h)
      fail(out, `FAIL ${asset}: ${info.width}x${info.height}, expected ${w}x${h}`)
    else ok(out, `${asset}: ${info.width}x${info.height}`)
    if (asset.startsWith('apple-touch') && (info.colorType === 4 || info.colorType === 6))
      fail(out, `FAIL ${asset}: has an alpha channel (colorType ${info.colorType}) -- iOS paints transparency black`)
  }
  for (const asset of ['favicon.svg', 'velo-word-filled.svg', 'velo-word-blue.svg']) {
    const head = readFileSync(join(skinDir, asset), 'utf8').slice(0, 200)
    if (!/<svg|<\?xml/.test(head)) fail(out, `FAIL ${asset}: does not look like an SVG`)
  }

  // 6. manual items -----------------------------------------------------------
  out.manual.push(
    'MANUAL icon-maskable-512.png: the 80% safe zone needs pixel inspection (no rasterizer in this validator)',
  )
  out.manual.push(
    'MANUAL screens: the skin is pixel-checked against the reference snapshots (tz-whitelabel §3)',
  )
  return out
}

// -- CLI ----------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const skinDir = process.argv[2] ?? 'public/skin'
  const frontendDir = resolve(import.meta.dirname, '..')
  const report = validateSkin(skinDir, frontendDir)
  for (const line of [...report.fails, ...report.warns, ...report.manual, ...report.passed])
    console.log(line)
  console.log(
    `\nvalidate-skin: ${report.fails.length} fail(s), ${report.warns.length} warn(s), ${report.passed.length} check(s) passed`,
  )
  process.exit(report.fails.length > 0 ? 1 : 0)
}
