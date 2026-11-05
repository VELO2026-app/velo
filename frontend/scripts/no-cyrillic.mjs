// tz-i18n §4.6 ratchet: zero Cyrillic outside locales/ (FE gate).
//
// Three checks:
//   (a) STRINGS/TEMPLATES -- no Cyrillic in string literals and Vue template
//       text/attrs outside locales/. Exemptions stay: *.test.ts (tests pin
//       rendered Russian copy on purpose, tz-i18n §4.5), utils/schoolBranding/
//       (the GOLDEN PORT of the school branding generator, tz-curator.md
//       §5.1/§5.3: ported as-is, same hash must yield the same SVG; the
//       monogram fallback letter U+0428 is a prototype constant, palette
//       display names live in locales/ru/schools.json), pwa/ (build-time
//       instance metadata, tz-whitelabel §3.1 exception registry) and
//       *.generated.ts (build output, not hand-written copy).
//   (b) COMMENTS -- zero Cyrillic in //, /* */, JSDoc, <!-- --> and CSS
//       comments across every scanned file INCLUDING tests and the string-
//       exempt dirs, plus scripts/*.mjs, vite.config.ts, eslint.config.js
//       and env.d.ts (docs/frontend-comments.md §1). Comment prose is
//       English only; src/api/generated.ts and *.generated.ts stay fully
//       excluded (their comments come from the OpenAPI generator).
//   (c) i18n REFERENCES -- every i18n:<dotted.key> marker in a comment must
//       resolve in the composed ru catalog (shallow spread over the
//       glob-sorted files, same composition as key-audit.mjs and
//       src/locales/index.ts). A typo'd or invented key is a lint error.
// Data that is locale-independent lives in locales/ru/* seed files
// (timezones.json, dates.json, languages.json) -- move literals there,
// never back into code. Exit 1 on any hit.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CYR = /[А-Яа-яЁё]/
const EXEMPT_DIRS = ['src/utils/schoolBranding', 'src/pwa']
const I18N_REF = /(?<![A-Za-z0-9_-])i18n:([A-Za-z0-9_.]+)/g
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

// Same walk as stripJsComments, but COLLECTS the comment bodies (with their
// start offsets for line numbers) instead of dropping them -- check (b)/(c)
// read the comments themselves.
function extractJsComments(src) {
  const comments = []
  let i = 0
  let quote = null
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      comments.push({ text: src.slice(i, j), at: i })
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      comments.push({ text: src.slice(i, j + 2), at: i })
      i = j + 2
      continue
    }
    i++
  }
  return comments
}

function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
}

