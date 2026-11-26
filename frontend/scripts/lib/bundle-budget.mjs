// =============================================================================
// VELO Frontend -- bundle budget rules (FE-183)
// =============================================================================
// Pure rules behind `bundle-report --budget` and the `bundle-budget-guard` CI
// job; no I/O, so node:test pins them (bundle-budget.test.mjs). Policy and the
// agent rule: docs/agents/bundle.md.
//
// Two kinds of limit live in frontend/bundle-budget.json (bytes, 1 kB = 1000 B
// as Vite prints it):
//
//   ceiling  -- the FE-157 targets (150 kB gzip app chunk, 1 MB precache;
//               150 kB gzip for the whole startup JS too, FE-169).
//               A hard limit with no tolerance: a build above it always fails.
//               Raising it needs the `bundle-ceiling` label (the owner's).
//   budget   -- the floating baseline (entryGzip, precacheBytes, startupGzip:
//               the gzip of every JS file the first open loads -- the entry,
//               its modulepreloads, their static imports; FE-169, Rolldown
//               spreads the start over host + app + runtime). A build may
//               sit within +-2% of it. Above: fail. Below by more than 2%: fail
//               with the value to lower the budget to, so a saving is locked
//               in the same PR instead of becoming headroom for the next
//               growth. Raising it needs the `bundle-growth` label.
//   skinned  -- the same two budgets for a build WITH a skin package (FE-230):
//               the core is neutral and every instance ships a package, so
//               the production size is the skinned one (the package's photo
//               and font join the precache). Same window, same ceiling, same
//               label rule. `package` names the package it was measured with.
//
// The label rule is checked by the guard job from the budget file of the base
// branch and of the head, without a build (checkBudgetRaise).
// =============================================================================

/** The floating budget may be exceeded, or undershot, by this many percent. */
export const TOLERANCE_PCT = 2

/** Headroom, in percent, kept above the real size when suggesting a lowered budget. */
export const LOWER_HEADROOM_PCT = 1

/**
 * The FE-157 targets in bytes: what a base branch without a `ceiling` is
 * taken to have, so introducing a higher ceiling is still a raise.
 */
export const DEFAULT_CEILING = { entryGzip: 150000, precacheBytes: 1000000, startupGzip: 150000 }

/** Label that allows raising the floating budget. */
export const GROWTH_LABEL = 'bundle-growth'

/** Label that allows raising the ceiling; the owner puts it. */
export const CEILING_LABEL = 'bundle-ceiling'

/** The two measured metrics: budget key, ceiling key, human name. */
export const METRICS = [
  { key: 'entryGzip', name: 'app chunk gzip' },
  { key: 'precacheBytes', name: 'precache bytes' },
  { key: 'startupGzip', name: 'startup JS gzip' },
]

/** Command that finds what grew; printed on every failure. */
export const MODULES_HINT = 'node frontend/scripts/bundle-report.mjs --modules'

