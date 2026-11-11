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
//   src/platform/skin.ts      GOLDEN_SKIN -- the no-skin build's identity
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
// Exit 1 on any hit. Wired into `pnpm lint`. brandGrepReport() is exported
// for the unit suite (src/platform/brand-grep.test.ts).
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
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

// -- the report ----------------------------------------------------------------

/** The gates over `files` (Array of { path, content }); paths are
 *  frontend-root-relative ('src/...', 'env.d.ts', 'vite.config.ts').
 *  Returns { brand, features, switchedOff } hit lists -- empty lists mean
 *  the gate passes. */
export function brandGrepReport(files) {
  const prepared = files.map(({ path, content }) => ({ path, raw: content }))
  return {
    brand: brandHits(prepared),
    features: featureHits(prepared),
    switchedOff: switchedOffHits(prepared),
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

  const { brand, features, switchedOff } = brandGrepReport(files)
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
  if (brand.length > 0 || features.length > 0 || switchedOff.length > 0) process.exit(1)
  console.log(`brand-grep: clean (${files.length} files scanned)`)
}
