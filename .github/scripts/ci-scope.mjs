#!/usr/bin/env node
// =============================================================================
// VELO CI -- scope: decide how much of the gate a pull request needs.
//
// Reads the PR's own diff (merge commit vs its first parent, so only what the
// PR contributes) and writes two outputs to $GITHUB_OUTPUT:
//
//   frontend = full | light | skip
//     full  -- install + lint + format + tests + builds + whitelabel matrix
//     light -- install + lint + format only (comment-only code edits: the
//              lint still polices comments -- no-cyrillic, doc-coverage --
//              and prettier still checks them)
//     skip  -- nothing in the PR can change the frontend gate's verdict
//   drift = true | false   -- run the generated.ts drift check
//
// Every file lands in exactly one class; the PR takes the strongest one.
//   docs          -- prose nobody executes: docs/**, diagrams/**,
//                    Design_prototype/**, and any *.md OUTSIDE frontend/ and
//                    packages/ (inside them a README can be a test input:
//                    packages/velo-ui/README.md carries the token contract).
//   comment-only  -- an M-status edit where every added/removed line is a
//                    comment line for that file type -> frontend light.
//   backend       -- backend/** -> drift (a docstring is an OpenAPI
//                    description, so even comment edits run it).
//   everything else -> frontend full. Unknown means full: the classifier
//                    may only ever make the gate SMALLER for files it
//                    positively recognises.
// The gate itself (ci.yml, this script) and generated.ts force everything.
//
// Outside pull_request (push to test) the caller does not run this script:
// the trunk always gets the full gate, which is also the backstop for any
// misclassification here.
//
// Node stdlib only; usage: node .github/scripts/ci-scope.mjs <base> <head>
// =============================================================================
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [base = 'HEAD^1', head = 'HEAD'] = process.argv.slice(2)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 })

const FORCE_ALL = [/^\.github\/workflows\/ci\.yml$/, /^\.github\/scripts\/ci-scope\.mjs$/, /^frontend\/src\/api\/generated\.ts$/]
const DOCS = [/^docs\//, /^diagrams\//, /^Design_prototype\//]
const CODE_TREES = /^(frontend|packages)\//

// Comment-line prefixes per extension. Deliberately narrow: `#` is NOT a
// comment in JS/TS (private fields), so it only counts for hash-comment files.
const SLASH = /^(\/\/|\/\*|\*\/|\*(\s|$)|<!--|-->)/
const HASH = /^#/
const COMMENT_BY_EXT = {
  js: SLASH, mjs: SLASH, cjs: SLASH, ts: SLASH, mts: SLASH, tsx: SLASH,
  vue: SLASH, css: SLASH, scss: SLASH,
  yml: HASH, yaml: HASH, sh: HASH, py: HASH, toml: HASH,
}

const isDocs = (f) => DOCS.some((re) => re.test(f)) || (f.endsWith('.md') && !CODE_TREES.test(f))

function isCommentOnly(file) {
  const re = COMMENT_BY_EXT[file.split('.').pop()]
  if (!re) return false
  const diff = git('diff', '-U0', '--no-color', base, head, '--', file)
  return diff
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    .map((l) => l.slice(1).trim())
    .every((l) => l === '' || re.test(l))
}

const RANK = { skip: 0, light: 1, full: 2 }
let frontend = 'skip'
let drift = false
const bump = (level) => { if (RANK[level] > RANK[frontend]) frontend = level }
const report = []

for (const row of git('diff', '--name-status', '--no-renames', base, head).split('\n').filter(Boolean)) {
  const [status, file] = row.split('\t')
  let cls
  if (FORCE_ALL.some((re) => re.test(file))) { cls = 'gate'; bump('full'); drift = true }
  else if (isDocs(file)) cls = 'docs'
  else if (file.startsWith('backend/')) { cls = 'backend'; drift = true }
  else if (status === 'M' && isCommentOnly(file)) { cls = 'comment-only'; if (CODE_TREES.test(file)) bump('light') }
  else { cls = 'code'; bump('full') }
  report.push(`${cls.padEnd(13)} ${status} ${file}`)
}

const summary = `frontend=${frontend} drift=${drift}`
console.log(report.join('\n') + `\n\n${summary}`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `frontend=${frontend}\ndrift=${drift}\n`)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### CI scope: \`${summary}\`\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`)
}
