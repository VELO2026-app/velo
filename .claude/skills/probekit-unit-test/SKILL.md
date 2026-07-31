---
name: probekit-unit-test
description: "Generate, run, and verify unit tests for any module, class, or function. Finds untested paths, generates tests with mocks and fixtures, runs them, fixes failures, and produces a coverage report. Use when: writing tests for new code, adding tests to untested legacy code, or auditing quality of existing tests. Triggers on: 'write tests', 'generate tests', 'покрой тестами', 'напиши тесты', '/probekit-unit-test', or when code is provided with no explicit instruction but testing context is implied, 'пробкит юнит', 'пробкит тесты'."
---

# unit-test v1.3.0

Generate, run, and verify unit tests. Produces working tests — not templates.
Iterates until tests pass. Delivers a coverage report and test quality summary.

## Configuration

<!-- VELO-tuned (PROMPT №402): the CBS defaults below assumed a separate
     tests/ tree and a single top-level src/ -- neither holds here. VELO
     colocates every test next to its source (src/api/payments.ts ->
     src/api/payments.test.ts) -- all 13 existing tests follow this, zero
     live under a tests/ directory. This is a stronger fix than a path swap:
     it changes WHERE generated files go, not just which path they go under.
     See Step 2/3 below for the naming + mocking idiom stage 1/2 established. -->
test_output_dir: colocated -- same directory as the source file, *.test.ts suffix. NOT a separate tree.
source_dir: frontend/src
report_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Identify input, environment, and mode**

Determine what to test:
- File/directory path → read with bash, detect language and framework
- Path with focus hint (e.g. `/unit-test src/services/ -- focus on edge cases`) →
  path is everything before `--` or `—`; text after is a focus hint
- `--analyze` flag (or words "analyze tests", "анализ тестов") →
  set analyze_mode = true; runs coverage + quality analysis without generating new tests
- `--audit` flag (or words "audit tests", "проверь тесты", "оцени тесты",
  "проверь качество тестов", "оцени мои тесты") →
  set audit_mode = true
- `--coverage-only` flag → set coverage_only = true
- Inline code → use directly, assume project root as working directory
- No input → ask: "What would you like me to test? Provide a file path, class, or paste the code."

**Mode routing — decide here, before any further steps:**
- analyze_mode = true → proceed to Step 2, then Step 2.5, then Step 5. Skip Steps 3, 4.
- audit_mode = true → proceed to Step 2-AUDIT, then Step 5.5. Skip Steps 3, 4, 5.
- coverage_only = true → proceed to Step 2-COVERAGE, then Step 5. Skip Steps 3, 4.
- default → proceed through all steps in order.

If `ENVIRONMENT.md` exists anywhere in the project — read it before executing any commands.
Use its shell/tool notes to avoid known pitfalls. Never hardcode shell syntax; adapt to detected environment.

Detect framework by scanning project files in this order:
- `pytest.ini`, `pyproject.toml [tool.pytest]`, `setup.cfg [tool:pytest]` → pytest
- `package.json` with "jest" or "vitest" → Jest/Vitest
- `go.mod` → Go testing
- `addons/gut/` directory or `.gut_editor_config` → GUT (Godot/GDScript)
- No markers found → infer from file extensions and imports

Read `references/framework-adapters.md` for the detected framework before proceeding.

**Step 2 — Analyze code under test** *(default and coverage_only mode)*

Read the target file(s) completely. Map:
- Public API surface: all public functions, methods, classes
- Dependencies: imports, injected objects, global state, I/O, DB, network calls
- Boundary map: what must be mocked vs what can be tested directly
- Existing test files: for a colocated `test_output_dir` (VELO), check the SAME directory as the
  source file first (`{module}.test.ts` next to `{module}.ts`); fall back to common test locations
  (`tests/`, `test/`, `__tests__/`, `*_test.go`, `test_*.gd`) for other project layouts
  — never re-generate tests that already exist; extend instead

For each public function/method identify:
1. Happy path — normal inputs, expected output
2. Edge cases — empty, None/null/nil, zero, negative, max value, empty collections
3. Error paths — expected exceptions, invalid types, boundary violations
4. Async paths — if function is async, mark for async test pattern

Skip: private methods (test via public API), trivial getters/setters with no logic,
auto-generated boilerplate.

**Step 2.5 — Coverage + Quality Analysis** *(default and analyze_mode)*

Read `references/test-quality-probes.md`.
Run 5 test quality probes (TQ-1 through TQ-5) against existing test files:
- TQ-1: Assertion Density — tests with zero or single assertions
- TQ-2: Mock Fidelity — mocks that diverge from real interface signatures
- TQ-3: Test Independence — tests that depend on execution order or shared mutable state
- TQ-4: Boundary Coverage — edge cases (null, empty, overflow, negative) tested
- TQ-5: Error Path Coverage — exception/error branches exercised

