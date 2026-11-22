// =============================================================================
// VELO Frontend -- brand + feature-registry grep gate (FE-114, F5.3)
// =============================================================================
// Two greps over the source, both from tz-whitelabel §6 / §4 and the
// brand-places reference tz-i18n §7.2. Modeled on no-cyrillic.mjs (string
// literals + Vue template text/attrs, comments stripped).
//
// GATE 1 -- the brand word. «VELO» in USER STRINGS only inside the reference
// set; everywhere else it is a hardcoded brand that would ship half-skinned:
//   src/locales/**            the catalogs -- @:brand links live here
//   src/pwa/manifest.ts       golden identity defaults (pinned by its tests)
//   src/platform/skin.ts      CORE_SKIN -- the no-skin build's identity
//   src/platform/instance.ts  the VITE_BRAND ?? 'VELO' golden default
//   (the skin brand is a virtual module now, nothing on disk)
// (index.html placeholders/markers are the other reference
// carriers by design and are not src/ -- nothing to scan there; skins live
// in their own package repositories, FE-131.)
// Header comments («VELO Frontend --») are NOT user strings: comments are
// stripped before matching. *.test.ts pin golden copy on purpose (skipped).
//
// GATE 2 -- feature flags do not spread (tz-whitelabel §4, the COMPOSER_
// VOICE_INPUT lesson): the ONLY readers of the raw sources are
//   VITE_FEATURES             platform/features.ts (featureFlags), platform/
//                             instance.ts (parseFeatures), the env.d.ts type,
//                             vite.config.ts (forwards to featureDefines)
//   __VELO_FEATURE_*__        router/index.ts (the DCE gates), platform/
//                             features.ts (builds the names), env.d.ts
//                             (declarations), vite/vitest.config.ts
//                             (materialization via featureDefines)
//   featureDefines(           only the two vite configs
// A local `if (FEATURE_X)` is exactly a read of one of these tokens -- so the
// reader monopoly IS the grep for it; module gates route through the
// registry's accessors (featureEnabled/hasFeature, allowed anywhere) or the
// router's define literals.
//
// GATE 3 -- the switched-off literal (FE-151; protocol 5.2.3). The machine
// hands every variable of a switched-off instance option the literal
// `primer-switched-off`. The code never reads it: an option is known ONLY by
// its flag (platform/instance.ts isOptionEnabled). The literal anywhere in
// the code (comments stripped) -- a comparison, a fallback value, an
// apiBaseUrl default -- is a hit. No file is exempt.
//
// GATE 4 -- the golden look (FE-230, tz-whitelabel §3.4). The core is neutral: the golden VELO
// colours, the golden font and the golden asset files live in the velo-brand
// skin package only. A hit is one of
//   - a golden brand colour (hex, or its rgb() triple) in code: src/
//     (.ts/.vue/.css/.svg, tests skipped), index.html, the kit sources, and
//     the SVG files of public/ -- comments stripped (history may cite them);
//   - the golden font family name in code (same files, same stripping);
//   - a file under public/ or src/assets/ byte-identical to a golden asset
//     (sha256 of velo-brand v0.1.0 skin/assets and the pre-FE-230 practice
//     cards).
// Semantic colours (warning, error, the mood and analytics scales) and white
// or black are product colours, not the brand: they are not listed.
//
// Exit 1 on any hit. Wired into `pnpm lint`. brandGrepReport() is exported
// for the unit suite (src/platform/brand-grep.test.ts).
// =============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// -- shared scanning machinery (the no-cyrillic.mjs comment strippers) --------

/** Quote-aware comment stripper: removes line and block comments only
 *  OUTSIDE string literals, keeping string contents byte-identical
 *  (no-cyrillic.mjs has the war story). */
function stripJsComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
}

/** Split a .ts/.vue source into { script, template } with comments stripped
 *  (JS rules for the script block, HTML rules for the template). A .vue with
 *  a template but no script block has NO script part -- scanning the raw
 *  file there would double-count template attributes as string literals. */