/** Format bytes in Vite's own unit (kB = 1000 bytes) so numbers match the build log. */
export function kb(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`
}

/** Signed delta of `actual` against `base`: "+1.20 kB (+0.8%)". */
export function delta(actual, base) {
  const diff = actual - base
  const pct = base === 0 ? 0 : (diff / base) * 100
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '±'
  return `${sign}${(Math.abs(diff) / 1000).toFixed(2)} kB (${sign}${Math.abs(pct).toFixed(1)}%)`
}

/**
 * Validate a parsed bundle-budget.json.
 *
 * @throws When a budget or ceiling value is not a positive finite number.
 */
export function assertBudgetShape(budget, where = 'bundle-budget.json') {
  for (const { key } of METRICS) {
    if (!Number.isFinite(budget?.[key]) || budget[key] <= 0) {
      throw new Error(`${where}: no positive numeric ${key}`)
    }
    if (!Number.isFinite(budget.ceiling?.[key]) || budget.ceiling[key] <= 0) {
      throw new Error(`${where}: no positive numeric ceiling.${key}`)
    }
    if (
      budget.skinned !== undefined &&
      (!Number.isFinite(budget.skinned?.[key]) || budget.skinned[key] <= 0)
    ) {
      throw new Error(`${where}: no positive numeric skinned.${key}`)
    }
  }
}

/**
 * The budget a build is checked against: the core line, or the `skinned`
 * line for a build with a skin package (FE-230). Both share the ceiling.
 *
 * @param budget - Parsed bundle-budget.json (must pass assertBudgetShape).
 * @param skinned - Whether the build carried a skin package.
 */
export function budgetFor(budget, skinned) {
  if (!skinned) return budget
  if (budget.skinned === undefined)
    throw new Error('a build with a skin package, but the budget file has no `skinned` line')
  return { ...budget.skinned, ceiling: budget.ceiling, line: 'skinned' }
}

/**
 * The budget to suggest for a build of `actual` bytes: the real size plus
 * LOWER_HEADROOM, rounded up to a whole byte. It lands inside the +-2% window,
 * so the suggestion never trips the gate again.
 */
export function suggestBudget(actual) {
  // Integer math: `actual * 1.01` would round-trip through floats.
  return Math.ceil((actual * (100 + LOWER_HEADROOM_PCT)) / 100)
}

/**
 * Check a build against the ceiling and the floating budget.
 *
 * @param sizes - Measured `{ entryGzip, precacheBytes, startupGzip }`; precacheBytes is null when dist/ has no sw.js.
 * @param budget - Parsed bundle-budget.json (must pass assertBudgetShape).
 * @param [base] - Measured sizes of the base branch build; omitted when unknown.
 * @returns Markdown summary and the failures (empty = within budget).
 */
export function checkBudget(sizes, budget, base) {
  const failures = []
  const rows = []
  for (const { key, name } of METRICS) {
    const actual = sizes[key]
    const ceiling = budget.ceiling[key]
    const value = budget[key]
    const upper = Math.floor((value * (100 + TOLERANCE_PCT)) / 100)
    const lower = Math.ceil((value * (100 - TOLERANCE_PCT)) / 100)
    const vsBase = base && Number.isFinite(base[key]) ? delta(actual ?? 0, base[key]) : 'n/a'
    if (actual === null || actual === undefined) {
      failures.push(`${name}: not measured (no sw.js in dist/)`)
      rows.push(
        `| ${name} | ${kb(value)} | n/a | n/a | ${vsBase} | ceiling ${kb(ceiling)} | FAIL |`,
      )
      continue
    }
    const problems = []
    if (actual > ceiling) {
      problems.push(
        `${name} ${kb(actual)} is over the ceiling ${kb(ceiling)}; the ceiling can be raised only in a PR labeled \`${CEILING_LABEL}\` (the owner puts it)`,
      )
    }
    if (actual > upper) {
      problems.push(
        `${name} ${kb(actual)} is over the budget ${kb(value)} by more than ${TOLERANCE_PCT}% (limit ${kb(upper)}); find what grew first, raising the budget needs the \`${GROWTH_LABEL}\` label`,
      )
    } else if (actual < lower) {
      problems.push(
        `${name} ${kb(actual)} is below the budget ${kb(value)} by more than ${TOLERANCE_PCT}%: lower the budget to ${suggestBudget(actual)} (${budget.line ? `${budget.line}.` : ''}${key} in frontend/bundle-budget.json)`,
      )
    }
    failures.push(...problems)
    rows.push(
      `| ${name} | ${kb(value)} | ${kb(actual)} | ${delta(actual, value)} | ${vsBase} | ceiling ${kb(ceiling)}, window ${kb(lower)}..${kb(upper)} | ${problems.length ? 'FAIL' : 'ok'} |`,
    )
  }
  const md = [
    `### Bundle budget${budget.line ? ` (${budget.line} build${budget.package ? `, ${budget.package}${budget.tag ? ` ${budget.tag}` : ''}` : ''})` : ''}: ${failures.length ? 'FAIL' : 'ok'}`,
    '',
    '| metric | budget | actual | vs budget | vs base | gate | status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...failures.map((f) => `- ${f}`),
    ...(failures.length
      ? [
          '',
          `What grew: \`${MODULES_HINT}\` (runs its own build, add \`--find <regex>\` to locate a module).`,
        ]
      : []),
  ].join('\n')
  return { md, failures }
}

/**
 * Compare the budget file of the base branch with the one of the head: any
 * raised value needs its label.
 *
 * @param baseBudget - Parsed bundle-budget.json of the base branch, or null when it has none.
 * @param headBudget - Parsed bundle-budget.json of the head.
 * @param labels - Names of the labels on the PR.
 * @returns The failures (empty = nothing raised without its label).
 * @remarks A base without a ceiling is taken to have DEFAULT_CEILING (the
 * FE-157 targets): introducing exactly those is no raise, a higher one is. A ceiling value removed in the head counts as a raise to
 * infinity, so deleting it cannot bypass the label.
 */
export function checkBudgetRaise(baseBudget, headBudget, labels) {
  const failures = []
  if (!baseBudget) return failures
  const has = (label) => labels.includes(label)
  for (const { key } of METRICS) {
    const before = baseBudget[key]
    const after = headBudget?.[key]
    if (
      Number.isFinite(before) &&
      !(Number.isFinite(after) && after <= before) &&
      !has(GROWTH_LABEL)
    ) {
      failures.push(
        `${key} raised ${Number.isFinite(after) ? `${before} -> ${after}` : `${before} -> (removed)`} without the \`${GROWTH_LABEL}\` label. Find what grew first (${MODULES_HINT}); the label is put by a human.`,
      )
    }
    const skinnedBefore = baseBudget.skinned?.[key]
    const skinnedAfter = headBudget?.skinned?.[key]
    if (
      Number.isFinite(skinnedBefore) &&
      !(Number.isFinite(skinnedAfter) && skinnedAfter <= skinnedBefore) &&
      !has(GROWTH_LABEL)
    ) {
      failures.push(
        `skinned.${key} raised ${Number.isFinite(skinnedAfter) ? `${skinnedBefore} -> ${skinnedAfter}` : `${skinnedBefore} -> (removed)`} without the \`${GROWTH_LABEL}\` label. Find what grew first (${MODULES_HINT}); the label is put by a human.`,
      )
    }
    const ceilBefore = baseBudget.ceiling?.[key] ?? DEFAULT_CEILING[key]
    const ceilAfter = headBudget?.ceiling?.[key]
    if (
      Number.isFinite(ceilBefore) &&
      !(Number.isFinite(ceilAfter) && ceilAfter <= ceilBefore) &&
      !has(CEILING_LABEL)
    ) {
      failures.push(
        `ceiling.${key} raised ${Number.isFinite(ceilAfter) ? `${ceilBefore} -> ${ceilAfter}` : `${ceilBefore} -> (removed)`} without the \`${CEILING_LABEL}\` label; only the owner puts it.`,
      )
    }
  }
  return failures
}