For each probe: scan test files, count violations, assign severity, score 0-10.
Produce quality sub-score alongside coverage metrics in the final report.

**Step 2-AUDIT — Analyze existing test files** *(audit_mode only)*

Read all test files in the provided path completely.
Do NOT analyze source code — the subject is the tests themselves.
Map: test file names, test function names, assertion patterns, fixture usage, mock usage.
Then proceed directly to Step 5.5.

**Step 3 — Generate test file(s)** *(default mode only)*

Read `references/test-generation.md`.
Apply `references/framework-adapters.md` for detected framework syntax.

For each file under test, generate one test file:
- Naming: `test_{module}.py` / `{module}_test.go` / `test_{module}.gd` etc. — for a colocated
  `test_output_dir` (VELO/TS): `{module}.test.ts`, e.g. `payments.ts` -> `payments.test.ts`.
- Location: mirror source structure inside `test_output_dir` — for a colocated `test_output_dir`
  (VELO/TS): the SAME directory as the source file, no mirrored tree.
- Structure: group tests by class/function using test classes or describe blocks

Every generated test MUST:
- Follow AAA (Arrange / Act / Assert) structure with comments
- Have a descriptive name: `test_{function}_{scenario}_{expected_outcome}`
  Example: `test_calculate_price_with_zero_quantity_raises_value_error`
- Mock all external boundaries (DB, HTTP, file I/O, time, random) — for VELO/Vitest specifically:
  mock at the module seam the code under test actually imports (`@/api/client` for wrapper functions,
  the relevant `@/api/*.ts` wrapper for a Pinia store), via `vi.mock(seam, async (importOriginal) => ({
  ...await importOriginal(), api: { get: vi.fn(), post: vi.fn(), ... } }))` so real error classes
  (`ApiResponseError` etc.) stay importable for realistic rejection assertions — never mock the whole
  error-class hierarchy away. See `frontend/src/api/payments.test.ts` and
  `frontend/src/stores/bookings.test.ts` for the established pattern.
- Include at least: 1 happy path + 2 edge cases + 1 error path per function
- Use parametrize/table-driven patterns for similar input variations

Place shared fixtures in `conftest.py` (pytest) or equivalent framework file.
Never hardcode credentials, paths, or environment-specific values in tests.

For pure functions with mathematical properties (roundtrip, idempotency, commutativity) —
generate property-based tests using hypothesis (Python) or fast-check (JS/TS) alongside
example-based tests. See `references/property-based-testing.md` for property catalog.
PBT is optional — generate only when a clear property exists.

**Step 4 — Run tests and iterate** *(default mode only)*

Run tests using detected framework command. Adapt syntax to detected shell.

Interpret output:
- PASSED → record in results
- FAILED → read error, fix the test (not the source code), re-run
- ERROR (import/setup) → fix imports, fixture setup, mock configuration, re-run
- SKIPPED → note reason, do not count as passing

Maximum iteration attempts: 3 per failing test.
If test still fails after 3 attempts: mark as ⚠️ NEEDS REVIEW and document the issue.
Never modify source code to make tests pass — fix only test code.

**Step 5 — Coverage report** *(default and coverage_only mode)*

Run coverage using the detected framework. Use `source_dir` from Configuration:
- pytest: `pytest --cov={source_dir} --cov-report=term-missing`
- Go: `go test -cover ./...`
- Jest: `jest --coverage`
- Vitest (VELO): `npx vitest run --coverage` (already wired via `test:coverage` in package.json;
  v8 provider, see `frontend/vitest.config.ts`)
- GUT: coverage not available via CLI; note manually, skip this step

Parse output. Record:
- Overall coverage %
- Files below 60% coverage → flag as ⚠️ LOW COVERAGE
- Uncovered lines/branches → list in report as additional test candidates
- Do NOT chase 100% — flag critical uncovered paths only

**Step 5.5 — Audit mode** *(audit_mode only — runs instead of Steps 3, 4, 5)*

Read `references/test-antipatterns.md`.
Analyze all test files mapped in Step 2-AUDIT. Find and report anti-patterns (AP-01 through AP-13).
For AP-12 (Example-Only Testing): flag pure functions that could benefit from PBT — as SUGGESTION.
For AP-13 (Mutation-Immune Tests): flag tests that only check type/shape, never exact values — as WARNING.
If coverage is high but tests feel shallow, recommend mutation testing (see `references/mutation-testing.md`).
Score the test suite quality (1-10).
Produce findings using the severity format from `references/severity-format.md`.

**Step 6 — Produce report**

Read `references/output-template.md`.
Build final report. Adapt language to the user's language.
Save to `report_dir` for large outputs (>50 tests or multi-file audit).

## Quick Reference

See `references/user-guide.md` for installation, invocation, and usage examples.

## Anchor

[*] unit-test v1.3.0 * ready
[>] | NEXT: user command
