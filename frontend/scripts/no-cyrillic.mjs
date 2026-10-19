// tz-i18n §4.6 ratchet: zero Cyrillic outside locales/ (FE gate).
//
// Scans src/**/*.{ts,vue} for Cyrillic inside STRING LITERALS and Vue template
// TEXT NODES / attribute values, after stripping comments. Excluded:
//   - locales/  (the catalogs themselves are the point of the rule)
//   - *.test.ts (tests pin rendered Russian copy on purpose, tz-i18n §4.5)
// Data that is locale-independent lives in locales/ru/* seed files
// (timezones.json, dates.json, languages.json, schools.json branding.*) --
// move literals there, never back into code. Exit 1 on any hit.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CYR = /[А-Яа-яЁё]/
const LINE_COMMENT = /\/\/.*/g
const BLOCK_COMMENT = /\/\*.*?\*\//gs
const HTML_COMMENT = /<!--.*?-->/gs
const TAG = /<[^>]+>/g
const STRING_LIT = /(`[^`\n]*`|'[^'\n]*'|"[^"\n]*")/g
const ATTR = /([\w:-]+)="([^"]*[А-Яа-яЁё][^"]*)"/g

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
      files.push(p)
    }
  }
}
for (const r of roots) walk(r)

const hits = []
for (const p of files) {
  const src = readFileSync(p, 'utf8')
  // Vue: template text nodes + attribute values; script: string literals.
  const tplMatch = src.match(/<template>([\s\S]*)<\/template>\s*(<script|$)/)
  const scriptMatch = src.match(/<script[^>]*>([\s\S]*)<\/script>/)
  const tpl = tplMatch ? tplMatch[1] : ''
  const script = scriptMatch ? scriptMatch[1] : ''

  const cleanTpl = tpl.replace(HTML_COMMENT, (m) => '\n'.repeat(m.split('\n').length - 1))
  cleanTpl.split('\n').forEach((line, i) => {
    const noTags = line.replace(TAG, ' ')
    for (const seg of noTags.split('>')) {
      const text = seg.split('<')[0]
      if (CYR.test(text) && text.trim(' \t="\'')) hits.push(`${p}:~${i + 1} template text: ${text.trim().slice(0, 90)}`)
    }
    for (const m of cleanTpl ? line.matchAll(ATTR) : []) hits.push(`${p}:~${i + 1} attr ${m[1]}="${m[2].slice(0, 80)}"`)
  })

  const cleanScript = script.replace(BLOCK_COMMENT, '')
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
