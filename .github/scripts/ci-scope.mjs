#!/usr/bin/env node
// =============================================================================
// VELO CI -- scope: decide how much of the gate a pull request -- or a push
// -- needs.
//
// Reads the PR's own diff (merge commit vs its first parent, so only what the
// PR contributes) -- or, for a push, the range the push brought (FE-187, see
// PUSH below) -- and writes four outputs to $GITHUB_OUTPUT:
//
//   frontend = full | light | skip
//     full  -- install + lint + format + tests + builds + whitelabel matrix
//     light -- install + lint + format only (comment-only code edits: the
//              lint still polices comments -- no-cyrillic, doc-coverage --
//              and prettier still checks them)
//     skip  -- nothing in the PR can change the frontend gate's verdict
//   drift = true | false   -- run the generated.ts drift check
//   docker = true | false  -- build the frontend image + smoke it (FE-159)
//   visual = true | false  -- the PR touches what the screens are drawn from
//                             (FE-162): styles, tokens, velo-ui, public
//                             assets, the lockfile
//
// Every file lands in exactly one class; the PR takes the strongest one.
//   docs          -- prose nobody executes: docs/**, diagrams/**,
//                    Design_prototype/**, and any *.md OUTSIDE frontend/ and
//                    packages/ (inside them a README can be a test input:
//                    packages/velo-ui/README.md carries the token contract).
//   spec          -- root tz-*.md: executable contracts (FE-147), the lint's
//                    spec-coverage gate parses their headings -> frontend light.
//   comment-only  -- an M-status edit where every added/removed line is a
//                    comment line for that file type -> frontend light.
//   backend       -- backend/** -> drift (a docstring is an OpenAPI
//                    description, so even comment edits run it).
//   everything else -> frontend full. Unknown means full: the classifier
//                    may only ever make the gate SMALLER for files it
//                    positively recognises.
// The gate itself (ci.yml, this script, its test) and generated.ts force
// everything.
//
// docker is a separate axis, by path alone (a comment in the Dockerfile or
// nginx.conf counts): the files the image build reads that the other jobs
// never exercise -- frontend/Dockerfile, frontend/nginx*, frontend/vite.config.ts, editions.json, the
// lockfile, pnpm-workspace.yaml, the workspace manifests, .dockerignore and
// the smoke script. A PR without them does not pay for an image build.
//
// PUSH (FE-187): `--push <before> <sha>` classifies everything the push
// brought, before..sha -- a push can carry several commits (a batch) -- with
// the same classes as a pull request. When that range cannot be trusted the
// push gets the full gate, as every push did before FE-187:
//   - no before (all zeros: a new branch);
//   - before not in the history the caller fetched;
//   - before not an ancestor of sha (a forced push: the range would be a
//     difference between two unrelated heads, not what was pushed).
// The caller fetches the whole history for a push (ci.yml, scope job), so a
// fast-forward of any length resolves.
// WHAT THIS GIVES UP: before FE-187 every push ran the full gate, so the
// trunk was the backstop for a misclassification here. Now a push is sized
// like a pull request and that backstop is gone; the classifier's own test
// (ci-scope.test.mjs, run by the scope job) is what stands in for it.
//
// Node stdlib only; usage:
//   node .github/scripts/ci-scope.mjs <base> <head>
//   node .github/scripts/ci-scope.mjs --push <before> <sha>
// =============================================================================
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const push = argv[0] === '--push'
const [base = 'HEAD^1', head = 'HEAD'] = push ? argv.slice(1) : argv
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
// A yes/no question to git: exit 0 is yes, anything else no (stderr quiet).
const gitOk = (...args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const FORCE_ALL = [
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/scripts\/ci-scope\.mjs$/,
  /^\.github\/scripts\/ci-scope\.test\.mjs$/,
  /^frontend\/src\/api\/generated\.ts$/,
]
const DOCS = [/^docs\//, /^diagrams\//, /^Design_prototype\//]
const CODE_TREES = /^(frontend|packages)\//
// FE-162: paths that can change how a screen looks -> the visual comparison.
const VISUAL = [
  /^frontend\/src\/styles\//,
  /^frontend\/src\/.*variables\.css$/,
  /^packages\/velo-ui\//,
  /^frontend\/public\//,
  /^pnpm-lock\.yaml$/,
]
const DOCKER = [
  /^frontend\/Dockerfile$/,
  /^frontend\/nginx/, // nginx.conf and nginx/ (template, entrypoint scripts)
  /^frontend\/vite\.config\.ts$/, // emits manifest.<locale>.webmanifest that 40-manifest-locale.sh copies
  /^editions\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^(frontend\/|packages\/[^/]+\/)?package\.json$/,
  /^\.dockerignore$/,
  /^\.github\/scripts\/docker-smoke\.mjs$/,
]

// Comment-line prefixes per extension. Deliberately narrow: `#` is NOT a
// comment in JS/TS (private fields), so it only counts for hash-comment files.
const SLASH = /^(\/\/|\/\*|\*\/|\*(\s|$)|<!--|-->)/
const HASH = /^#/
const COMMENT_BY_EXT = {
  js: SLASH, mjs: SLASH, cjs: SLASH, ts: SLASH, mts: SLASH, tsx: SLASH,
  vue: SLASH, css: SLASH, scss: SLASH,
  yml: HASH, yaml: HASH, sh: HASH, py: HASH, toml: HASH,
}

const SPEC = /^tz-[^/]+\.md$/
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

function write(summary, report) {
  console.log(report.join('\n') + `\n\n${summary}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, summary.split(' ').join('\n') + '\n')
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### CI scope: \`${summary}\`\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`)
  }
}

// PUSH (header): why the range before..head cannot be trusted, or null.
function pushRangeProblem() {
  if (/^0+$/.test(base)) return 'no before (a new branch)'
  if (!gitOk('cat-file', '-e', `${base}^{commit}`)) return `before ${base} is not in the fetched history`
  if (!gitOk('merge-base', '--is-ancestor', base, head)) return `before ${base} is not an ancestor of ${head} (a forced push)`
  return null
}

if (push) {
  const problem = pushRangeProblem()
  if (problem) {
    write('frontend=full drift=true docker=true visual=true', [`push range not classified: ${problem} -> the full gate`])
    process.exit(0)
  }
}

const RANK = { skip: 0, light: 1, full: 2 }
let frontend = 'skip'
let drift = false
let docker = false
let visual = false
const bump = (level) => { if (RANK[level] > RANK[frontend]) frontend = level }
const report = []

for (const row of git('diff', '--name-status', '--no-renames', base, head).split('\n').filter(Boolean)) {
  const [status, file] = row.split('\t')
  if (DOCKER.some((re) => re.test(file))) docker = true
  if (VISUAL.some((re) => re.test(file))) visual = true
  let cls
  if (FORCE_ALL.some((re) => re.test(file))) { cls = 'gate'; bump('full'); drift = true; docker = true }
  else if (SPEC.test(file)) { cls = 'spec'; bump('light') }
  else if (isDocs(file)) cls = 'docs'
  else if (file.startsWith('backend/')) { cls = 'backend'; drift = true }
  else if (status === 'M' && isCommentOnly(file)) { cls = 'comment-only'; if (CODE_TREES.test(file)) bump('light') }
  else { cls = 'code'; bump('full') }
  report.push(`${cls.padEnd(13)} ${status} ${file}`)
}

write(`frontend=${frontend} drift=${drift} docker=${docker} visual=${visual}`, report)
