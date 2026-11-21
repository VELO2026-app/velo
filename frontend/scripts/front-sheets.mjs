#!/usr/bin/env node
// =============================================================================
// FE-224 -- the Figma mirror sheets ("Front" pages) vs code (docs/figma-protocol.md §8)
// =============================================================================
//
// Which mirror sheets in Figma a change touches, and which sheets went stale.
// Reads git only (never Figma, never the working tree): the code at --ref and
// the sheet manifest frontend/design/figma-front-sheets.json. Mapping rules:
// scripts/lib/front-sheets.mjs.
//
// MODES
//   --pr <n>                 files of a GitHub PR (gh). Code ref: the merge
//                            commit of a merged PR, else origin/deploy-machine.
//   --files <a,b,...>        an explicit list of changed files
//   --base <ref> [--head <ref>]  files of `git diff base...head` (head: --ref)
//   --stale <inventory.json> weekly check: every sheet's c2f:commit vs --ref.
//                            The inventory is what `c2fInventory()` (skill
//                            code-to-figma-pixel-perfect, figma-lib.js) returns.
//   --write-manifest <inventory.json>  regenerate the manifest from Figma.
//
// OPTIONS
//   --ref <git ref>          code version to read (default origin/deploy-machine)
//   --manifest <file>        manifest file (default: the manifest at
//                            --manifest-ref, origin/deploy-machine)
//   --repo <dir>             repository root (default: git top level of cwd)
//   --json                   machine output
//   --notes                  list the manifest notes (moved / missing sources)
//
// Exit codes: 0 done (an empty list is a result) · 1 error.
// Run `git fetch origin` first: the script reads refs, it does not fetch.
// =============================================================================

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  affectedSheets,
  createGraph,
  staleSheets,
  toManifest,
  GRAPH_ROOTS,
} from './lib/front-sheets.mjs'

const MANIFEST_PATH = 'frontend/design/figma-front-sheets.json'
const DEFAULT_REF = 'origin/deploy-machine'

function parseArgs(argv) {
  const a = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--json') a.json = true
    else if (k === '--notes') a.notes = true
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i]
    else throw new Error(`unexpected argument: ${k}`)
  }
  return a
}

const git = (repo, args, opts = {}) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, ...opts })