// All comments of a source file: JS (quote-aware) for .ts/.js/.mjs and the
// script blocks of .vue; <!-- --> everywhere else in a .vue (SFC preamble
// headers included, nested slot <template #...> included); /* */ for
// <style> blocks and standalone .css. The lexer consumes an HTML comment
// before testing block tags, so a literal "<template>"/"<style>" WORD inside
// a comment never opens a block.
function vueCommentSpans(raw) {
  const out = []
  const openRe = /<(template|script|style)(?=[\s>])/g
  let i = 0
  const htmlComment = (at) => {
    const end = raw.indexOf('-->', at + 4)
    return end === -1 ? [raw.length, raw.slice(at)] : [end + 3, raw.slice(at, end + 3)]
  }
  while (i < raw.length) {
    openRe.lastIndex = i
    const o = openRe.exec(raw)
    const cAt = raw.indexOf('<!--', i)
    const oAt = o ? o.index : Infinity
    const cAtOrInf = cAt === -1 ? Infinity : cAt
    if (cAtOrInf < oAt) {
      const [next, text] = htmlComment(cAt)
      out.push({ text, at: cAt })
      i = next
      continue
    }
    if (oAt === Infinity) break
    const tag = o[1]
    const openEnd = raw.indexOf('>', oAt)
    if (openEnd === -1) break
    if (tag === 'script') {
      const close = raw.indexOf('</script>', openEnd)
      const end = close === -1 ? raw.length : close
      for (const c of extractJsComments(raw.slice(openEnd + 1, end)))
        out.push({ text: c.text, at: openEnd + 1 + c.at })
      i = close === -1 ? raw.length : close + 9
    } else if (tag === 'style') {
      const close = raw.indexOf('</style>', openEnd)
      const end = close === -1 ? raw.length : close
      for (const c of raw.slice(openEnd + 1, end).matchAll(/\/\*[\s\S]*?\*\//g))
        out.push({ text: c[0], at: openEnd + 1 + c.index })
      i = close === -1 ? raw.length : close + 8
    } else {
      // <template>: balanced scan to the matching close, collecting HTML
      // comments and counting nested slot <template> opens on the way
      let depth = 1
      let j = openEnd + 1
      while (j < raw.length && depth > 0) {
        const c2 = raw.indexOf('<!--', j)
        const o2 = /<template(?=[\s>])/.exec(raw.slice(j))
        const x2 = raw.indexOf('</template>', j)
        const c2At = c2 === -1 ? Infinity : c2
        const o2At = o2 ? j + o2.index : Infinity
        const x2At = x2 === -1 ? Infinity : x2
        if (c2At < o2At && c2At < x2At) {
          const [next, text] = htmlComment(c2)
          out.push({ text, at: c2 })
          j = next
        } else if (o2At < x2At) {
          depth++
          j = o2At + 9
        } else if (x2At < Infinity) {
          depth--
          j = x2At + 11
        } else break
      }
      i = j
    }
  }
  return out
}

function commentsOf(raw, isVue, isCss) {
  const out = []
  const lineOf = (at) => raw.slice(0, at).split('\n').length
  if (isVue) {
    out.push(...vueCommentSpans(raw))
  } else if (isCss) {
    for (const c of raw.matchAll(/\/\*[\s\S]*?\*\//g)) out.push({ text: c[0], at: c.index })
  } else {
    for (const c of extractJsComments(raw)) out.push({ text: c.text, at: c.at })
  }
  for (const c of out) c.line ??= lineOf(c.at)
  return out
}

// Composed ru catalog for check (c): shallow spread over the glob-sorted
// files, exactly like key-audit.mjs / src/locales/index.ts compose it.
const ruCatalog = {}
for (const f of readdirSync('src/locales/ru')
  .filter((f) => f.endsWith('.json'))
  .sort())
  Object.assign(ruCatalog, JSON.parse(readFileSync(join('src/locales/ru', f), 'utf8')))
function catalogResolves(path) {
  let node = ruCatalog
  for (const part of path.split('.')) {
    if (node == null || typeof node !== 'object' || !(part in node)) return false
    node = node[part]
  }
  return true
}

// -- file sets ------------------------------------------------------------------
// strings: src only, no tests, no string-exempt dirs, no generated output
// comments: src (tests and string-exempt dirs INCLUDED) + build scripts/configs
const isGenerated = (p) => p.endsWith('.generated.ts') || p === 'src/api/generated.ts'
const stringFiles = []
const commentFiles = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (p === 'src/locales') continue
      walk(p)
    } else if (/\.(ts|vue|css)$/.test(name)) {
      const normalized = p.replaceAll('\\', '/')
      if (isGenerated(normalized)) continue
      if (/\.css$/.test(name)) {
        commentFiles.push(p)
        continue
      }
      const exempt = EXEMPT_DIRS.some((dir) => normalized.startsWith(dir + '/'))
      // string check: tests and exempt dirs keep their Cyrillic strings on
      // purpose; comment check: same dirs are included -- only their STRING
      // exemptions stand, comment prose is English everywhere (FE-134)
      if (!name.includes('.test.') && !exempt) stringFiles.push(p)
      commentFiles.push(p)
    }
  }
}
// FE-116 (tz-ui-package.md §3.7): the walk also covers packages/velo-ui/src
// -- same rule for the UI kit, its copy lives in its own stories/tests in
// English. Exemptions above are frontend-src-relative and never match the
// ../packages/ prefix.
const roots = ['src', '../packages/velo-ui/src']
for (const r of roots) walk(r)
for (const name of readdirSync('scripts')) {
  const p = join('scripts', name)
  if (statSync(p).isFile() && name.endsWith('.mjs')) commentFiles.push(p)
}
for (const p of ['vite.config.ts', 'eslint.config.js', 'env.d.ts']) commentFiles.push(p)

const hits = []
for (const p of stringFiles) {
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
      if (CYR.test(text) && text.trim(' \t="\''))
        hits.push(`${p}:~${i + 1} template text: ${text.trim().slice(0, 90)}`)
    }
    for (const m of cleanTpl ? line.matchAll(ATTR) : [])
      hits.push(`${p}:~${i + 1} attr ${m[1]}="${m[2].slice(0, 80)}`)
  })

  const cleanScript = script
  cleanScript.split('\n').forEach((line, i) => {
    const l2 = line.replace(LINE_COMMENT, '')
    for (const m of l2.matchAll(STRING_LIT)) {
      if (CYR.test(m[1])) hits.push(`${p}:~${i + 1} string: ${m[1].slice(0, 90)}`)
    }
  })
}

// -- checks (b) and (c): comment language + i18n reference resolution ------------
const seenI18nFail = new Set()
for (const p of commentFiles) {
  const raw = readFileSync(p, 'utf8')
  const comments = commentsOf(raw, p.endsWith('.vue'), p.endsWith('.css'))
  for (const c of comments) {
    if (CYR.test(c.text)) {
      const snippet = c.text
        .replace(/^[/*]+/, '')
        .replace(/\*\/$/, '')
        .trim()
        .split('\n')[0]
        .replace(/^\* ?/, '')
        .slice(0, 90)
      hits.push(`${p}:~${c.line} comment: ${snippet}`)
    }
    for (const m of c.text.matchAll(I18N_REF)) {
      const key = m[1].replace(/[._]+$/, '')
      const dedupe = `${p}:${key}`
      if (!catalogResolves(key) && !seenI18nFail.has(dedupe)) {
        seenI18nFail.add(dedupe)
        hits.push(`${p}:~${c.line} i18n: "${key}" does not resolve in src/locales/ru`)
      }
    }
  }
}

if (hits.length > 0) {
  console.error(
    `no-cyrillic: ${hits.length} hit(s) outside locales/ -- move copy to a catalog (tz-i18n §4.6) or translate the comment (docs/frontend-comments.md §1):\n`,
  )
  for (const h of hits) console.error('  ' + h)
  process.exit(1)
}
console.log(
  `no-cyrillic: clean (${stringFiles.length} files scanned for strings, ${commentFiles.length} for comments)`,
)
