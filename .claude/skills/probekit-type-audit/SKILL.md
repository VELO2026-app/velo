---
name: probekit-type-audit
description: "TypeScript type-safety audit for Vue 3 + TS projects. Runs vue-tsc and ESLint, detects type errors, unsafe casts, and missing types, and auto-fixes common patterns. Use when checking TS type safety."
---

# type-audit v1.0.1

TypeScript type-safety audit for a Vue 3 + TS frontend.
Runs compiler checks, linter, and pattern analysis to find and fix type errors, unsafe casts, missing annotations, and generic constraint issues.

**Triggers:** `type check`, `check types`, `ts errors`, `typescript audit`, `type safety`, `/probekit-type-audit`, `пробкит типы`, `пробкит тайпскрипт`, `проверь типы`.

## Configuration

<!-- VELO-tuned (PROMPT №385, trial): CBS's mockups/frontend path replaced with
     VELO's actual frontend/ dir; docs/01_refer replaced with a git-untracked
     scratch dir (VELO has no docs/01_refer/). -->
review_dir: .tmp/probekit-review
source_dir: frontend/src
tsconfig: frontend/tsconfig.json

## Execution Steps

**Step 1 — Identify input and environment**

Determine scope:
- No path → audit entire `{{source_dir}}`
- File/directory path → scope to that target
- `--fix` flag (or "fix", "починь", "исправь") → set fix_mode = true
- `--strict` flag → treat all WARNINGs as CRITICALs

Check for ENVIRONMENT.md in the project (root or docs/01_refer/).
If found — read it for shell/tool pitfalls before executing commands.
(VELO note, PROMPT №385: no ENVIRONMENT.md in this repo -- shell is Windows
Git-Bash/PowerShell, no docker/VPS locally.)

Verify prerequisites:
1. `node_modules/` exists in `frontend/` — if not, run `npm install`
2. `tsconfig.json` exists — if not, STOP and report

**Step 2 — Compiler check (vue-tsc)**

Run `npx vue-tsc --noEmit` from `frontend/`.
Parse output into structured findings:
- Extract: file, line, error code (TSxxxx), message
- Group by file
- Classify each error (see `references/error-classification.md`)

If zero errors → record 💎 DIAMOND "Clean type check — zero compiler errors".

**Step 3 — ESLint type-aware rules**

Run `npx eslint --format json {{target}}` from `frontend/`.
Filter for type-related rules only:
- `@typescript-eslint/*` rules
- `no-unsafe-*`, `no-explicit-any`, `no-non-null-assertion`
- `vue/no-setup-props-destructure`, `vue/valid-*`

Parse JSON output, deduplicate with Step 2 findings (same file:line = one finding).

**Step 4 — Pattern scan**

Read `references/fix-patterns.md`.
Scan source files for common type-safety anti-patterns:

| # | Pattern | Severity | Detection |
|---|---------|----------|-----------|
| 4.1 | `as any` casts | 🟡 WARNING | Regex: `as any` excluding test files |
| 4.2 | `@ts-ignore` / `@ts-expect-error` without explanation | 🟡 WARNING | Regex: `@ts-ignore\|@ts-expect-error` not followed by `//` comment on same line |
| 4.3 | `!` non-null assertions (excessive) | 🟡 WARNING | Regex: `\w+!\.` or `\w+!\[` — flag if > 5 per file |
| 4.4 | Missing return types on exported functions | 🟢 SUGGESTION | AST: exported function without `: ReturnType` |
| 4.5 | `unknown` caught errors used without narrowing | 🔴 CRITICAL | `catch (e)` then `e.message` without `instanceof` check |
| 4.6 | Reactive generic misuse | 🟡 WARNING | `reactive<Generic>({})` indexing with `keyof` on non-reactive type |
| 4.7 | Missing Telegram/global type declarations | 🔴 CRITICAL | `window.X` access where X not declared in any `.d.ts` |
| 4.8 | Template scope leaks (Vue SFC) | 🔴 CRITICAL | Template uses global (URL, window, document) not exposed via setup |
| 4.9 | Untyped API responses | 🟡 WARNING | `api.get('/path')` without generic `<Type>` parameter |
| 4.10 | Generic constraint gaps | 🟡 WARNING | `keyof T` used to index `Reactive<Partial<Record<keyof T, ...>>>` |

**Step 5 — Produce report**

Read `references/output-template.md`.
Build scored report with sections:

1. **Compiler Errors** — vue-tsc findings grouped by file
2. **Lint Findings** — ESLint type-aware findings
3. **Pattern Scan** — anti-pattern detections from Step 4
4. **Summary** — totals, score, actionable next steps

Apply severity markers from `probekit-core/references/severity-format.md`.

For small scope (< 5 files): output inline in chat.
For large scope: save to `{{review_dir}}/TYPE-AUDIT-{target}-{YYYYMMDD}.md`.

**Step 5.5 — Update audit tracker**

Read or create `{{review_dir}}/AUDIT-TRACKER.md`.
Append entry with: skill=`type-audit`, key metric=`compiler_errors`.

**Step 6 — Fix mode (optional)**

If fix_mode is true:
Read `probekit-core/references/auto-fix-safety.md` — follow Safety Checklist and Fix-Verify-Revert Protocol.
1. Read `references/fix-patterns.md` for auto-fix recipes
2. Apply fixes in priority order (per core standard):
   - 🔴 CRITICAL: missing type declarations, unnarrrowed catches, template scope leaks
   - 🟡 WARNING: reactive generic fixes, `as any` replacements with proper types
   - Skip 🟢 SUGGESTION (too subjective)
3. After all fixes, re-run `npx vue-tsc --noEmit` to verify
4. If new errors introduced → revert last fix, mark as `NEEDS-MANUAL`
5. Report: "Applied N fixes. Compiler errors: before=X → after=Y"

If fix_mode is false — skip this step.

## Auto-Fix Patterns (Quick Reference)

| Pattern | Auto-fixable? | Fix strategy |
|---------|--------------|--------------|
| `error` of type `unknown` | ✅ Yes | Add `as Error` or `instanceof` guard |
| Missing `initData` on Telegram WebApp | ✅ Yes | Add property to global type declaration |
| `URL.createObjectURL` in Vue template | ✅ Yes | Wrap in setup helper function |
| `reactive<Partial<Record<keyof T>>>` indexing | ✅ Yes | Simplify to `Record<string, string>` |
| Generic mount options incompatibility | ✅ Yes | Widen to `any` for test helpers |
| `as any` in production code | ❌ Manual | Needs context to determine proper type |
| Missing return types | ❌ Manual | Needs understanding of function purpose |

## Quick Reference

Invoke:
- `/type-audit` — audit entire frontend source
- `/type-audit src/stores/` — audit specific directory
- `/type-audit --fix` — audit and auto-fix
- `/type-audit --fix src/composables/` — audit and fix specific directory
- `/type-audit --strict` — treat warnings as criticals

## Anchor

[*] type-audit v1.0.1 * ready
[>] | NEXT: user command
