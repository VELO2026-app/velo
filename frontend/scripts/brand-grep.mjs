// =============================================================================
// VELO Frontend -- brand + feature-registry grep gate (FE-114, F5.3)
// =============================================================================
// Two greps over the source, both from tz-whitelabel §6 / §4 and the
// brand-places reference tz-i18n §7.2. Modeled on no-cyrillic.mjs (string
// literals + Vue template text/attrs, comments stripped).
//
// GATE 1 -- the brand word. «VELO» in a USER STRING anywhere in the code is
// a hardcoded brand that would ship half-skinned. No file is exempt (FE-231):
// the brand name lives only in the skin package's brand record (displayName,
// served by virtual:skin-brand), the catalogs link it as @:brand, and the
// build without a package carries the core's neutral word (CORE_SKIN).
// (index.html placeholders/markers are build seams and are not src/;
// skins live in their own package repositories, FE-131.)
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
// colors, the golden font and the golden asset files live in the velo-brand
// skin package only. A hit is one of
//   - a golden brand color in code -- #rrggbb (with or without alpha),
//     %23rrggbb, or its rgb()/rgba() triple: src/ (.ts/.vue/.css/.svg, tests
//     skipped), index.html, tokens.json, the kit sources, and the SVG files
//     of public/ -- comments stripped (history may cite them);
//   - the golden font family name in code (same files, same stripping);
//   - a file under public/ or src/assets/ byte-identical to a golden asset
//     (sha256 of velo-brand v0.1.0 skin/assets and the pre-FE-230 practice
//     cards).
// Semantic colors (warning, error, the mood and analytics scales) and white
// or black are product colors, not the brand: they are not listed.
//
// GATE 5 -- the golden contact (FE-251). The support address is the brand's:
// the supportEmail of the package's brand record (contract 2.2), served as
// SKIN_SUPPORT_EMAIL. A golden domain (velo.app) in the core -- src/ with the
// locale catalogs, index.html, the text files of public/ -- is a hit; tests
// and comments are skipped. Without it an instance of another brand would
// send its users' mail to VELO's support.
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
function brandHits(files) {
  const hits = []
  for (const { path, raw } of files) {
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
/** The golden font family names. */
const GOLDEN_FONTS = ['marmelad']
/** sha256 of the golden asset files (velo-brand v0.1.0 skin/assets, and the
 *  practice cards before their color moved into a token). */
const GOLDEN_ASSET_SHA256 = new Set([
  '448f866fc7ae0814bff7e54154bdfe47159d634cb95c2a6c683203364de4bca8', // apple-touch-icon-180.png
  '1dde39b76fb1537d8c5d42906fe9f525ade329d67139d18b698c1a071b7f8dda', // bg/background.webp
  '2fd312a1724f49efee3d71e05ec18bf02d1b33feae09884a915ba07d8b6a629c', // favicon.svg
  '12c2dea232636ae1f050974f8674def76ec2a47b9c9cd814a1d8e7b5e94818bd', // fonts/marmelad-subset.woff2
  'f97d42bb38a286fc1223e93184cd329c94fb23e328a69ee8dbd88a4dafac8d01', // fonts/velo-marmelad-bold.woff2 (v0.3.0)
  '2dabc9711af9c23e277ae6df0a84811ab2c1f09e18d1299946a232f3e4f96918', // fonts/velo-marmelad-light.woff2 (v0.3.0)
  '07bd8a58511bac33027e4ea03f3a1ea56454c433b9e7e3d06602761ef82cbce9', // fonts/velo-marmelad-medium.woff2 (v0.3.0)
  'bb4c065112d0ec075990a214eb3ccb33be655f49370daadc114cb37605c5ed43', // fonts/velo-marmelad-regular.woff2 (v0.3.0)
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
  if (path.endsWith('.json')) return raw
  // .svg, .html -- an HTML page may carry an inline <style> with CSS comments
  return css(stripHtmlComments(raw))
}

/** A number written in CSS, rounded either way: 38.4 matches 38, 38.4, 39. */
const near = (v) => `(?:${Math.floor(v)}|${Math.ceil(v)})(?:\\.\\d+)?`

/** HSL of an sRGB triple (0-255): hue in degrees, saturation and lightness in %.
 *  @param {number[]} rgb */
function hsl(rgb) {
  const [r, g, b] = rgb
  const [rr, gg, bb] = [r, g, b].map((c) => c / 255)
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0)
    h = max === rr ? ((gg - bb) / d + 6) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
  return [h * 60, s * 100, l * 100]
}

/** A golden hue in any spelling: #rrggbb with or without alpha, its
 *  URL-encoded form (%23rrggbb in a data: URI), rgb()/rgba() with commas or
 *  spaces, in numbers or percents, and hsl()/hsla(). */
const GOLDEN_COLOR = GOLDEN_HEX.map((hex) => {
  const h = hex.slice(1)
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  const sep = '[\\s,]+'
  const triple = (parts) => parts.join(sep)
  const [hue, sat, light] = hsl(rgb)
  return {
    hex,
    re: new RegExp(
      [
        `(?:#|%23)${h}(?:[0-9a-f]{2})?(?![0-9a-f])`,
        `rgba?\\(\\s*${triple(rgb.map(String))}(?![0-9.%])`,
        `rgba?\\(\\s*${triple(rgb.map((c) => `${near((c / 255) * 100)}%`))}`,
        `hsla?\\(\\s*${near(hue)}(?:deg)?${sep}${near(sat)}%${sep}${near(light)}%`,
      ].join('|'),
    ),
  }
})

function lookHits(files) {
  const hits = []
  for (const { path, raw } of files) {
    const text = lookText(path, raw).toLowerCase()
    for (const { hex, re } of GOLDEN_COLOR) {
      const m = re.exec(text)
      if (m) hits.push(`${path}:~${lineOf(text, m[0])} golden color ${hex} (${m[0]})`)
    }
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

// -- gate 5: the golden contact (FE-251) ---------------------------------------

/** The golden VELO mail and web domains. */
const GOLDEN_DOMAINS = ['velo.app']

function contactHits(files) {
  const hits = []
  for (const { path, raw } of files) {
    const text = lookText(path, raw).toLowerCase()
    for (const domain of GOLDEN_DOMAINS) {
      // A subdomain counts (api.velo.app, mail.velo.app); a longer name
      // that only contains the domain (myvelo.app, velo.application) does not.
      const re = new RegExp(`(?<![\\w-])${domain.replaceAll('.', '\\.')}(?![\\w-])`)
      const m = re.exec(text)
      if (m) hits.push(`${path}:~${lineOf(text, m[0])} golden domain ${domain}`)
    }
  }
  return hits
}

// -- the report ----------------------------------------------------------------

/** The gates over `files` (Array of { path, content }); paths are
 *  frontend-root-relative ('src/...', 'env.d.ts', 'vite.config.ts').
 *  Gates 1-3 read the .ts/.vue files; gate 4 (`look`) reads every file it
 *  is given, `options.lookFiles` when passed (the CLI hands it a wider set);
 *  gate 5 (`contact`) likewise reads `options.contactFiles` (the CLI adds the
 *  catalogs). Returns { brand, features, switchedOff, look, contact } hit
 *  lists -- empty lists mean the gate passes. */
export function brandGrepReport(files, { lookFiles = files, contactFiles = files } = {}) {
  const prepared = files.map(({ path, content }) => ({ path, raw: content }))
  const code = prepared.filter(({ path }) => /\.(ts|vue)$/.test(path))
  return {
    brand: brandHits(code),
    features: featureHits(code),
    switchedOff: switchedOffHits(code),
    look: lookHits(lookFiles.map(({ path, content }) => ({ path, raw: content }))),
    contact: contactHits(contactFiles.map(({ path, content }) => ({ path, raw: content }))),
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
    ...listAll('../packages/velo-ui/.storybook'),
    ...listAll('public'),
  ]
    .filter((p) => /\.(ts|vue|css|svg|html)$/.test(p) && !p.includes('.test.'))
    .concat('index.html', 'tokens.json', '../docs/oauth-consent/index.html')
    .map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
  // Gate 5 reads the code with the locale catalogs, index.html and the text
  // files of public/.
  const contactFiles = [...listAll(SRC_ROOT), ...listAll('public')]
    .filter((p) => /\.(ts|vue|json|html|svg|webmanifest|txt)$/.test(p) && !p.includes('.test.'))
    .concat('index.html')
    .map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
  const binaries = [...listAll('public'), ...listAll('src/assets')].map((p) => ({
    path: p,
    bytes: readFileSync(p),
  }))

  const {
    brand,
    features,
    switchedOff,
    look: lookText,
    contact,
  } = brandGrepReport(files, { lookFiles, contactFiles })
  const look = [...lookText, ...goldenAssetHits(binaries)]
  if (brand.length > 0) {
    console.error(
      `brand-grep: ${brand.length} brand-word hit(s) -- the brand name ships only in the skin package (@:brand, virtual:skin-brand), never a literal (tz-i18n §7.2, tz-whitelabel §6):\n`,
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
      `brand-grep: ${look.length} golden-look hit(s) in the core -- the golden VELO colors, font and assets live in the velo-brand skin package (FE-230):\n`,
    )
    for (const h of look) console.error('  ' + h)
  }
  if (contact.length > 0) {
    console.error(
      `brand-grep: ${contact.length} golden-contact hit(s) in the core -- the support address is the brand's supportEmail in its skin package (FE-251):\n`,
    )
    for (const h of contact) console.error('  ' + h)
  }
  if (
    brand.length > 0 ||
    features.length > 0 ||
    switchedOff.length > 0 ||
    look.length > 0 ||
    contact.length > 0
  )
    process.exit(1)
  console.log(`brand-grep: clean (${files.length} files scanned)`)
}
