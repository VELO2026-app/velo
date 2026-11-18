// FE-203: an inline ESLint directive must not switch the test rules off --
// `// eslint-disable-next-line velo-tests/no-fixed-sleep` would bypass the
// exception list without a trace. ESLint cannot police this itself: a
// directive that disables a rule also silences any report about it, so the
// check is a plain text scan run by scripts/lint-budget.mjs before ESLint.
// Caught in the linted test files: an eslint-disable* directive that names a
// velo-tests/ rule or names no rule at all (a blanket disable), and an
// `/* eslint velo-tests/...: off */` rule-config comment.

const DIRECTIVE = /(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?|eslint)(?=[\s*]|$)([^\n]*)/g

/**
 * Finds the directives in a source text that switch the test rules off.
 *
 * @param text - The file content.
 * @returns One entry per offending directive: its 1-based line and text.
 */
export function findRuleDisables(text) {
  const found = []
  for (const m of text.matchAll(DIRECTIVE)) {
    const [whole, kind, rest] = m
    // Drop the closing `*/` and the `-- reason` part ESLint allows.
    const body = rest
      .replace(/\*\/.*$/, '')
      .split(/\s--\s|\s--$/)[0]
      .trim()
    const offends =
      kind === 'eslint'
        ? body.includes('velo-tests/')
        : body === '' || body.split(',').some((r) => r.trim().startsWith('velo-tests/'))
    if (offends) {
      const line = text.slice(0, m.index).split('\n').length
      found.push({ line, text: whole.trim() })
    }
  }
  return found
}
