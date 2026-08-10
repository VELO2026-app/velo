---
name: probekit-integration-test
description: "Integration test generator and runner. Reads API, DB, and service layers — generates real test files, runs them, fixes failures, reports results. Triggers on: 'write integration tests', 'test my API', 'test the database layer', 'integration tests', '/probekit-integration-test', or when reviewing code at service boundaries. Always use when the user provides file paths to services, routes, repositories, or DB modules and asks to test them, 'пробкит интеграция'."
---

# integration-test v1.1.0

Generates, runs, and verifies integration tests for API layers, database layers,
and service boundaries. Produces passing test files and a scored coverage report.

## Configuration

<!-- VELO-tuned (PROMPT №402): same fix as probekit-unit-test -- no tests/
     directory exists in this repo; every test is colocated next to its
     source. report_dir matches the other 6 VELO-tuned skills. -->
test_output_dir: colocated -- same directory as the source file, *.test.ts suffix. NOT a separate tree.
report_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Identify input and environment**

Parse the input:
- Path with focus hint (e.g. `/integration-test src/api/ -- focus on error paths`) →
  path is everything before `--`; text after is a focus hint,
  apply it as additional attention during analysis and test generation (not a filter — still run all sections)
- `--run-only` flag → set run_only = true; skip Steps 2–4 entirely; go directly to Step 5
- `--fix` flag (or "fix", "починь", "исправь") → set fix_mode = true; remove flag from path before proceeding
- If both `--run-only` and `--fix` provided → treat as `--run-only` (nothing to fix if nothing generated)
- Inline code in chat → use directly
- No input → ask: "What would you like to test? Provide a path to a service, route handler, or repository."

Detect environment (read ENVIRONMENT.md if present, else auto-detect):
- Language and version (Python, JS/TS, Go, Java, etc.)
- Test framework (pytest, jest, go test, JUnit, etc.)
- DB engine in use (SQLite, PostgreSQL, MySQL, etc.)
- Shell type (PowerShell, bash, zsh) — critical for correct command syntax
- Existing test structure (find tests/ or __tests__/ or *_test.go patterns)
- Existing conftest.py / jest.config / test helpers → reuse, don't duplicate

**Step 2 — Analyse the target** *(skip if run_only = true)*

Read `references/analysis-sections.md`.
Execute all 6 analysis sections in order to understand what tests to generate.
This is a read-only analysis pass — no files written yet.

**Step 3 — Plan test suite** *(skip if run_only = true)*

Based on analysis output, produce a test plan:
- List every test case with: name, what it tests, expected outcome, required fixtures
- Group by: API tests / DB tests / Contract tests / Error path tests / Failure injection tests
- Identify shared fixtures needed (db setup, client factory, seed data)
- Identify what to mock vs what to use real (managed deps: DB real; unmanaged: external APIs mocked)
- If API has known consumers → recommend contract compliance tests (Pattern 9)
- If service calls external APIs → include failure injection tests (Pattern 8)

**Destructive DB setup** means: tests that DROP tables, run migrations, or modify the DB schema.
In-memory SQLite with CREATE TABLE is not destructive — it's isolated per test.

Show the plan to the user as a numbered list before generating.
Wait for confirmation only if plan exceeds 20 test cases or requires destructive DB setup.
Otherwise proceed automatically.

**Step 4 — Generate test files** *(skip if run_only = true)*

Read `references/test-patterns-db.md` and `references/test-patterns-api-service.md`.
Generate test files following detected project conventions.

File placement rules:
- Match existing test structure if found
- Otherwise use: `{{test_output_dir}}/test_[module_name].py` (or language equivalent) — for a
  colocated `test_output_dir` (VELO/TS): `[module_name].test.ts` in the SAME directory as the source.
- Always generate `conftest.py` (or equivalent) for shared fixtures if not already present
- Never overwrite existing test files — append or create versioned file (`test_[module]_v2.py`)

Every generated test must:
- Have a clear docstring: what it tests and why
- Use proper setup/teardown (fixtures, not bare setUp/tearDown)
- Clean up after itself (rollback transactions, delete created records, close connections)
- Test the real DB when possible — use in-memory/temp DB, not mocks, for DB layer tests
- Mock only unmanaged dependencies (external HTTP APIs, email services, payment gateways) — for
  VELO/Vitest frontend-layer integration tests specifically, the "unmanaged dependency" is the backend
  API itself: mock at `@/api/client` (or the relevant `@/api/*.ts` wrapper) via `vi.mock(seam, async
  (importOriginal) => ({ ...await importOriginal(), api: { get: vi.fn(), ... } }))`, keeping real error
  classes importable. See `frontend/src/stores/auth.test.ts` for a multi-seam example (client + two
  wrapper modules + two unrelated store/composable mocks).
- Include both happy path AND at least one failure/edge case per endpoint or function

**Step 5 — Run tests and iterate**

Execute tests using the detected test command.
PowerShell: use single quotes for pytest -k patterns.
If run_only = true: run all tests in `{{test_output_dir}}`.
If run_only = false: run only the newly generated test files.
Capture full output including tracebacks.

On failure:
1. Read the traceback — identify root cause (wrong fixture, bad import, schema mismatch, etc.)
2. Fix the test file (not the source code — we test, not modify production)
3. Re-run
4. Repeat up to 3 iterations per failing test; maximum 15 fix iterations total across all tests
5. If still failing after limit: mark as BLOCKED, document root cause, continue

If fix_mode = true: apply fixes aggressively within the iteration limit.
If fix_mode = false: attempt 1 auto-fix pass, then mark BLOCKED if still failing.

**Step 6 — Produce report**

Read `references/output-template.md`.
Build final integration test report.
Save to `{{report_dir}}` using filename:
- Single file input: `INT-TEST-[basename-without-extension]-[YYYYMMDD].md`
- Directory input: `INT-TEST-[dirname]-[YYYYMMDD].md`
- Multiple files: `INT-TEST-[first-basename]+[N-more]-[YYYYMMDD].md`

Adapt language to the user's language.

**Step 6.5 — Update audit tracker**

Read or create `{{report_dir}}/INTEGRATION-TEST-TRACKER.md`.
Append entry: date, files tested, tests generated, pass/fail counts, coverage estimate, delta.

## Quick Reference

See `references/user-guide.md` for installation and usage examples.

## Anchor

[*] integration-test v1.1.0 * ready
[>] | NEXT: user command
