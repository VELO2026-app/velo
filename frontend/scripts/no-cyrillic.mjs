// tz-i18n §4.6 ratchet: zero Cyrillic outside locales/ (FE gate).
//
// Scans src/**/*.{ts,vue} for Cyrillic inside STRING LITERALS and Vue template
// TEXT NODES / attribute values, after stripping comments. Excluded:
//   - locales/  (the catalogs themselves are the point of the rule)
//   - *.test.ts (tests pin rendered Russian copy on purpose, tz-i18n §4.5)
//   - utils/schoolBranding/ -- the GOLDEN PORT of the school branding
//     generator (tz-curator.md §5.1/§5.3: «перенесён как есть», same hash
//     must yield the same SVG). Its 'Ш' monogram fallback is a prototype
//     constant, not UI copy; palette DISPLAY NAMES live in locales/ru/
//     schools.json (branding.palettes), hex roles stay in code.
// Data that is locale-independent lives in locales/ru/* seed files
// (timezones.json, dates.json, languages.json) -- move literals there,
// never back into code. Exit 1 on any hit.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CYR = /[А-Яа-яЁё]/
const EXEMPT_DIRS = ['src/utils/schoolBranding']
const LINE_COMMENT = /\/\/.*/g
const BLOCK_COMMENT = /\/\*.*?\*\//gs
const HTML_COMMENT = /<!--.*?-->/gs
const TAG = /<[^>]+>/g
const STRING_LIT = /(`[^`\n]*`|'[^'\n]*'|"[^"\n]*")/g
const ATTR = /([\w:-]+)="([^"]*[А-Яа-яЁё][^"]*)"/g


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

function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
}

const roots = ['src']
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (p === 'src/locales') continue
      walk(p)
    } else if (/\.(ts|vue)$/.test(name) && !name.includes('.test.')) {
      const normalized = p.replaceAll('\\', '/')
      if (!EXEMPT_DIRS.some((dir) => normalized.startsWith(dir))) files.push(p)
    }
  }
}
for (const r of roots) walk(r)

const hits = []
for (const p of files) {
  const raw = readFileSync(p, 'utf8')
  // .vue: the template gets only HTML-comment stripping (a "/*" inside an
  // HTML comment once swallowed the whole template under JS rules); the
  // script block gets the quote-aware JS stripper.
  const tplMatch = // order-agnostic: some SFCs put <script> first
  raw.match(/<template>[\s\S]*<\/template>/)
  const scriptMatch = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  const tpl = tplMatch ? stripHtmlComments(tplMatch[0]) : ''
  const script = scriptMatch ? stripJsComments(scriptMatch[1]) : stripJsComments(raw)

  const cleanTpl = tpl
  cleanTpl.split('\n').forEach((line, i) => {
    const noTags = line.replace(TAG, ' ')
    for (const seg of noTags.split('>')) {
      const text = seg.split('<')[0]
      if (CYR.test(text) && text.trim(' \t="\'')) hits.push(`${p}:~${i + 1} template text: ${text.trim().slice(0, 90)}`)
    }
    for (const m of cleanTpl ? line.matchAll(ATTR) : []) hits.push(`${p}:~${i + 1} attr ${m[1]}="${m[2].slice(0, 80)}"`)
  })

  const cleanScript = script
  cleanScript.split('\n').forEach((line, i) => {
    const l2 = line.replace(LINE_COMMENT, '')
    for (const m of l2.matchAll(STRING_LIT)) {
      if (CYR.test(m[1])) hits.push(`${p}:~${i + 1} string: ${m[1].slice(0, 90)}`)
    }
  })
}

if (hits.length > 0) {
  console.error(`no-cyrillic: ${hits.length} hit(s) outside locales/ -- move copy to a catalog (tz-i18n §4.6):\n`)
  for (const h of hits) console.error('  ' + h)
  process.exit(1)
}
console.log(`no-cyrillic: clean (${files.length} files scanned)`)
