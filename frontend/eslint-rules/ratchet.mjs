// FE-203: the per-file exception list behind the test rules. A rule collects
// its findings for the whole file and decides at Program:exit, because the
// list holds an exact count per file, not a list of lines:
//   - more findings than the list allows: every finding is reported;
//   - exactly as many: the file passes (a known, counted debt);
//   - fewer: one error asks to lower the entry -- the list only shrinks.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root: list keys are repo-relative, so one list serves the
 * app (frontend/) and the kit (packages/velo-ui/) alike. */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The list file, named in messages (repo-relative). */
export const ALLOWLIST_PATH = 'frontend/eslint-rules/test-lint-allowlist.json'

/** Options schema shared by both rules: `{ allow: { [repoPath]: count } }`. */
export const RATCHET_SCHEMA = [
  {
    type: 'object',
    properties: {
      allow: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 1 },
      },
    },
    additionalProperties: false,
  },
]

/** The repo-relative POSIX path of the linted file (the list key). */
export function repoPath(filename) {
  return path.relative(REPO_ROOT, filename).split(path.sep).join('/')
}

/**
 * Collects a rule's findings for one file and reports them against the list.
 *
 * @param context - The rule context; its first option carries `allow`.
 * @param ruleId - The rule name as the list spells it (e.g. `no-fixed-sleep`).
 * @returns `add` records a finding; `exit` is the Program:exit handler.
 */
export function createRatchet(context, ruleId) {
  const allow = context.options[0]?.allow ?? {}
  const file = repoPath(context.filename)
  const allowed = allow[file] ?? 0
  const found = []
  return {
    add(descriptor) {
      found.push(descriptor)
    },
    exit() {
      if (found.length > allowed) {
        for (const d of found) context.report(d)
        return
      }
      if (found.length < allowed) {
        context.report({
          loc: { line: 1, column: 0 },
          messageId: 'shrinkAllowlist',
          data: {
            rule: ruleId,
            file,
            found: String(found.length),
            allowed: String(allowed),
            list: ALLOWLIST_PATH,
          },
        })
      }
    },
  }
}

/** The message every ratcheted rule carries for an over-generous entry. */
export const SHRINK_MESSAGE =
  '{{rule}}: {{found}} finding(s) in {{file}}, the exception list allows {{allowed}}. ' +
  'Lower the entry in {{list}} to {{found}} (remove it at 0): the list only shrinks.'
