// =============================================================================
// FE-150 -- token usage audit: which registry tokens are consumed, which are
// dead, which are rare (tz-whitelabel §3.3; it drove the Gen-2 reduction).
// =============================================================================
// The registry is tokens.json (the source; variables.css is generated from
// it). A token is ALIVE when at least one of these holds:
//   direct    its name appears in product code (src/, packages/velo-ui/src)
//             OUTSIDE comments -- var(--name), and the by-name reads
//             tokenColor('--velo-tg-bg', ...) / getPropertyValue('--velo-fog-z1')
//             count the same way, since the name is a literal;
//   dynamic   product code builds the name at runtime from a literal prefix
//             (`--velo-fog-pd-${name}`): every token under that prefix is
//             treated as consumed -- the reason a var()-only count reported
//             ~15 false zeros on 06.11. A prefix that covers more than
//             MAX_DYNAMIC tokens (`--velo-${x}`) would switch the audit off
//             for a whole branch: it keeps nothing alive and is a violation
//             (name the tokens literally);
//   chain     an ALIVE token's value references it (var(--velo-blue-500)
//             inside --velo-bg-subtle). Liveness is transitive: a primitive
//             referenced only by dead aliases is dead too.
// Tests and stories are counted apart (their name builders too): a token
// only a test names is dead in the product. Everything else scanned counts as
// product, .storybook config included. Skin packages live outside this repo (FE-131) and only
// OVERRIDE tokens -- validate-skin warns when one sets a $deprecated token.
//
// Comments are stripped first, per language: a token named in prose is not
// consumed (and a CSS comment closed with "-->" instead of "*/" swallows the
// rule after it -- the scanner sees that exactly as the browser does).
// Because comments matter here, a comment-only edit can kill a consumer:
// the CI scope runs lint-only for such PRs, the full gate on the push to
// test is the backstop.
//
// $deprecated (DTCG) is accepted in one shape only: a non-empty string on a
// TOKEN ("<date>: <why>, delete in <generation>"); the generator, the audit
// and validate-skin all read that string. Any other shape -- `true`, an
// empty string, a flag on a GROUP -- is a violation, so the three never
// disagree about what is deprecated.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { collectLeaves } from './figma-token-sync.mjs'

// --- comment stripping --------------------------------------------------------

/** Blank a matched span but keep its newlines (line numbers stay stable). */
const blank = (s) => s.replace(/[^\n]/g, ' ')

/** CSS: only block comments exist; // is NOT a comment (url(https://...)). */
export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?(\*\/|$)/g, blank)
}

/** HTML/template: <!-- --> comments. */
export function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?(-->|$)/g, blank)
}

/**
 * JS/TS: // and block comments, quote-aware (the no-cyrillic.mjs discipline --
 * a regex stripper once ate half a file on a "/api/v1/x/*" string). String
 * contents stay byte-identical: tokenColor('--velo-tg-bg') must survive.
 */
