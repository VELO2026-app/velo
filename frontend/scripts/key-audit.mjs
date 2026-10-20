// tz-i18n §4.4 key audit: catalog <-> code consistency gate.
//
// Three checks over the composed ru catalog (merged exactly like
// src/locales/index.ts: shallow spread over the glob-sorted files):
//   1. MISSING  -- a t('key') reference in src that no catalog path resolves.
//                  These render the raw key path to users; tests never catch
//                  them (test i18n silences missingWarn, hidden v-if blocks
//                  don't render). Fails the gate.
//   2. UNUSED   -- a catalog leaf no t() reference reaches. Mostly codemod
//                  residue (numbered dupes, orphaned toast copies). Fails the
//                  gate so the catalog can only shrink, not rot.
//   3. COLLISION-- the same ROOT key contributed by two locale files: the
//                  shallow merge silently drops one (the 'composer' incident).
//                  Fails the gate.
//   4. FLAT-DOTTED-- a key whose NAME contains '.': string-collides with the
//                  nested path of the same name in usage audits, and vue-i18n
//                  flat-vs-nested resolution is ambiguous. Fails the gate.
//
// Dynamic keys are legal (t(`report.reasons.${code}`)); the audit collects
// every ${...} prefix in source and treats catalog paths under them as used.
// Interpolation params are fine -- only the KEY PATH is audited.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createI18n } = require('vue-i18n')

const localesDir = 'src/locales/ru'
const srcRoot = 'src'

// -- compose the catalog (sorted file order == import.meta.glob order) --------
const files = readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort()
const catalog = {}
const rootsByFile = new Map()
for (const f of files) {
  const data = JSON.parse(readFileSync(join(localesDir, f), 'utf8'))
  for (const k of Object.keys(data)) {
    rootsByFile.set(k, (rootsByFile.get(k) ?? new Set()).add(f))
  }
  Object.assign(catalog, data)
}

