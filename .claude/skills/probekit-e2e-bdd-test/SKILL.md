---
name: probekit-e2e-bdd-test
description: "Generate, audit, and run E2E tests with BDD/Gherkin scenarios. Use when a user asks to write end-to-end tests, create BDD scenarios, audit existing feature files, generate step definitions, or validate user flows. Triggers on: 'write e2e tests', 'create bdd scenarios', 'generate feature files', 'audit my tests', '/probekit-e2e-bdd-test', or when the user provides a module/route/flow and asks to test it end-to-end, 'пробкит e2e', 'пробкит сценарии'."
---

# e2e-bdd-test v1.0.0

E2E and BDD test generation skill for Claude Code.
Reads application code → generates Gherkin feature files + step definitions → runs them → fixes failures.
Also audits existing test suites for quality, coverage gaps, and anti-patterns.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's docs/01_refer path replaced with the
     git-untracked scratch dir the rest of the family already uses (dda9a6f,
     PROMPT №385). VELO has no docs/01_refer/.

     NO RUNNER, NO SUITE -- read this before running (PROMPT №435). VELO has no
     Playwright, no Cypress and no Cucumber in frontend/package.json, and no
     tests/e2e tree. This skill therefore CANNOT run or audit anything here
     today; the `--audit` mode has nothing to read. Standing it up means adding
     a browser runner and a way to drive a Telegram Mini App (Telegram
     WebApp auth is not a plain login form) -- a sized decision, not a tuning
     detail. `test_output_dir` below is where a suite WOULD go; it does not
     exist. VELO's real test seam today is Vitest + happy-dom, colocated --
     see probekit-screen-test, which is the VELO-native way to exercise a
     screen without a browser. -->
test_output_dir: tests/e2e
report_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Identify input and mode**

Determine what to work with:
- File or directory path → read code, detect language, framework, and entry points
- Focus hint (e.g. `/e2e-bdd-test src/api/ -- focus on auth flows`) →
  path is everything before `--`; text after is a focus hint applied during all steps
- `--audit` flag OR path points to existing test files (*.feature / test_*.py / *.spec.ts) → enter AUDIT mode (Sections 11, 12, 13)
- No explicit flag + source code provided → enter GENERATE mode (Sections 1 and 2)
- No input yet → ask: "What would you like to test? Provide a file path, directory, or describe the user flow."

If ENVIRONMENT.md exists in the project → read it for shell/tool pitfalls before executing commands.

**Step 2 — Detect environment**

Read project structure to determine:
- Language: Python / JavaScript / TypeScript / other
- Test framework:
  - Python → prefer pytest-bdd if pytest is present; fallback to behave
  - JS/TS → prefer Playwright + Cucumber; fallback to Cypress
  - Other → best available framework for the language
- Existing test structure: find features/, step_definitions/, conftest.py, playwright.config.*
- Entry points: routes, API handlers, CLI commands, UI components, game scenes
- Shell: detect OS and adapt all commands accordingly (PowerShell vs bash)

**Step 3 — Identify user flows (GENERATE mode)**

Read `references/analysis-sections.md` Section 1.
Extract testable user flows from the codebase:
- HTTP endpoints → each route family = one feature
- Auth flows → always a dedicated feature
- Business logic flows → one feature per domain object lifecycle
- Error/edge paths → include as scenarios within relevant features
- Game flows (Godot/GUT) → scene transitions, player actions, state changes

Prioritize by risk: auth, data mutation, payment, state transitions first.

**Step 4 — Generate Gherkin feature files**

Read `references/gherkin-patterns.md`.
For each identified flow, write a .feature file following good Gherkin rules:
- Declarative, not procedural (what, not how)
- One scenario per behavior
- Scenario Outline + Examples table for data-driven cases
- Tags: @smoke (critical path), @regression (full suite), @wip (in progress)
- Background block for shared Given steps across a feature
- No UI implementation details in Gherkin steps

Save feature files to `{{test_output_dir}}/features/`.

**Step 5 — Generate step definitions**

Read `references/analysis-sections.md` Section 2.
Generate step definition files mapped to the feature files:
- One step definition file per feature file
- Shared steps → conftest.py (Python) or support/steps.ts (JS/TS)
- Page Object Model (POM) classes for UI interactions
- Fixtures for setup/teardown
- API helpers for non-UI setup steps (seed data via API, not UI)
- No hardcoded waits/sleep → use framework-native waiting mechanisms

