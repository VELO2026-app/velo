// =============================================================================
// VELO Frontend -- the skin package engine (FE-131, tz-whitelabel §3.2)
// =============================================================================
// ONE module reads a skin package of the deploy machine's format and turns it
// into what the build needs; validate-skin.mjs, platform/skin.ts (the vite
// config), apply-skin, build-matrix and instance-checklist all go through it,
// so the check and the CSS can never disagree (contract 3 rule 10: "the
// converter into CSS variables is the product's engine").
//
// THE PACKAGE (contract "1.x" of the VELO skin slot; primer guide §4.4):
//
//   primer-package.yaml          block form: `schema: 1`, `contract: "1.0"` --
//                                the contract is a quoted POINT "X.Y" (a range
//                                lives only in the product's packages.skin)
//   tokens/<name>.tokens.json    W3C DTCG. Token paths are the paths of
//                                frontend/tokens.json: velo.<a>.<b> is
//                                --velo-<a>-<b>, bare.font-body is --font-body
//                                (the ONE bare token a skin may set). A path
//                                the product does not know is refused -- a
//                                typo would theme nothing.
//   tokens/brand.tokens.json     (by convention) carries the brand record in
//                                the root $extensions["velo-skin"]:
//                                displayName, shortName, themeColor,
//                                backgroundColor, fonts? -- the generation-1
//                                brand.json, moved into the package's only
//                                data carrier
//   assets/<name>.svg|png        the fixed generation-1 asset names
//   assets/bg/, assets/onboarding/   optional, replace the public/ ones
//   assets/fonts/<name>.woff2    self-hosted webfonts (no external request
//                                from a package -- tz-whitelabel §7)
//   README.md, LICENSE           read past
//
// Nothing else: any other file, a symlink, an executable file is refused
// (the same rule as primer-blank's package.js -- a package is data).
//
// Token values (the package is UNTRUSTED data -- it must not be able to
// smuggle CSS or a request into the build): a string is a CSS value of a
// closed alphabet -- letters, digits, spaces, # % . , ( ) + - * / -- with
// only the functions the golden tokens use (var, color-mix, rgb/rgba,
// hsl/hsla, cubic-bezier, calc/min/max/clamp): no quotes, no backslash, no
// comment, no url()/image-set(). A DTCG reference "{velo.primary}" becomes
// var(--velo-primary); bare.font-body is a family list (a list, or the CSS
// string form) whose every name is checked; a number is written as is.
//
// Assets: the content rules of the machine's package.js for SVG (no script,
// event handler, javascript:, foreignObject, embedded document, DOCTYPE /
// ENTITY, link or url() out of the file), tightened (SVG_FORBIDDEN below) --
// the files land on the app's origin; fonts, JPEG and WebP by signature.
// Object DTCG values ({colorSpace, components}, {value, unit}) are not
// read yet -- a value is a CSS string, a reference, a number or a family list. The SIZE limits are this product's own (the golden logo is 330 KB,
// the background 804x1748): SVG <= 512 KiB, PNG <= 4 MiB and <= 4096 px.
//
// Pure Node (fs/path), no dependencies: the vite config and the scripts load
// it as is; skin-package.d.mts types it for platform/skin.ts.
// =============================================================================

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The major of the skin contract this product reads (`>=1,<2`). */
export const SKIN_CONTRACT_MAJOR = 1
/** The contract a package written by this product's tools declares. */
export const SKIN_CONTRACT = '1.0'
export const MANIFEST = 'primer-package.yaml'
/** The $extensions key of the brand record. */
export const BRAND_EXTENSION = 'velo-skin'