function cleanParts(raw) {
  const tplMatch = raw.match(/<template>[\s\S]*<\/template>/)
  const scriptMatch = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  return {
    script: scriptMatch ? stripJsComments(scriptMatch[1]) : tplMatch ? '' : stripJsComments(raw),
    template: tplMatch ? stripHtmlComments(tplMatch[0]) : '',
  }
}

/** ~Line number of the first occurrence of `needle` in the raw text
 *  (stripping shifts offsets; the line is a finding AID, not a pin). */
function lineOf(raw, needle) {
  const idx = raw.indexOf(needle)
  return idx === -1 ? 0 : raw.slice(0, idx).split('\n').length
}

// -- gate 1: the brand word ----------------------------------------------------

const BRAND_WORD = /VELO/
// Build-seam marker vocabulary (NOT user copy): the feature-define names
// platform/features.ts generates, the index.html font-block markers and the
// theme-color placeholder platform/passport-html.ts moves around. Each is a
// technical token pinned by its own tests; none renders to a user.
const SEAM_MARKERS = [
  /__VELO_FEATURE_[A-Z0-9_]+__/g,
  /__VELO_FEATURE_\$\{[^}]*\}__/g, // the generator template in features.ts
  /<!--\/?VELO:FONT-->/g,
  /%VELO_THEME_COLOR%/g,
]
const carriesBrandWord = (s) => {
  let t = s
  for (const re of SEAM_MARKERS) t = t.replace(re, '')
  return BRAND_WORD.test(t)
}
// Dir prefixes and exact files where the brand word is contract, not hardcode.
const BRAND_REFERENCE_DIRS = ['src/locales']
const BRAND_REFERENCE_FILES = new Set([
  'src/pwa/manifest.ts',
  'src/platform/skin.ts',
  'src/platform/instance.ts',
])