function tryGit(repo, args) {
  try {
    return git(repo, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** The repo at `ref`: file list + contents of the graph's source files (one cat-file batch). */
function gitRepo(repo, ref) {
  const list = git(repo, [
    'ls-tree',
    '-r',
    '--name-only',
    ref,
    '--',
    'frontend',
    'packages/velo-ui',
  ])
  const files = new Set(list.split('\n').filter(Boolean))
  const wanted = [...files].filter(
    (f) => GRAPH_ROOTS.some((r) => f.startsWith(r)) && /\.(vue|[cm]?[jt]s|css|scss)$/.test(f),
  )
  const buf = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: wanted.map((f) => `${ref}:${f}`).join('\n') + '\n',
    maxBuffer: 256 << 20,
  })
  const contents = new Map()
  let pos = 0
  for (const f of wanted) {
    const nl = buf.indexOf(10, pos)
    const header = buf.subarray(pos, nl).toString()
    pos = nl + 1
    if (header.endsWith(' missing')) continue
    const size = Number(header.split(' ')[2])
    contents.set(f, buf.subarray(pos, pos + size).toString('utf8'))
    pos += size + 1
  }
  return { files, read: (p) => (contents.has(p) ? contents.get(p) : null) }
}

function loadManifest(repo, a) {
  if (a.manifest) return JSON.parse(readFileSync(a.manifest, 'utf8'))
  const ref = a['manifest-ref'] || DEFAULT_REF
  const raw = tryGit(repo, ['show', `${ref}:${MANIFEST_PATH}`])
  if (raw === null) throw new Error(`no ${MANIFEST_PATH} at ${ref}: pass --manifest <file>`)
  return JSON.parse(raw)
}

function prInfo(repo, n) {
  const out = execFileSync(
    'gh',
    ['pr', 'view', String(n), '--json', 'number,title,state,files,mergeCommit'],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  )
  const pr = JSON.parse(out)
  return {
    files: pr.files.map((f) => f.path),
    ref: pr.state === 'MERGED' && pr.mergeCommit ? pr.mergeCommit.oid : null,
    label: `PR #${pr.number} (${pr.state.toLowerCase()}): ${pr.title}`,
  }
}

function printAffected(r, label, ref, verbose) {
  const lines = [`${label}`, `code: ${ref}`]
  if (!r.sheets.length) lines.push('No mirror sheets to update.')
  else lines.push(`${r.sheets.length} sheet(s) to resnap:`)
  for (const s of r.sheets) {
    lines.push(`- ${s.page} / ${s.name}  [${s.key}]  node ${s.id}`)
    for (const f of s.reasons) lines.push(`    ${f}`)
  }
  if (r.tokens) {
    lines.push(
      'Tokens changed: bring the Figma variables to tokens.json first (drift: scripts/sync-figma-variables.mjs --snapshot), then the sheets above.',
    )
  }
  if (r.screensWithoutSheet.length)
    lines.push(`Screens changed without a sheet (no action): ${r.screensWithoutSheet.join(', ')}`)
  lines.push(...noteLines(r.notes, verbose))
  console.log(lines.join('\n'))
}

/** Manifest notes: a count by default (a moved source still maps), the list with --notes. */
function noteLines(notes, verbose) {
  if (!notes.length) return []
  if (verbose) return ['Manifest notes:', ...notes.map((n) => `  ${n}`)]
  const moved = notes.filter((n) => n.includes('source moved')).length
  return [
    `Manifest notes: ${moved} moved source(s) (mapped by file name), ${notes.length - moved} not found; --notes lists them.`,
  ]
}

function printStale(r, ref) {
  const lines = [`code: ${ref}`]
  const list = (title, items, fmt) => {
    lines.push(`${title}: ${items.length}`)
    for (const s of items) lines.push(`- ${fmt(s)}`)
  }
  list(
    'stale (code changed after the capture)',
    r.stale,
    (s) =>
      `${s.page} / ${s.name} [${s.key}] node ${s.id} since ${s.commit}: ${s.reasons.join(', ')}`,
  )
  list(
    'unknown (cannot tell)',
    r.unknown,
    (s) => `${s.page} / ${s.name} [${s.key}] node ${s.id}: ${s.why}`,
  )
  list(
    'edited by hand (seal broken)',
    r.edited,
    (s) => `${s.page} / ${s.name} [${s.key}] node ${s.id}`,
  )
  lines.push(`fresh: ${r.fresh.length}; not mirroring code: ${r.notMirroring.length}`)
  if (r.drift.length) list('manifest drift', r.drift, (d) => d)
  console.log(lines.join('\n'))
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  const repo = a.repo || git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()

  if (a['write-manifest']) {
    const inv = JSON.parse(readFileSync(a['write-manifest'], 'utf8'))
    const m = toManifest(inv, new Date().toISOString().slice(0, 10))
    writeFileSync(join(repo, MANIFEST_PATH), JSON.stringify(m, null, 2) + '\n')
    console.log(`wrote ${MANIFEST_PATH}: ${m.sheets.length} sheets`)
    return
  }

  if (a.stale) {
    const ref = a.ref || DEFAULT_REF
    const inv = JSON.parse(readFileSync(a.stale, 'utf8'))
    let manifest
    try {
      manifest = loadManifest(repo, a)
    } catch {
      manifest = null // the drift check is skipped, the stale check still runs
    }
    const changedSince = (commit) => {
      if (tryGit(repo, ['cat-file', '-e', `${commit}^{commit}`]) === null) return null
      return git(repo, ['diff', '--name-only', commit, ref]).split('\n').filter(Boolean)
    }
    const r = staleSheets(inv, manifest, gitRepo(repo, ref), changedSince)
    if (!manifest) r.drift.push('manifest not found: drift not checked')
    if (a.json) console.log(JSON.stringify({ ref, ...r }, null, 2))
    else printStale(r, ref)
    return
  }

  let files
  let label
  let ref = a.ref
  if (a.pr) {
    const pr = prInfo(repo, a.pr)
    files = pr.files
    label = pr.label
    ref = ref || pr.ref || DEFAULT_REF
  } else if (a.files) {
    files = a.files
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    label = `${files.length} file(s)`
  } else if (a.base) {
    const head = a.head || a.ref || DEFAULT_REF
    files = git(repo, ['diff', '--name-only', `${a.base}...${head}`])
      .split('\n')
      .filter(Boolean)
    label = `${a.base}...${head}`
  } else {
    throw new Error('pass --pr <n>, --files, --base or --stale (see the header of this file)')
  }
  ref = ref || DEFAULT_REF
  const code = gitRepo(repo, ref)
  const r = affectedSheets(files, loadManifest(repo, a), code, createGraph(code))
  if (a.json) console.log(JSON.stringify({ label, ref, ...r }, null, 2))
  else printAffected(r, label, ref, a.notes !== undefined)
}

try {
  main()
} catch (e) {
  console.error(`front-sheets: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