/** Generation-1 mandatory assets, by their file name under assets/. */
export const MANDATORY_ASSETS = [
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
/** Optional asset directories: each replaces the public/ one of its name. */
export const ASSET_DIRS = ['bg', 'onboarding']

const ALLOWED_FILES = [
  /^primer-package\.yaml$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^tokens\/[a-z0-9-]+\.tokens\.json$/,
  /^assets\/[a-z0-9-]+\.(svg|png)$/,
  /^assets\/(bg|onboarding)\/[a-z0-9-]+\.(svg|png|jpg|webp)$/,
  /^assets\/fonts\/[a-z0-9-]+\.woff2$/,
]
const MAX_FILES = 256
/** Read past silently: OS litter in a local working copy, never shipped
 *  (apply-skin and the copy into dist skip them as well). */
export const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const SVG_MAX_BYTES = 512 * 1024
const PNG_MAX_BYTES = 4 * 1024 * 1024
const PNG_MAX_SIDE = 4096
const JSON_MAX_BYTES = 256 * 1024
const FONT_MAX_BYTES = 2 * 1024 * 1024
// The machine's rules, tightened after review: a namespace prefix (<x:script>)
// or an entity (&#106;avascript:) must not slip past a name match, so the
// whole family is refused -- prefixed elements, numeric entities, <style>
// and style="" (CSS escapes, image-set()), animation (it can rewrite href),
// src="" attributes. The golden SVGs use none of them.
const SVG_FORBIDDEN = [
  [/<[A-Za-z_][\w.-]*:/, 'a namespace-prefixed element'],
  // CSS escapes (u\72 l( in a presentation attribute) -- the golden SVGs
  // carry no backslash at all
  [/\\/, 'a backslash (CSS escape)'],
  // any processing instruction but the XML declaration (xml-stylesheet ->
  // XSLT), and the XSLT namespace itself
  [/<\?(?!xml\s)/i, 'a processing instruction'],
  [/XSL\/Transform/i, 'an XSLT namespace'],
  [/&#/, 'a numeric character reference'],
  [/<style/i, 'a <style> element'],
  [/[\s/"']style\s*=/i, 'a style attribute'],
  [/<(animate|animateMotion|animateTransform|set)\b/i, 'an animation element'],
  [/[\s/"']src\s*=/i, 'a src attribute'],
  [/<script/i, 'a script'],
  [/[\s/"']on[a-z]+\s*=/i, 'an event handler'],
  [/javascript:/i, 'a javascript: address'],
  [/<foreignObject/i, 'foreignObject'],
  [/<(iframe|embed|object)/i, 'an embedded document'],
  [/<!(DOCTYPE|ENTITY)/i, 'a DOCTYPE or ENTITY'],
  [/href\s*=\s*["']?\s*[^#"'\s]/i, 'a link out of the file'],
  [/url\(\s*["']?\s*[^#"'\s)]/i, 'a url() out of the file'],
  [/@import/i, 'an @import'],
]
const PNG_MAGIC = '89504e470d0a1a0a'
/** The closed alphabet of a token value, and the functions it may call. */
const VALUE_CHARS = /^[A-Za-z0-9 \t\n#%.,()+*\/-]+$/
const VALUE_FUNCTIONS = new Set([
  'var',
  'color-mix',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'cubic-bezier',
  'calc',
  'min',
  'max',
  'clamp',
])
/** A font family name -- the same rule for brand.fonts and bare.font-body. */
const FAMILY = /^[A-Za-z0-9 ._-]+$/
/** initial/inherit/... in a family list invalidate font-family: var(--font-body). */
const CSS_WIDE_KEYWORDS = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default'])
/** A display text: no markup, no control characters (it lands in HTML). */
const UNSAFE_TEXT = /[<>&"\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/
const NAME = /^[A-Za-z0-9_-]+$/
const REFERENCE = /^\{([^{}]+)\}$/
const TOKEN_KEYS = new Set(['$value', '$type', '$description', '$extensions', '$deprecated'])
const GROUP_KEYS = new Set(['$type', '$description', '$extensions', '$deprecated'])
/** The token paths a skin may set: every velo.* token, and --font-body. */
const BARE_ALLOWED = new Set(['bare.font-body'])
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])

// -- the product's token map --------------------------------------------------

/** path ("velo.text.primary") -> { cssName, order, value } of the golden
 *  tokens.json -- the names a package may theme, and their cascade order. */
export function goldenTokenMap(tokensDoc) {
  const map = new Map()
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$') || !value || typeof value !== 'object') continue
      const here = path.concat(key)
      if ('$value' in value) {
        const p = value.$extensions?.pridem ?? {}
        if (p.cssName && p.overrides === undefined)
          map.set(here.join('.'), {
            cssName: p.cssName,
            order: p.order,
            value: String(value.$value).trim(),
          })
      }
      walk(value, here)
    }
  }
  walk(tokensDoc.root, [])
  return map
}

/** The golden tokens.json of this frontend. */
export function readGoldenTokens(frontendDir) {
  return JSON.parse(readFileSync(join(frontendDir, 'tokens.json'), 'utf8'))
}

/** May a skin set this golden path? velo.* and the bare --font-body only. */
export function skinnable(path) {
  return path.startsWith('velo.') || BARE_ALLOWED.has(path)
}

// -- files ---------------------------------------------------------------------

function listFiles(dir, problems) {
  const files = []
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir
    for (const entry of readdirSync(abs).sort()) {
      if (entry === '.git' && !rel) continue // a checkout of the package repo
      if (IGNORED_FILES.has(entry)) continue
      const relPath = rel ? `${rel}/${entry}` : entry
      const stat = lstatSync(join(dir, relPath))
      if (stat.isSymbolicLink()) {
        problems.push(`${relPath}: a symlink -- a package carries plain files only`)
      } else if (stat.isDirectory()) {
        walk(relPath)
      } else if (files.length >= MAX_FILES) {
        problems.push(`more than ${MAX_FILES} files -- not a skin package`)
        return
      } else {
        if (stat.mode & 0o111) problems.push(`${relPath}: executable -- a package carries no code`)
        if (!ALLOWED_FILES.some((re) => re.test(relPath)))
          problems.push(
            `${relPath}: not a file of the skin format (primer-package.yaml, tokens/*.tokens.json, assets/...)`,
          )
        files.push(relPath)
      }
    }
  }
  walk('')
  return files
}

/** primer-package.yaml, block form: `key: value` lines, `#` comments. */
export function parseManifest(text) {
  const out = {}
  // A BOM (a Windows editor) and CRLF line ends are not content.
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!m) return { error: `cannot read the line "${raw.trim()}" (block form: key: value)` }
    out[m[1]] = m[2].trim()
  }
  return { fields: out }
}

function checkManifest(dir, problems) {
  const path = join(dir, MANIFEST)
  if (!existsSync(path)) {
    problems.push(`${MANIFEST}: missing -- not a skin package`)
    return null
  }
  const parsed = parseManifest(readFileSync(path, 'utf8'))
  if (parsed.error) {
    problems.push(`${MANIFEST}: ${parsed.error}`)
    return null
  }
  const { schema, contract } = parsed.fields
  if (schema !== '1') problems.push(`${MANIFEST}: schema must be 1, got ${schema ?? 'nothing'}`)
  const point = String(contract ?? '').match(/^"(\d+)\.(\d+)"$/)
  if (!point) {
    problems.push(
      `${MANIFEST}: contract must be a quoted point "X.Y" (a range belongs to the product's slot), got ${contract ?? 'nothing'}`,
    )
    return null
  }
  if (Number(point[1]) !== SKIN_CONTRACT_MAJOR)
    problems.push(
      `${MANIFEST}: contract "${point[1]}.${point[2]}" -- this product reads contract ${SKIN_CONTRACT_MAJOR}.x`,
    )
  return `${point[1]}.${point[2]}`
}

// -- tokens ----------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Walks one DTCG document into `tokens` (path -> { file, token }). */
function collect(node, file, path, tokens, problems) {
  for (const [key, value] of Object.entries(node)) {
    const where = `${file}: ${path.concat(key).join('.') || '(root)'}`
    if (key.startsWith('$')) {
      if (!GROUP_KEYS.has(key)) problems.push(`${where}: unknown DTCG key ${key}`)
      continue
    }
    if (!NAME.test(key)) {
      problems.push(`${where}: a name is letters, digits, _ and -`)
      continue
    }
    if (!isObject(value)) {
      problems.push(`${where}: a token or a group must be an object`)
      continue
    }
    const here = path.concat(key)
    if ('$value' in value) {
      for (const k of Object.keys(value))
        if (k.startsWith('$') && !TOKEN_KEYS.has(k)) problems.push(`${where}: unknown DTCG key ${k}`)
      const id = here.join('.')
      if (tokens.has(id)) problems.push(`${where}: declared twice (also in ${tokens.get(id).file})`)
      else tokens.set(id, { file, token: value })
    }
    // A golden token may also be a group (velo.primary and velo.primary.dark).
    const children = Object.fromEntries(
      Object.entries(value).filter(([k]) => !k.startsWith('$')),
    )
    collect(children, file, here, tokens, problems)
  }
}

/** A family list -> CSS, or { error }. Every name must be a plain family
 *  name: a quote, a backslash or a newline inside one would end the string
 *  early and let the rest of the value become CSS rules. */
function familyList(list) {
  const names = []
  for (const raw of list) {
    const name = String(raw)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
    if (!FAMILY.test(name)) return { error: `font family "${raw}" is not a plain family name` }
    if (CSS_WIDE_KEYWORDS.has(name.toLowerCase()))
      return { error: `"${name}" is a CSS-wide keyword, not a font family` }
    names.push(GENERIC_FAMILIES.has(name) || /^[A-Za-z-]+$/.test(name) ? name : `'${name}'`)
  }
  return { css: names.join(', ') }
}

/** A CSS value string of the closed alphabet, or the reason it is refused. */
function safeValue(value) {
  if (!VALUE_CHARS.test(value))
    return 'only letters, digits, spaces and # % . , ( ) + - * / -- no quotes, backslashes, ; { } < >'
  if (value.includes('/*') || value.includes('*/')) return 'no CSS comments'
  for (const [, fn] of value.matchAll(/([A-Za-z-]+)\s*\(/g))
    if (!VALUE_FUNCTIONS.has(fn.toLowerCase()))
      return `the function ${fn}() is not allowed (${[...VALUE_FUNCTIONS].join(', ')})`
  if ((value.match(/\(/g) ?? []).length !== (value.match(/\)/g) ?? []).length)
    return 'unbalanced parentheses'
  return null
}

/** A DTCG $value -> CSS text, or { error }. */
function cssValue(value, golden, path) {
  if (path === 'bare.font-body') {
    if (typeof value === 'string') return familyList(value.split(','))
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string'))
      return familyList(value)
    return { error: 'bare.font-body is a family list (a list of names, or "A, B, sans-serif")' }
  }
  if (typeof value === 'string') {
    const ref = value.trim().match(REFERENCE)
    if (ref) {
      const target = golden.get(ref[1])
      if (!target) return { error: `reference {${ref[1]}} names no token of the product` }
      return { css: `var(${target.cssName})` }
    }
    const css = value.trim().replace(/\s+/g, ' ')
    if (css === '') return { error: 'empty value' }
    const refused = safeValue(css)
    if (refused) return { error: `value "${value}": ${refused}` }
    return { css }
  }
  if (typeof value === 'number' && Number.isFinite(value)) return { css: String(value) }
  return {
    error: 'unsupported $value -- a CSS string, a {reference}, a number, or a font family list',
  }
}

// -- brand ---------------------------------------------------------------------------

const HEX6 = /^#[0-9a-fA-F]{6}$/
const FONT_FILE = /^assets\/fonts\/[a-z0-9-]+\.woff2$/

function checkBrand(record, files, problems) {
  const where = `$extensions["${BRAND_EXTENSION}"]`
  if (!isObject(record)) {
    problems.push(`${where}: must be an object`)
    return null
  }
  const str = (key) => typeof record[key] === 'string' && record[key].trim() !== ''
  for (const key of ['displayName', 'shortName']) {
    if (!str(key)) problems.push(`${where}.${key}: must be a non-empty string`)
    else if (UNSAFE_TEXT.test(record[key]))
      problems.push(`${where}.${key}: no < > & " or control characters (it lands in HTML)`)
  }
  if (str('shortName') && record.shortName.trim().length > 12)
    problems.push(`${where}.shortName "${record.shortName}" exceeds 12 chars (PWA convention)`)
  for (const key of ['themeColor', 'backgroundColor'])
    if (!str(key) || !HEX6.test(record[key].trim()))
      problems.push(`${where}.${key}: must be a 6-digit hex color`)
  if (record.fontUrl !== undefined)
    problems.push(
      `${where}.fontUrl: a package makes no external request -- ship the font in assets/fonts/ and list it in "fonts"`,
    )
  const known = new Set(['displayName', 'shortName', 'themeColor', 'backgroundColor', 'fonts', 'fontUrl'])
  for (const key of Object.keys(record))
    if (!known.has(key)) problems.push(`${where}.${key}: unknown field`)
  const fonts = []
  if (record.fonts !== undefined) {
    if (!Array.isArray(record.fonts) || record.fonts.length === 0)
      problems.push(`${where}.fonts: must be a non-empty list of { family, file, weight?, style? }`)
    else
      record.fonts.forEach((font, i) => {
        const at = `${where}.fonts[${i}]`
        if (!isObject(font)) return problems.push(`${at}: must be an object`)
        const family = typeof font.family === 'string' ? font.family.trim() : ''
        if (!FAMILY.test(family)) problems.push(`${at}.family: a plain family name`)
        if (typeof font.file !== 'string' || !FONT_FILE.test(font.file))
          problems.push(`${at}.file: a path assets/fonts/<name>.woff2`)
        else if (!files.includes(font.file)) problems.push(`${at}.file: ${font.file} is not in the package`)
        const weight = font.weight ?? 400
        if (
          !(typeof weight === 'number' && weight >= 1 && weight <= 1000) &&
          !(typeof weight === 'string' && /^\d{1,4} \d{1,4}$/.test(weight))
        )
          problems.push(`${at}.weight: 1..1000 or a variable range "100 900"`)
        const style = font.style ?? 'normal'
        if (style !== 'normal' && style !== 'italic') problems.push(`${at}.style: normal or italic`)
        fonts.push({ family, file: font.file, weight, style })
      })
  }
  return {
    displayName: String(record.displayName ?? '').trim(),
    shortName: String(record.shortName ?? '').trim(),
    themeColor: String(record.themeColor ?? '').trim(),
    backgroundColor: String(record.backgroundColor ?? '').trim(),
    fonts,
  }
}

// -- assets ------------------------------------------------------------------

function checkAsset(dir, file, problems) {
  const path = join(dir, file)
  const size = statSync(path).size
  if (file.endsWith('.svg')) {
    if (size > SVG_MAX_BYTES) return problems.push(`${file}: larger than ${SVG_MAX_BYTES} bytes`)
    const text = readFileSync(path, 'utf8')
    const start = text.replace(/^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*/, '')
    if (!/^<svg[\s>/]/.test(start)) return problems.push(`${file}: not an SVG image`)
    for (const [re, what] of SVG_FORBIDDEN) if (re.test(text)) problems.push(`${file}: has ${what}`)
  } else if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.webp')) {
    if (size > PNG_MAX_BYTES) return problems.push(`${file}: larger than ${PNG_MAX_BYTES} bytes`)
    const head = readFileSync(path).subarray(0, 24)
    if (file.endsWith('.jpg')) {
      if (head.subarray(0, 3).toString('hex') !== 'ffd8ff') problems.push(`${file}: not a JPEG image`)
      return
    }
    if (file.endsWith('.webp')) {
      if (head.subarray(0, 4).toString('latin1') !== 'RIFF' || head.subarray(8, 12).toString('latin1') !== 'WEBP')
        problems.push(`${file}: not a WebP image`)
      return
    }
    if (head.length < 24 || head.subarray(0, 8).toString('hex') !== PNG_MAGIC)
      return problems.push(`${file}: not a PNG image`)
    if (head.readUInt32BE(16) > PNG_MAX_SIDE || head.readUInt32BE(20) > PNG_MAX_SIDE)
      problems.push(`${file}: wider or taller than ${PNG_MAX_SIDE} px`)
  } else if (file.endsWith('.woff2')) {
    if (size > FONT_MAX_BYTES) return problems.push(`${file}: larger than ${FONT_MAX_BYTES} bytes`)
    if (readFileSync(path).subarray(0, 4).toString('latin1') !== 'wOF2')
      problems.push(`${file}: not a WOFF2 font`)
  }
}

// -- the package -----------------------------------------------------------------------

/**
 * Reads and checks the skin package at `dir` against the golden token map.
 *
 * @returns `{ problems, contract, brand, decls, files }` -- `problems` empty
 *   means the package is well-formed (validate-skin.mjs adds the content
 *   checks: contrast, PNG facts, the single header-color source). `decls` is
 *   `[cssName, cssValue][]` in the golden cascade order.
 */
export function loadSkinPackage(dir, tokensDoc) {
  dir = resolve(dir)
  const problems = []
  const empty = { problems, contract: null, brand: null, decls: [], files: [] }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    problems.push(`${dir}: no package directory`)
    return empty
  }
  const files = listFiles(dir, problems)
  const contract = checkManifest(dir, problems)
  const golden = goldenTokenMap(tokensDoc)

  const tokens = new Map()
  const brands = []
  for (const file of files.filter((f) => f.startsWith('assets/'))) checkAsset(dir, file, problems)

  for (const file of files.filter((f) => f.startsWith('tokens/'))) {
    if (statSync(join(dir, file)).size > JSON_MAX_BYTES) {
      problems.push(`${file}: larger than ${JSON_MAX_BYTES} bytes`)
      continue
    }
    let doc
    try {
      doc = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (e) {
      problems.push(`${file}: not valid JSON (${e.message})`)
      continue
    }
    if (!isObject(doc)) {
      problems.push(`${file}: a DTCG document is an object`)
      continue
    }
    const ext = doc.$extensions
    if (isObject(ext) && BRAND_EXTENSION in ext) brands.push({ file, record: ext[BRAND_EXTENSION] })
    collect(doc, file, [], tokens, problems)
  }

  let brand = null
  if (brands.length === 0)
    problems.push(`tokens/: no brand record -- a root $extensions["${BRAND_EXTENSION}"] (tokens/brand.tokens.json)`)
  else if (brands.length > 1)
    problems.push(`tokens/: the brand record is declared in ${brands.map((b) => b.file).join(' and ')} -- one only`)
  else brand = checkBrand(brands[0].record, files, problems)

  const decls = []
  for (const [path, { file, token }] of tokens) {
    const target = golden.get(path)
    if (!target) {
      problems.push(`${file}: ${path} is not a token of the product (a typo themes nothing)`)
      continue
    }
    if (!skinnable(path)) {
      problems.push(`${file}: ${path} is a frozen bare token -- a skin sets velo.* and bare.font-body only`)
      continue
    }
    const value = cssValue(token.$value, golden, path)
    if (value.error) problems.push(`${file}: ${path}: ${value.error}`)
    else decls.push({ order: target.order, name: target.cssName, value: value.css })
  }
  decls.sort((a, b) => a.order - b.order)

  // A reference cycle (velo.primary -> {velo.primary}, or through a golden
  // var() chain) makes the property invalid at computed-value time -- the
  // color silently disappears. Walk every var() the package's values reach,
  // over the package's overrides on top of the golden values.
  const values = new Map([...golden.values()].map((t) => [t.cssName, t.value]))
  for (const d of decls) values.set(d.name, d.value)
  const refsOf = (name) =>
    [...(values.get(name) ?? '').matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1])
  for (const d of decls) {
    const stack = [[d.name, [d.name]]]
    const seen = new Set()
    let cycle = null
    while (stack.length > 0 && !cycle) {
      const [name, trail] = stack.pop()
      for (const next of refsOf(name)) {
        if (next === d.name) cycle = [...trail, next]
        else if (!seen.has(next)) {
          seen.add(next)
          stack.push([next, [...trail, next]])
        }
      }
    }
    if (cycle) problems.push(`tokens: a reference cycle ${cycle.join(' -> ')}`)
  }

  for (const asset of MANDATORY_ASSETS)
    if (!files.includes(`assets/${asset}`)) problems.push(`assets/${asset}: missing`)

  // A shipped font must be the one --font-body names (by exact family name),
  // or the package ships a font the app never uses. Here, not in the
  // validator only: a bare `vite build` must refuse it too.
  const body = decls.find((d) => d.name === '--font-body')
  const bodyFamilies = body
    ? body.value.split(',').map((f) => f.trim().replace(/^'(.*)'$/, '$1'))
    : []
  for (const family of new Set((brand?.fonts ?? []).map((f) => f.family))) {
    if (!body)
      problems.push(
        `fonts: "${family}" ships in assets/fonts/ but bare.font-body is not set -- the app never uses it`,
      )
    else if (!bodyFamilies.includes(family))
      problems.push(`fonts: bare.font-body must name the shipped family "${family}", got: ${body.value}`)
  }

  return {
    problems,
    contract,
    brand,
    decls: decls.map((d) => [d.name, d.value]),
    files,
  }
}

/** Is `dir` a skin package at all (the manifest decides)? */
export function isSkinPackage(dir) {
  return existsSync(join(dir, MANIFEST))
}

/**
 * The CSS the build ships for a loaded package: the @font-face rules of the
 * self-hosted fonts, then the token overrides under :root (imported after
 * global.css -- the tz-whitelabel §3 cascade).
 *
 * @param pkg - `loadSkinPackage()` result without problems.
 * @param urlBase - Public URL of the package root in dist (`/skin/`).
 */
export function skinCss(pkg, urlBase = '/skin/') {
  const out = []
  for (const font of pkg.brand?.fonts ?? []) {
    out.push(
      '@font-face {',
      `  font-family: '${font.family}';`,
      `  src: url('${urlBase}${font.file}') format('woff2');`,
      `  font-weight: ${font.weight};`,
      `  font-style: ${font.style};`,
      '  font-display: swap;',
      '}',
    )
  }
  out.push(':root {')
  for (const [name, value] of pkg.decls) out.push(`  ${name}: ${value};`)
  out.push('}')
  return out.join('\n') + '\n'
}
