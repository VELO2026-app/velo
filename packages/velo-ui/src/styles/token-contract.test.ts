// =============================================================================
// @velo/ui -- token contract test (FE-116, tz-ui-package.md §3.6)
// =============================================================================
//
// The package consumes the HOST's tokens and owns none (принцип 2: токены
// не уезжают). A component referencing a token the host does not declare
// breaks silently for every second consumer -- this suite makes that break
// loud, in the shape of the frontend's styles/token-law.test.ts:
//
//   1. every var(--…) used in package styles must sit in the package's
//      CONTRACT -- the machine-readable block in README.md below;
//   2. every var(--…) used must be DECLARED in the golden build's
//      variables.css (the contract is an allowance, not a substitute);
//   3. the TIER rule (§7.3): package components consume semantic and
//      component-level tokens only. The primitive color ramp
//      (--velo-teal|peach|pink|blue|sand-NNN, --velo-white) and raw values
//      (hex -- stylelint color-no-hex is the first layer) are forbidden.
//      The README contract is the allowlist, so a primitive never enters it;
//      this check keeps the mistake readable instead of "not in contract".
//   4. contract hygiene: every README entry must itself exist in the golden
//      variables.css -- a phantom allowance is a contract bug.
//
// The golden variables.css is read by a pinned relative path (skin-blind,
// the b91e259f law: never a materialized skin, always the golden source).
// The two families come from the frozen naming rule at the top of that
// file: --velo-* and the bare scale tokens (--space/--radius/--shadow/
// --z/--font/--size/--transition) -- the bare names are frozen, not
// unified (PROMPT №437).
//
// Files are read from DISK off the package root, not through import.meta:
// vitest rewrites import.meta.url to an http scheme and hands CSS module
// ids back EMPTY through the ?raw pipeline (measured; the frontend's
// placeholder-contrast.test.ts reads its token canon the same way).
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_ROOT = process.cwd()
const README = readFileSync(resolve(PKG_ROOT, 'README.md'), 'utf8')
const GOLDEN_CSS = readFileSync(
  resolve(PKG_ROOT, '../../frontend/src/styles/variables.css'),
  'utf8',
)

/** The package's style carriers: *.vue SFC <style> blocks (the CSS strategy,
 * §3.3) plus any standalone *.css under src/. Colocized tests and stories
 * are not style carriers. */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkSources(p, out)
    else if (/\.(vue|css)$/.test(name)) out.push(p)
  }
  return out
}

const SOURCE_FILES = walkSources(resolve(PKG_ROOT, 'src'))

/** The fenced block in README.md that carries the contract, one token per
 * line (a trailing comment after # is allowed). The block IS the tier rule:
 * only semantic/component tokens may be listed in it. */
const CONTRACT_FENCE = /```velo-ui-token-contract\n([\s\S]*?)```/

const DECLARED = /(--[a-zA-Z0-9-]+)\s*:/g

/** The primitive color ramp (variables.css «VELΘ: Primitive palette» and
 * friends): raw palette steps a component must not consume directly -- it
 * takes the semantic role built on top of them instead. */
const PRIMITIVE_RAMP = /^--velo-(teal|peach|pink|blue|sand)-\d+$/

/** Ramp/white tokens carried VERBATIM by components that migrated as-is
 * (FE-117 batch A, tz-ui-package.md §3.3/§4 P2: styles travel unchanged, and
 * these usages pre-date the semantic layer -- several variants have no
 * semantic role to this day). Semanticizing them means NEW host tokens, which
 * is a token-owner ruling (the PROMPT №437 line), not a migration edit. The
 * list is exact and closed: every token NOT on it still fails the tier rule,
 * and entries leave this set only in the PR that retires the usage. */
const LEGACY_MIGRATED_RAMP = new Set([
  '--velo-blue-100',
  '--velo-peach-700',
  '--velo-pink-100',
  '--velo-pink-300',
  '--velo-sand-100',
  '--velo-teal-600',
  '--velo-white',
])

function declaredTokens(css: string): Set<string> {
  const out = new Set<string>()
  for (const match of css.matchAll(DECLARED)) {
    const token = match[1]
    if (token) out.add(token)
  }
  return out
}