function brandHits(files) {
  const hits = []
  for (const { path, raw } of files) {
    if (BRAND_REFERENCE_FILES.has(path)) continue
    if (BRAND_REFERENCE_DIRS.some((dir) => path.startsWith(dir + '/'))) continue
    const { script, template } = cleanParts(raw)
    // Template text nodes + attribute values (the no-cyrillic.mjs split:
    // tags out, text between them; attrs matched with the word inside).
    template.split('\n').forEach((line, i) => {
      const text = line.replace(/<[^>]+>/g, ' ')
      if (carriesBrandWord(text))
        hits.push(`${path}:~${i + 1} template text: ${text.trim().slice(0, 90)}`)
      for (const m of line.matchAll(/([\w:-]+)="([^"]*VELO[^"]*)"/g))
        if (carriesBrandWord(m[2]))
          hits.push(`${path}:~${i + 1} attr ${m[1]}="${m[2].slice(0, 80)}"`)
    })
    // Script string literals.
    script.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(`[^`\n]*`|'[^'\n]*'|"[^"\n]*")/g)) {
        if (carriesBrandWord(m[1])) hits.push(`${path}:~${i + 1} string: ${m[1].slice(0, 90)}`)
      }
    })
  }
  return hits
}

// -- gate 2: the feature-registry monopoly --------------------------------------

const VITE_FEATURES_READERS = new Set([
  'src/platform/features.ts',
  'src/platform/instance.ts',
  'env.d.ts',
  'vite.config.ts',
])
const FEATURE_DEFINES_READERS = new Set([
  'src/router/index.ts',
  'src/platform/features.ts',
  'env.d.ts',
  'vite.config.ts',
  'vitest.config.ts',
])
const FEATURE_DEFINES_CALLERS = new Set([
  'src/platform/features.ts',
  'vite.config.ts',
  'vitest.config.ts',
])
const FEATURE_LITERAL = /__VELO_FEATURE_[A-Z0-9_]+__/

function featureHits(files) {
  const hits = []
  for (const { path, raw } of files) {
    const { script, template } = cleanParts(raw)
    const code = script + '\n' + template
    if (code.includes('VITE_FEATURES') && !VITE_FEATURES_READERS.has(path))
      hits.push(
        `${path}:~${lineOf(raw, 'VITE_FEATURES')} reads VITE_FEATURES outside the registry (platform/features.ts, platform/instance.ts)`,
      )
    const literal = code.match(FEATURE_LITERAL)
    if (literal && !FEATURE_DEFINES_READERS.has(path))
      hits.push(
        `${path}:~${lineOf(raw, literal[0])} uses the gate literal ${literal[0]} outside router/index.ts`,
      )
    if (/featureDefines\s*\(/.test(code) && !FEATURE_DEFINES_CALLERS.has(path))
      hits.push(
        `${path}:~${lineOf(raw, 'featureDefines')} materializes featureDefines outside the vite configs`,
      )
  }
  return hits
}

// -- gate 3: the switched-off literal --------------------------------------------

const SWITCHED_OFF = 'primer-switched-off'

function switchedOffHits(files) {
  const hits = []
  for (const { path, raw } of files) {
    const { script, template } = cleanParts(raw)
    if ((script + '\n' + template).includes(SWITCHED_OFF))
      hits.push(
        `${path}:~${lineOf(raw, SWITCHED_OFF)} uses the literal ${SWITCHED_OFF} -- an option is known by its flag only (isOptionEnabled)`,
      )
  }
  return hits
}

// -- gate 4: the golden look (FE-230) -------------------------------------------

/** The golden VELO brand hues: primary/text blue family and the header. */
const GOLDEN_HEX = [
  '#627a9c',
  '#4c6589',
  '#334d6e',
  '#abbfda',
  '#91a2ba',
  '#619cd2',
  '#e2f0fd',
  '#62748a',
]
/** The same hues as rgb() triples (the text tokens are rgba() of them). */
const GOLDEN_RGB = ['76,101,137', '98,122,156', '51,77,110']
const GOLDEN_FONTS = ['marmelad']
/** sha256 of the golden asset files (velo-brand v0.1.0 skin/assets, and the
 *  practice cards before their colour moved into a token). */
export const GOLDEN_ASSET_SHA256 = new Set([
  '448f866fc7ae0814bff7e54154bdfe47159d634cb95c2a6c683203364de4bca8', // apple-touch-icon-180.png
  '1dde39b76fb1537d8c5d42906fe9f525ade329d67139d18b698c1a071b7f8dda', // bg/background.webp
  '2fd312a1724f49efee3d71e05ec18bf02d1b33feae09884a915ba07d8b6a629c', // favicon.svg
  '12c2dea232636ae1f050974f8674def76ec2a47b9c9cd814a1d8e7b5e94818bd', // fonts/marmelad-subset.woff2
  'c5482fe8a177af4ff0536ae66bcc90263f4bc5e903a6f5fca34faa448bc43655', // icon-192.png
  '520eb5ce9845fc700ba8595dbe4f5877268dd6b6a4758b503dd6c9b70bfa7889', // icon-512.png
  '3634452ad3e9403f2be8a6c079fadba3647760ca71bc8a5631e66f24a13cf962', // icon-maskable-512.png
  '569c4b1dd060a44e6e3e3442fc842dee933b6748a772a31e24137c883e2781c6', // logo-white.svg
  '92fa4c394837649a77bed132b7aa44164515ab41f2e1882c0f5bd1ded895aad0', // mandala-blue.png
  'a778ba38d8add34999ba08391bb832e5fae30f885ce6df9708adea8507911fb2', // mandala-white.png
  'd30907bdecb26ae453e3da2fc5742bc24ee1cbc526b265d22baa114ccb695a05', // onboarding/master-analytics.svg
  '5f1e846b5cf99bcef570202648a6ed1dc9d6468c338549424c3300d4ace09fdf', // onboarding/master-space.svg
  'c6fa5b97960794504bc85c823b9f21c51b0db21b053b611dda04604e18c7e48c', // onboarding/master-verdict-approved.svg
  '25d575284c9142d76be35140ba0dc500befa8de0e237715bbb10ab06086c9b3a', // onboarding/master-verdict-reject.svg
  'e370568d2f5a8b534f80262aa2a17e0a4d9613e923b59c97579fcefaa897735e', // onboarding/master-verdict-sent.svg
  '9ed306330f63189c3f7c5d61994a1851918c1e242f5570d68de7e1339776deaf', // onboarding/master-welcome.svg
  'b013d7a0244b27fafd94521477bc4a7d868125e9b879a9e906bf6ac0f28f47bf', // onboarding/onboarding-diary.svg
  '5fb6512842d83d2513d96ecade009f65483ea1e780d2066b871cf6a421f5447b', // onboarding/onboarding-masters.svg
  'f4c4e60779b2654db08169160481c7852dc450b44fd39f29abcb601e821ea9ad', // onboarding/onboarding-practice.svg
  '6341130ab0d1c874b15a61a52f1988bf56fc43efd461330026fa537985429577', // velo-word-blue.svg
  '498eafea8d0e9ed10cfa0eb7dcefd45d922250e3145e9eb248498747212babe6', // velo-word-filled.svg
  'a3b48f355512d8bddb7bac552e8778d34a61715933d85044b31a9ba7a7c5dbc9', // practice-cards/art.svg
  'cef6b4d8d99a78fe2d3d45d8d5cb8e61fbc8bc9ab8454561546f3a2eaad8996b', // practice-cards/breathwork.svg
  '98509bd0e09a1795b333d9b1f8b2758dc7ec16dfc84ca932bef3621806d62e0d', // practice-cards/circles.svg
  '0cf524ea1cef2d1d8fa0f9be3f4b6d1c79d91e2b9c2a6f1f28ce69cfba9820b4', // practice-cards/meditation.svg
  '22dae492bf599f394708127586fd2e453f409a7cbd91e20a80de6d9537dd41b9', // practice-cards/movement.svg
  '462bed84a70f94cd739692a14f78a95dc8a192201b61b6985ed1d564e8a9fb92', // practice-cards/narrative.svg
  '97a02a78252772367b3ccaa52b08f4937db3ba68b9645e835535bd2ff0238dfb', // practice-cards/somatic.svg
  'd737d093f1e4c6522a4b385baef417acce3d4eb0c43c75e6aa6b1de6030c95ff', // practice-cards/sound_healing.svg
  'd96ac56986fdd0288b0272f329376c44b56307fe6f148ff542212e578846cfd7', // practice-cards/tantra.svg
  '28a551238536d83ba4bbc827fce3cef7fc39604fda0d7033902e836aa6175bb6', // practice-cards/yoga.svg
])

/** The text a gate-4 scan reads: comments stripped by the file's kind. */
function lookText(path, raw) {
  const css = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
  if (/\.(ts|mjs|js)$/.test(path)) return stripJsComments(raw)
  if (path.endsWith('.css')) return css(raw)
  if (path.endsWith('.vue'))
    return stripHtmlComments(
      raw
        .replace(
          /(<script[^>]*>)([\s\S]*?)(<\/script>)/g,
          (_, a, b, c) => a + stripJsComments(b) + c,
        )
        .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, a, b, c) => a + css(b) + c),
    )
  return stripHtmlComments(raw) // .svg, .html
}

function lookHits(files) {
  const hits = []
  for (const { path, raw } of files) {
    const text = lookText(path, raw).toLowerCase()
    for (const hex of GOLDEN_HEX)
      if (new RegExp(`${hex}(?![0-9a-f])`).test(text))
        hits.push(`${path}:~${lineOf(raw.toLowerCase(), hex)} golden colour ${hex}`)
    const flat = text.replace(/\s+/g, '')
    for (const rgb of GOLDEN_RGB)
      if (flat.includes(`rgb(${rgb}`) || flat.includes(`rgba(${rgb}`))
        hits.push(`${path} golden colour rgb(${rgb})`)
    for (const font of GOLDEN_FONTS)
      if (text.includes(font)) hits.push(`${path} golden font ${font}`)
  }
  return hits
}

/** Files (Array of { path, bytes }) that are golden assets byte for byte. */
export function goldenAssetHits(files, hashes = GOLDEN_ASSET_SHA256) {
  return files
    .filter(({ bytes }) => hashes.has(createHash('sha256').update(bytes).digest('hex')))
    .map(({ path }) => `${path}: a golden VELO asset (it belongs to the velo-brand skin package)`)
}

// -- the report ----------------------------------------------------------------

/** The gates over `files` (Array of { path, content }); paths are
 *  frontend-root-relative ('src/...', 'env.d.ts', 'vite.config.ts').
 *  Gates 1-3 read the .ts/.vue files; gate 4 (`look`) reads every file it
 *  is given, `lookFiles` when passed (the CLI hands it a wider set).
 *  Returns { brand, features, switchedOff, look } hit lists -- empty lists
 *  mean the gate passes. */
export function brandGrepReport(files, lookFiles = files) {
  const prepared = files.map(({ path, content }) => ({ path, raw: content }))
  const code = prepared.filter(({ path }) => /\.(ts|vue)$/.test(path))
  return {
    brand: brandHits(code),
    features: featureHits(code),
    switchedOff: switchedOffHits(code),
    look: lookHits(lookFiles.map(({ path, content }) => ({ path, raw: content }))),
  }
}

// -- CLI -----------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const SRC_ROOT = 'src'
  const ROOT_FILES = ['env.d.ts', 'vite.config.ts', 'vitest.config.ts']

  const walk = (dir, files) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, files)
      else if (/\.(ts|vue)$/.test(name) && !name.includes('.test.'))
        files.push({ path: p.replaceAll('\\', '/'), content: readFileSync(p, 'utf8') })
    }
  }

  const files = []
  walk(SRC_ROOT, files)
  for (const p of ROOT_FILES) files.push({ path: p, content: readFileSync(p, 'utf8') })

  // Gate 4 reads more: styles and SVG too, index.html, the kit sources, and
  // every file of public/ and src/assets/ by its bytes.
  const listAll = (dir, out = []) => {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name !== 'node_modules' && !(dir === 'public' && name === 'skin')) listAll(p, out)
      } else out.push(p.replaceAll('\\', '/'))
    }
    return out
  }
  const lookFiles = [
    ...listAll(SRC_ROOT),
    ...listAll('../packages/velo-ui/src'),
    ...listAll('public'),
  ]
    .filter((p) => /\.(ts|vue|css|svg)$/.test(p) && !p.includes('.test.'))
    .concat('index.html')
    .map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
  const binaries = [...listAll('public'), ...listAll('src/assets')].map((p) => ({
    path: p,
    bytes: readFileSync(p),
  }))

  const { brand, features, switchedOff, look: lookText } = brandGrepReport(files, lookFiles)
  const look = [...lookText, ...goldenAssetHits(binaries)]
  if (brand.length > 0) {
    console.error(
      `brand-grep: ${brand.length} brand-word hit(s) outside the reference set -- the brand ships via @:brand/skin/passport, never a literal (tz-i18n §7.2, tz-whitelabel §6):\n`,
    )
    for (const h of brand) console.error('  ' + h)
  }
  if (features.length > 0) {
    console.error(
      `brand-grep: ${features.length} feature-flag hit(s) outside the registry -- flags live ONLY in platform/features.ts + platform/instance.ts + the router's define literals (tz-whitelabel §4):\n`,
    )
    for (const h of features) console.error('  ' + h)
  }
  if (switchedOff.length > 0) {
    console.error(
      `brand-grep: ${switchedOff.length} hit(s) of the switched-off literal -- the code never reads it, an option is known by its flag (FE-151, protocol 5.2.3):\n`,
    )
    for (const h of switchedOff) console.error('  ' + h)
  }
  if (look.length > 0) {
    console.error(
      `brand-grep: ${look.length} golden-look hit(s) in the core -- the golden VELO colours, font and assets live in the velo-brand skin package (FE-230):\n`,
    )
    for (const h of look) console.error('  ' + h)
  }
  if (brand.length > 0 || features.length > 0 || switchedOff.length > 0 || look.length > 0)
    process.exit(1)
  console.log(`brand-grep: clean (${files.length} files scanned)`)
}
