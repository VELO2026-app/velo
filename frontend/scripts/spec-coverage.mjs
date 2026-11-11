// FE-147: spec-coverage gate -- every invariant section of the repo-root
// tz-*.md specs is referenced by at least one executing artifact
// (source, gate script or test). Same mechanics as doc-coverage (FE-139).
//
// Anchors: a numbered heading of a tz-*.md file ("## 4. Title",
// "### 4.6. Title") yields the anchor id `<doc>#<number>`, e.g. `tz-i18n#4.6`.
// A heading carrying the literal marker `(info)` is descriptive (no
// invariant) and is skipped by the gate. Unnumbered headings are not
// anchors (tz-practice-analytics.md has none and is effectively out of scope
// until it is numbered).
//
// References: the text "tz-<doc> §<number>" (optionally "tz-<doc>.md §..")
// in frontend/src/**, frontend/scripts/** (this file excluded). A reference
// to a subsection also covers its ancestors (a ref to 3.1 covers 3).
//
// Findings:
//   - uncovered  -- invariant section with no reference. Allowed only while
//                   listed in spec-coverage.baseline.json (ratchet);
//   - dangling   -- a reference to an anchor that no longer exists in the
//                   tz file (renamed/removed heading = lost anchor). Never
//                   baselined;
//   - stale baseline -- a baseline entry that is now covered, marked (info)
//                   or gone. The budget only shrinks: remove the entry.
//
// Resolution of an uncovered section (spec owner's choice): add the
// executing artifact that cites it, or mark the heading (info).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(here, '..')
const repoRoot = join(frontendRoot, '..')
const baselinePath = join(here, 'spec-coverage.baseline.json')
const selfPath = fileURLToPath(import.meta.url)

// 1. anchors from tz-*.md
const anchors = new Map() // id -> { info, line }
for (const name of readdirSync(repoRoot).filter((n) => /^tz-.*\.md$/.test(n))) {
  const doc = name.replace(/\.md$/, '')
  const lines = readFileSync(join(repoRoot, name), 'utf8').split('\n')
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) return
    const m = /^#{2,6}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line)
    if (!m) return
    anchors.set(`${doc}#${m[1]}`, { info: line.includes('(info)'), line: i + 1 })
  })
}

// 2. references from sources
const SCAN_EXT = /\.(ts|tsx|mts|cts|vue|mjs|cjs|js|css|json)$/
const refs = new Map() // id -> first "file" that cites it
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (SCAN_EXT.test(name) && p !== selfPath && !p.endsWith('spec-coverage.baseline.json')) {
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\b(tz-[a-z0-9-]+?)(?:\.md)?`?[ \t]*§\s?(\d+(?:\.\d+)*)/g)) {
        const id = `${m[1]}#${m[2]}`
        if (!refs.has(id)) refs.set(id, relative(frontendRoot, p))
      }
    }
  }
}
walk(join(frontendRoot, 'src'))
walk(here)

// covered = referenced ids + all their ancestors
const covered = new Set()
for (const id of refs.keys()) {
  const [doc, num] = id.split('#')
  const parts = num.split('.')
  for (let n = 1; n <= parts.length; n++) covered.add(`${doc}#${parts.slice(0, n).join('.')}`)
}

// 3. findings
// tz docs that exist in the repo; refs to other (absent) docs are out of scope
// Docs cited from code but not (yet) anchored here: not in the repo, or
// unnumbered. Every OTHER tz-* ref must resolve -- a renamed/deleted file or a
// typo in the doc name is a lost anchor too.
const EXTERNAL_DOCS = new Set(['tz-mood-scale', 'tz-practice-analytics'])
const dangling = [...refs]
  .filter(([id]) => !EXTERNAL_DOCS.has(id.split('#')[0]) && !anchors.has(id))
  .map(([id, file]) => `${id} (cited in ${file})`)

const uncovered = [...anchors]
  .filter(([id, a]) => !a.info && !covered.has(id))
  .map(([id]) => id)
  .sort()

const baseline = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')).uncovered ?? [])
  : []
const baselineSet = new Set(baseline)
const regress = uncovered.filter((id) => !baselineSet.has(id))
const stale = baseline.filter((id) => !uncovered.includes(id))

// --write-baseline: ratchet-safe by default (keeps only entries that are still
// uncovered, never grows); --allow-grow is for the initial run only.
if (process.argv.includes('--write-baseline')) {
  if (dangling.length) {
    console.error('spec-coverage: fix dangling references first:\n  ' + dangling.join('\n  '))
    process.exit(1)
  }
  const next = process.argv.includes('--allow-grow')
    ? uncovered
    : uncovered.filter((id) => baselineSet.has(id))
  writeFileSync(baselinePath, JSON.stringify({ uncovered: next }, null, 2) + '\n')
  console.log(`spec-coverage: baseline written (${next.length} uncovered)`)
  process.exit(0)
}

let failed = false
const fail = (title, list) => {
  failed = true
  console.error(`spec-coverage: ${title}:\n`)
  for (const l of list) console.error('  ' + l)
  console.error('')
}
if (dangling.length)
  fail('reference(s) to a section that no longer exists in tz-*.md (anchor lost)', dangling)
if (regress.length)
  fail(
    'invariant section(s) with no executing artifact -- cite as "tz-<doc> §N" in a test/gate/source, or mark the heading (info)',
    regress,
  )
if (stale.length)
  fail(
    'stale entries in spec-coverage.baseline.json (now covered, marked (info) or removed) -- delete them, the budget only shrinks',
    stale,
  )
if (failed) process.exit(1)

const total = [...anchors.values()].filter((a) => !a.info).length
console.log(
  `spec-coverage: ok (${total} invariant sections, ${total - uncovered.length} covered, ${uncovered.length} in baseline)`,
)