function contractTokens(readme: string): Set<string> {
  const block = readme.match(CONTRACT_FENCE)?.[1]
  if (!block) throw new Error('token contract: README.md carries no velo-ui-token-contract block')
  return new Set(
    block
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean),
  )
}

/** Strip CSS block comments so a commented-out var(--…) is not counted as
 * a dependency; a var( inside a string literal does not exist in CSS. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function usedTokens(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  for (const path of SOURCE_FILES) {
    const rel = path.slice(PKG_ROOT.length + 1)
    for (const match of stripCssComments(readFileSync(path, 'utf8')).matchAll(
      /var\(\s*(--[a-zA-Z0-9-]+)/g,
    )) {
      const token = match[1]
      if (token) used.set(token, [...(used.get(token) ?? []), rel])
    }
  }
  return used
}

describe('token contract (tz-ui-package.md §3.6)', () => {
  it('the extractor works: comments hide tokens, declarations do not', () => {
    // Self-test of the harness -- a gate that cannot fire is decoration.
    const css = [
      '/* var(--velo-old-token) removed */', //
      '.a { color: var(--velo-live-token); }',
      '.b { padding: var(--space-2, 8px); }',
    ].join('\n')
    const stripped = stripCssComments(css)
    expect([...stripped.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1])).toEqual([
      '--velo-live-token',
      '--space-2',
    ])
    expect(declaredTokens('--velo-a: 1px; var(--velo-b)')).toEqual(new Set(['--velo-a']))
  })

  it('the harness sees the codebase: styles, contract, golden tokens', () => {
    // A walk that matched nothing would silently pass every check below.
    expect(SOURCE_FILES.some((p) => p.endsWith('src/components/VButton/VButton.vue'))).toBe(true)
    // Sanity floors, not exact pins: the golden file grows additively (its
    // header's frozen count is dated). If these ever fail, the golden path
    // or the naming convention broke -- not the token count.
    const golden = declaredTokens(GOLDEN_CSS)
    expect([...golden].filter((t) => t.startsWith('--velo-')).length).toBeGreaterThanOrEqual(200)
    expect([...golden].filter((t) => !t.startsWith('--velo-')).length).toBeGreaterThanOrEqual(25)
    expect(contractTokens(README).size).toBeGreaterThanOrEqual(1)
  })

  it('every var(--…) used by the package sits in the README contract', () => {
    const contract = contractTokens(README)
    const violations: string[] = []
    for (const [token, paths] of usedTokens()) {
      if (!contract.has(token)) violations.push(`${token} (used in ${paths.join(', ')})`)
    }
    expect(violations).toEqual([])
  })

  it('every var(--…) used by the package is declared in the golden variables.css', () => {
    const golden = declaredTokens(GOLDEN_CSS)
    const violations: string[] = []
    for (const [token, paths] of usedTokens()) {
      if (!golden.has(token)) violations.push(`${token} (used in ${paths.join(', ')})`)
    }
    expect(violations).toEqual([])
  })

  it('tier rule (§7.3): the primitive color ramp stays out of components', () => {
    // The README allowlist already excludes primitives; this check exists
    // so the failure names the rule, not just "not in contract". The ONLY
    // exemptions are the exact legacy tokens carried verbatim by components
    // migrated as-is (LEGACY_MIGRATED_RAMP above) -- a new primitive still
    // fails here even if someone pastes it into the README.
    const violations: string[] = []
    for (const token of contractTokens(README)) {
      if (
        (PRIMITIVE_RAMP.test(token) || token === '--velo-white') &&
        !LEGACY_MIGRATED_RAMP.has(token)
      ) {
        violations.push(`${token}: primitive tier -- use the semantic role instead`)
      }
    }
    expect(violations).toEqual([])
  })

  it('the README contract itself carries no phantom tokens', () => {
    const golden = declaredTokens(GOLDEN_CSS)
    const violations: string[] = []
    for (const token of contractTokens(README)) {
      if (!golden.has(token))
        violations.push(`${token}: listed in README, absent from variables.css`)
    }
    expect(violations).toEqual([])
  })
})