export function stripJsComments(src) {
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
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      out += blank(src.slice(i, j))
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      out += blank(src.slice(i, j + 2))
      i = j + 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** SFC: script blocks as JS, style blocks as CSS, the rest as template. */
export function stripVueComments(src) {
  // Top-level blocks only: the tags start a line (a "<style>" quoted in a
  // template comment must not open a block).
  const BLOCK = /^(<(script|style)\b[^>]*>)([\s\S]*?)^(<\/\2>)/gm
  let out = ''
  let last = 0
  for (const m of src.matchAll(BLOCK)) {
    out += stripHtmlComments(src.slice(last, m.index))
    const body = m[2] === 'script' ? stripJsComments(m[3]) : stripCssComments(m[3])
    out += m[1] + body + m[4]
    last = m.index + m[0].length
  }
  return out + stripHtmlComments(src.slice(last))
}

/** Strip comments by file extension; unknown extensions pass through. */
export function stripComments(file, src) {
  if (file.endsWith('.vue')) return stripVueComments(src)
  if (file.endsWith('.css')) return stripCssComments(src)
  if (file.endsWith('.html')) return stripHtmlComments(src)
  if (/\.(m?[jt]s|tsx?)$/.test(file)) return stripJsComments(src)
  return src
}

// --- audit --------------------------------------------------------------------

/** Tests and stories: they name tokens, they do not ship them. */
export const isNonProduct = (file) => /\.(test|spec|stories)\.[^/]+$/.test(file)

const NAME = /--[a-zA-Z0-9_-]+/g
/** A dynamic prefix wider than this is not a name builder but a blanket. */
export const MAX_DYNAMIC = 12

/** The DTCG $deprecated note of a token node, or null (see the header). */
export function deprecationOf(node) {
  const d = node?.$deprecated
  return typeof d === 'string' && d.trim() !== '' ? d : null
}
/** `--velo-fog-pd-${x}` -> '--velo-fog-pd-' (template-literal name builders). */
const DYNAMIC = /(--[a-zA-Z0-9_-]+-)\$\{/g

/**
 * Audit the registry against the scanned files.
 *
 * @param {object} doc parsed tokens.json
 * @param {Array<{file: string, src: string}>} files product + test sources
 *   (NOT variables.css -- it is the generated registry itself)
 * @returns {Array<object>} one row per token, registry order:
 *   { cssName, path, value, deprecated, badDeprecated, prod, test, files,
 *     dynamic, refs, referrers, alive }; the array also carries
 *   `broadDynamic`: [{ prefix, files, covers }] for the refused blankets.
 */
export function auditTokens(doc, files) {
  const leaves = collectLeaves(doc)
  const rows = new Map(
    leaves.map((l) => [
      l.cssName,
      {
        cssName: l.cssName,
        path: l.path,
        value: l.value.trim(),
        deprecated: deprecationOf(l.node) ?? false,
        badDeprecated: '$deprecated' in l.node && deprecationOf(l.node) === null,
        prod: 0,
        test: 0,
        files: new Set(),
        dynamic: false,
        refs: [...l.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]),
        referrers: [],
        alive: false,
      },
    ]),
  )

  const dynamicFiles = new Map() // prefix -> Set(file), product code only
  for (const { file, src } of files) {
    const code = stripComments(file, src)
    const nonProduct = isNonProduct(file)
    if (!nonProduct)
      for (const m of code.matchAll(DYNAMIC)) {
        if (!dynamicFiles.has(m[1])) dynamicFiles.set(m[1], new Set())
        dynamicFiles.get(m[1]).add(file)
      }
    for (const m of code.matchAll(NAME)) {
      const row = rows.get(m[0])
      if (!row) continue
      if (nonProduct) row.test++
      else {
        row.prod++
        row.files.add(file)
      }
    }
  }

  const names = [...rows.keys()]
  const broadDynamic = []
  const dynamicPrefixes = []
  for (const [prefix, where] of dynamicFiles) {
    const covers = names.filter((n) => n.startsWith(prefix)).length
    if (covers > MAX_DYNAMIC) broadDynamic.push({ prefix, files: [...where], covers })
    else dynamicPrefixes.push(prefix)
  }
  for (const row of rows.values()) {
    row.dynamic = dynamicPrefixes.some((p) => row.cssName.startsWith(p))
    for (const ref of row.refs) rows.get(ref)?.referrers.push(row.cssName)
  }

  // Liveness: seed with directly/dynamically consumed tokens, then follow
  // var() chains from alive tokens down to their primitives.
  const queue = [...rows.values()].filter((r) => r.prod > 0 || r.dynamic)
  for (const r of queue) r.alive = true
  while (queue.length > 0) {
    const r = queue.pop()
    for (const ref of r.refs) {
      const target = rows.get(ref)
      if (target && !target.alive) {
        target.alive = true
        queue.push(target)
      }
    }
  }

  const out = [...rows.values()]
  out.broadDynamic = broadDynamic
  return out
}

/**
 * The standing rules the guard test pins (FE-150):
 *   - a $deprecated token has NO consumer (the next generation can delete it);
 *   - every other token is alive (no new dead weight in the contract);
 *   - $deprecated has the one accepted shape, on tokens only (pass `doc`);
 *   - no dynamic name builder blankets a whole branch.
 */
export function auditViolations(rows, doc) {
  const out = []
  for (const b of rows.broadDynamic ?? []) {
    out.push(
      `a dynamic name builder \`${b.prefix}\${…}\` in ${b.files.join(', ')} would cover ${b.covers} tokens -- name them literally (MAX_DYNAMIC ${MAX_DYNAMIC})`,
    )
  }
  if (doc) {
    const walkGroups = (node, path) => {
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('$') || !value || typeof value !== 'object') continue
        const here = path ? `${path}.${key}` : key
        if (!('$value' in value) && '$deprecated' in value)
          out.push(`${here}: $deprecated on a group -- mark the tokens, one by one`)
        walkGroups(value, here)
      }
    }
    walkGroups(doc.root, '')
  }
  for (const r of rows) {
    if (r.badDeprecated)
      out.push(
        `${r.cssName}: $deprecated must be a non-empty string ("<date>: <why>, delete in <generation>")`,
      )
    if (r.deprecated && r.alive) {
      const how =
        r.prod > 0
          ? [...r.files].join(', ')
          : r.dynamic
            ? 'a dynamic name builder'
            : 'an alive var() chain'
      out.push(
        `${r.cssName} is $deprecated but consumed by ${how} -- migrate the consumer, the next generation deletes the token`,
      )
    }
    if (!r.deprecated && !r.alive) {
      out.push(
        `${r.cssName} has no consumer -- use it, or mark it $deprecated in tokens.json (the next generation removes it, tz-whitelabel §3.1)`,
      )
    }
  }
  return out
}

// --- the real tree ----------------------------------------------------------------

const SCANNED = /\.(vue|css|html|m?[jt]s|tsx?)$/

function walk(dir, out) {
  const st = statSync(dir, { throwIfNoEntry: false })
  if (!st) return out
  if (st.isFile()) {
    if (SCANNED.test(dir)) out.push(dir)
    return out
  }
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'storybook-static') continue
    walk(join(dir, entry), out)
  }
  return out
}

/**
 * Read the registry and every consumer of it from a checkout.
 *
 * @param {string} frontendDir absolute path of frontend/
 * @returns {{doc: object, files: Array<{file: string, src: string}>}}
 *   file paths relative to frontendDir; the generated registry
 *   (styles/variables.css) and the cascade stub (styles/skin-tokens.css,
 *   overwritten by a skin package at build) are not consumers.
 */
export function readTree(frontendDir) {
  const doc = JSON.parse(readFileSync(join(frontendDir, 'tokens.json'), 'utf8'))
  const roots = [
    join(frontendDir, 'src'),
    join(frontendDir, 'index.html'),
    join(frontendDir, '..', 'packages', 'velo-ui', 'src'),
    join(frontendDir, '..', 'packages', 'velo-ui', '.storybook'),
  ]
  const NOT_CONSUMERS = new Set(['src/styles/variables.css', 'src/styles/skin-tokens.css'])
  const files = roots
    .flatMap((r) => walk(r, []))
    .map((abs) => relative(frontendDir, abs))
    .filter((f) => !NOT_CONSUMERS.has(f))
    .map((file) => ({ file, src: readFileSync(join(frontendDir, file), 'utf8') }))
  return { doc, files }
}