// -- collect source files ------------------------------------------------------
const srcFiles = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (p === 'src/locales') continue
      walk(p)
    } else if (/\.(ts|vue)$/.test(name) && !name.includes('.test.')) {
      srcFiles.push(p)
    }
  }
}
walk(srcRoot)

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /\/\/.*/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const KEY_CALL = /\bt\(\s*(['"`])([^'"`]+)\1/g


// Quote-aware comment stripper: removes // and /* */ only OUTSIDE string
// literals (regex comment-stripping once ate half a file because the HTML
// header comment contained "/api/v1/admin/taxonomy/*" -- the gate then read
// the template as code). Keeps string contents byte-identical.
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


const usedExact = new Set()
const dynamicPrefixes = new Set()
for (const p of srcFiles) {
  const raw = readFileSync(p, 'utf8')
  // .vue: the template gets only HTML-comment stripping (a "/*" inside an
  // HTML comment once swallowed the whole template under JS rules); the
  // script block gets the quote-aware JS stripper.
  const tplMatch = // order-agnostic: some SFCs put <script> first
  raw.match(/<template>[\s\S]*<\/template>/)
  const scriptMatch = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  // Template refs are scanned WITH their HTML comments: a hidden-but
  // commented-out block (the "legend: HIDDEN for now" pattern) is a live
  // reference -- the key must survive until the owner deletes the block.
  // JS comments in the script stay stripped (commented t() there is dead).
  const src = [
    tplMatch ? tplMatch[0] : '',
    scriptMatch ? stripJsComments(scriptMatch[1]) : '',
    scriptMatch ? '' : stripJsComments(raw),
  ].join('\n')
  for (const m of src.matchAll(KEY_CALL)) {
    const path = m[2]
    if (path.includes('${')) dynamicPrefixes.add(path.split('${')[0])
    else usedExact.add(path)
  }
}

function resolve(path) {
  let node = catalog
  for (const part of path.split('.')) {
    if (node == null || typeof node !== 'object' || !(part in node)) return undefined
    node = node[part]
  }
  return node
}

// -- 1. missing ---------------------------------------------------------------
const missing = []
for (const path of usedExact) {
  const node = resolve(path)
  if (node === undefined) missing.push(path)
}

// -- 2. unused ----------------------------------------------------------------
// Catalog-as-data: not t()-targets, keyed by backend codes or read by seed
// imports (utils/timezoneCities.ts, utils/format.ts, utils/languages.ts,
// schoolBranding). Their leaves are exempt from the unused check.
const DATA_ROOTS = new Set(['errors', 'storeErrors', 'transcription'])
const SEED_FILES = new Set(['timezones.json', 'dates.json', 'languages.json', 'taxonomy.json'])
const unusedSkippedFiles = new Set(
  files.filter((f) => SEED_FILES.has(f)).map((f) => Object.keys(JSON.parse(readFileSync(join(localesDir, f), 'utf8')))[0]),
)
const isDynUsed = (path) => {
  for (const pre of dynamicPrefixes) {
    if (path === pre.replace(/\.$/, '') || path.startsWith(pre)) return true
  }
  return false
}
const unused = []
function walkUnused(node, path) {
  if (node != null && typeof node === 'object') {
    for (const k of Object.keys(node)) walkUnused(node[k], path ? `${path}.${k}` : k)
    return
  }
  if (path.endsWith('._comment') || path === '_comment') return
  if (DATA_ROOTS.has(path.split('.')[0]) || unusedSkippedFiles.has(path.split('.')[0])) return
  if (!usedExact.has(path) && !isDynUsed(path)) unused.push(path)
}
for (const f of files) {
  if (SEED_FILES.has(f)) continue
  walkUnused(JSON.parse(readFileSync(join(localesDir, f), 'utf8')), '')
}

// -- 2b. flat-dotted key names -------------------------------------------------
const flatDotted = []
function walkFlat(node, path) {
  if (node != null && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (k.includes('.')) flatDotted.push(`${path ? `${path}.` : ''}${k} = ${String(node[k]).slice(0, 50)}`)
      else walkFlat(node[k], path ? `${path}.${k}` : k)
    }
  }
}
for (const f of files) {
  if (SEED_FILES.has(f)) continue
  walkFlat(JSON.parse(readFileSync(join(localesDir, f), 'utf8')), '')
}

// -- 2c. message compilation ---------------------------------------------------
// Every leaf must COMPILE: broken vue-i18n syntax (wrong literal escape,
// unbalanced braces) crashes the whole screen's render at runtime, and no
// test is guaranteed to render that exact message (the {'@'} incident).
const compileI18n = createI18n({
  legacy: false,
  locale: 'ru',
  fallbackLocale: 'ru',
  missingWarn: false,
  fallbackWarn: false,
  warnHtmlMessage: false,
})
compileI18n.global.setLocaleMessage('ru', catalog)
const compileFails = []
function walkCompile(node, path) {
  if (node != null && typeof node === 'object') {
    for (const k of Object.keys(node)) walkCompile(node[k], path ? `${path}.${k}` : k)
    return
  }
  if (typeof node !== 'string' || path.includes('_comment')) return
  try {
    compileI18n.global.t(path)
  } catch (e) {
    compileFails.push(`${path} :: ${String(e.message).slice(0, 100)}`)
  }
}
walkCompile(catalog, '')

// -- 3. root collisions -------------------------------------------------------
const collisions = []
for (const [root, fs] of rootsByFile) {
  if (fs.size > 1) collisions.push(`${root}: ${[...fs].join(', ')}`)
}

if (process.env.DEBUG_KEY) {
  console.error('DEBUG add used:', usedExact.has('adminScreens.adminCatalog.add'))
  console.error('DEBUG srcFiles:', srcFiles.length, srcFiles.filter((f) => f.includes('AdminCatalog')).length)
  console.error('DEBUG usedExact size:', usedExact.size, 'dyn:', [...dynamicPrefixes])
}
let failed = false
if (missing.length > 0) {
  failed = true
  console.error(`key-audit: ${missing.length} MISSING key(s) -- t() renders the raw path:\n`)
  for (const k of missing) console.error(`   ${k}`)
}
if (unused.length > 0) {
  failed = true
  console.error(`\nkey-audit: ${unused.length} UNUSED leaf(s) -- delete or reference:\n`)
  for (const k of unused) console.error(`   ${k}`)
}
if (flatDotted.length > 0) {
  failed = true
  console.error(`\nkey-audit: ${flatDotted.length} FLAT-DOTTED key(s) -- rename to nested:\n`)
  for (const k of flatDotted) console.error(`   ${k}`)
}
if (compileFails.length > 0) {
  failed = true
  console.error(`\nkey-audit: ${compileFails.length} message(s) fail to COMPILE -- screen render would crash:\n`)
  for (const k of compileFails) console.error(`   ${k}`)
}
if (collisions.length > 0) {
  failed = true
  console.error(`\nkey-audit: ${collisions.length} ROOT collision(s) -- shallow merge drops one file's section:\n`)
  for (const k of collisions) console.error(`   ${k}`)
}
if (failed) process.exit(1)
console.log(`key-audit: clean (${files.length} catalogs, ${usedExact.size} referenced keys, ${dynamicPrefixes.size} dynamic prefixes)`)