**Step 6 — Run tests**

Execute the generated tests using the detected framework and shell syntax.
Capture full output including failures, stack traces, and timing.
Read `references/e2e-antipatterns.md` Section "Flakiness Diagnosis" before analyzing failures.

**Step 7 — Fix and re-verify**

For each failing test:
1. Diagnose: environment issue vs logic error vs timing issue vs wrong selector
2. Apply fix to step definitions or POM (not to feature files — Gherkin describes behavior, not implementation)
3. Re-run failing scenarios only (use tag filter or scenario name filter)
4. Repeat until all tests pass or until failure is confirmed as a real application bug
5. If a real bug is found → document it in report, do NOT fix the test to hide it

Maximum 3 fix iterations per failing test. If still failing after 3 → mark as BLOCKED, document reason.

**Step 8 — Audit mode (when --audit or existing tests provided)**

Read `references/analysis-sections.md` Sections 11, 12, 13.
Read `references/e2e-antipatterns.md` — apply AP-01 (Ice Cream Cone) and AP-08 (Testing Through Wrong Layer) as additional checks during Section 12 coverage analysis. Use AP-02 through AP-09 code examples to illustrate findings.
Run full audit of existing feature files and step definitions:
- Section 11: Gherkin Quality Audit
- Section 12: Coverage Gap Analysis (+ AP-01, AP-08)
- Section 13: Step Definition Code Quality
Apply severity markers from `references/severity-format.md`.

**Step 8.5 — Fix mode (audit + fix only)**

If `--fix` flag is present alongside `--audit`:
1. Apply all CRITICAL and WARNING fixes to actual feature files and step definitions — EXCEPT findings 11.3 (Missing Assertions) and 11.7 (Vague Steps), which touch behavioral intent and must be reviewed by the user manually
2. Skip SUGGESTION fixes (too subjective for auto-fix)
3. Auto-fixable structural items: 11.5 (merge copy-paste into Outline), 11.6 (extract Background), 11.8 (remove hardcoded credentials), 11.9 (add tags), 11.10 (normalize language), 13.1 (replace sleeps), 13.4 (improve locators), 13.10 (extract POM), 13.11 (add assertion body)
4. Flag 11.3 and 11.7 findings in the report under "Manually review required" — provide specific guidance on what needs to change but do not modify the file
5. After applying fixes, re-run Sections 11, 12, 13 on modified files
6. Report using AUDIT+FIX format from `references/output-template.md`

If `--fix` is not present — skip this step entirely.

**Step 9 — Produce report**

Read `references/output-template.md`.
Build final report with:
- List of generated/audited files
- Test run results (pass/fail/blocked counts)
- Coverage map: which flows are tested, which are missing
- Findings from audit (if audit mode)
- Score X/10

Save report to `{{report_dir}}`.
Update `{{report_dir}}/AUDIT-TRACKER.md` with this run.

## Anti-Pattern Quick Reference

Full details with code examples: `references/e2e-antipatterns.md`

| ID | Name | Severity | What it means |
|----|------|----------|---------------|
| AP-01 | Ice Cream Cone | CRITICAL | More E2E tests than unit+integration combined — inverted pyramid |
| AP-02 | Hardcoded Wait | WARNING | `time.sleep()` / `wait_for_timeout()` instead of explicit wait conditions |
| AP-03 | Shared State | WARNING | Scenarios depend on execution order or data from previous tests |
| AP-04 | UI Steps for Setup | WARNING | Seeding test data through UI instead of API/DB — slow and fragile |
| AP-05 | Brittle Selectors | WARNING | XPath/CSS selectors that break on any DOM change — use data-testid |
| AP-06 | Assertions in POM | WARNING | Page Object methods contain assertions — breaks separation of concerns |
| AP-07 | Missing Isolation | CRITICAL | Global variables in step definitions — breaks parallel execution |
| AP-08 | Wrong Layer | WARNING | Business rules tested only in E2E instead of unit tests |
| AP-09 | Tautological Gherkin | WARNING | Step definition has no real assertion — `pass` or empty body |

## Quick Reference

See `references/user-guide.md` for installation and usage examples.

## Anchor

[*] e2e-bdd-test v1.0.0 * ready
[>] | NEXT: user command
