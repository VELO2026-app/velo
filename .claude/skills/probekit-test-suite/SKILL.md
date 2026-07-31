---
name: probekit-test-suite
description: "Testing pipeline orchestrator. Runs probekit skills in sequence, gates on quality, auto-fixes safe CRITICALs, produces single consolidated AUDIT-REPORT. Modes: full (13 stages), quick (code-audit + unit), quality (code + unit + integration), arch (arch-review only), deep (arch + type + code + security + health + comprehension + tests), secure (code + security + dependency), health (runtime health), types (type-audit only), comprehension (comprehension-debt only), hygiene (project-hygiene only). Use when: 'run full test suite', 'test everything', 'quality check', '/probekit-test-suite', 'пробкит всё', 'пробкит полный', 'пробкит запусти'."
---

# test-suite v4.0.0

Testing pipeline orchestrator for Claude Code.
Runs testing skills in logical sequence, gates on quality, auto-fixes safe CRITICALs, aggregates results into a single consolidated report.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's path replaced with the git-untracked scratch
     dir the rest of the family already uses (dda9a6f, PROMPT №385). Note this
     one pointed at docs/01_reference/KNOWLEDGE/, a DIFFERENT stale path from
     the docs/01_refer/ARCHIVES/ the other skills carried -- neither exists in
     VELO.

     INERT STAGES against VELO -- marked, NOT rewired (PROMPT №435). This
     orchestrator dispatches to the skills below; two of them cannot do anything
     here, so in `full` mode expect them to no-op:
       - Stage 11 e2e-bdd-test -- VELO has no Playwright/Cypress/Cucumber and no
         tests/e2e tree. Nothing to run, nothing to audit.
       - Stage 12 perf-test -- no local API. The only reachable targets are the
         shared TEST and PROD servers; do NOT load them without the operator's
         explicit go.
     Their silence is NOT a pass. See each skill's own Configuration note.

     NOT WIRED IN: probekit-screen-test, the VELO-native skill that covers Vue
     screens via Vitest + happy-dom (the seam this repo actually uses). It is
     absent from the pipeline below because adding a stage is a pipeline
     decision, not a path fix. Raise it before trusting `full` as "everything". -->
report_dir: .tmp/probekit-review

## Pipeline

relevance-gate → arch-review → type-audit → code-audit → auto-fix → security-audit → dependency-audit → health-audit → comprehension-debt → unit-test → integration-test → e2e-bdd-test → perf-test → project-hygiene → consolidated-report

## Modes

| Mode | Stages | When to use |
|------|--------|-------------|
| `full` | All 13 | Pre-release, milestone close, comprehensive check |
| `quick` | type-audit + code-audit + unit-test | Fast feedback during development |
| `quality` | type-audit + code-audit + unit-test + integration-test | Thorough without E2E/perf overhead |
| `arch` | arch-review | Architecture-only analysis |
| `deep` | arch + type + code + security + health + comprehension + unit + integration | Architecture + code + security + health + tests |
| `secure` | code-audit + security-audit + dependency-audit | Security-focused review |
| `health` | health-audit | Runtime health only |
| `types` | type-audit | Type system analysis only |
| `comprehension` | comprehension-debt | Comprehension debt analysis only |
| `hygiene` | project-hygiene | Project hygiene scan only |

Default: `quality` (if user doesn't specify mode)

## Stage Relevance Gate

**Before executing each stage**, check if it is relevant for the current project state. Skip irrelevant stages with reason logged.

**Relevance rules:**

| Stage | Skip when | Detection method |
|-------|-----------|-----------------|
| `type-audit` | No `.ts`, `.vue`, or typed files | Check if project has no TypeScript/typed source files. |
| `perf-test` | No production HTTP endpoints under load | Check if project has no HTTP API consumers. |
| `e2e-bdd-test` | No user-facing web UI | Check if there is no browser-based UI, no web routes serving HTML. |
| `dependency-audit` | < 15 direct dependencies | Count entries in requirements.txt / package.json. Below threshold = low risk. |
| `integration-test` (generation) | Existing integration test coverage > 80% | Run existing integration tests first. If all pass and count is substantial (>50), skip test generation. |
| `comprehension-debt` | < 50 git-tracked source files | Count source files. Below threshold = low complexity, skip. |
| `project-hygiene` | < 20 git-tracked source files | Count source files. Below threshold = low risk of hygiene issues. |

**When a stage is skipped:**
- Log: `SKIPPED: {stage} — {reason}` (e.g., "SKIPPED: perf-test — no production HTTP endpoints")
- Record in report as `SKIP` gate with reason
- Do NOT count skipped stages in scoring

**Override:** User can force any stage with `--force-{stage}` flag (e.g., `--force-perf`).

## Auto-Fix Protocol

After code-audit (Step 3), if CRITICAL findings meet ALL conditions:
1. **Localized** — fix is within a single file, < 20 LOC change
2. **Clear logic** — the correct fix is unambiguous (wrong table name, missing await, missing cleanup)
3. **No architectural conflict** — fix doesn't change public API, service boundaries, or data model
4. **No cross-module side effects** — fix doesn't require changes in other modules
5. **Testable** — existing tests cover the affected code path

**Auto-fix workflow:**
1. Apply the fix
2. Run the full test suite (`python -m pytest tests/ -x --tb=short -q`)
3. If tests pass → mark as `AUTO-FIXED` in report, continue pipeline
4. If tests fail → **revert the fix immediately**, mark as `NEEDS-MANUAL` in report
5. If test patch needed (mock target changed, etc.) → fix test too, re-run

**What is NOT auto-fixable:**
- Anything requiring new files, new services, or new abstractions
- Refactoring (even if "obvious") — e.g., extracting a service, renaming across modules
- Security credential rotation (ops task, not code)
- Anything touching > 3 files

**Report format for auto-fixes:** Table with columns: #, File, Problem, Fix (under heading "Fixed During Audit")

## Language Routing

| Target files | Unit test skill | Other skills |
|-------------|----------------|--------------|
| `.py` files | probekit-unit-test (pytest) | All standard |
| `.js/.ts` files | probekit-unit-test (Jest/Vitest) | All standard |
| Mixed | probekit-unit-test per language | Run applicable stages |

## Quality Gates

Read `references/quality-gate-contract.md` for per-stage thresholds.
Read `references/scoring-formula.md` for overall scoring algorithm and gate rules.

## Execution Steps

**Step 1 — Parse input, load config, select mode**

Input formats:
- `/test-suite src/api/` — quality mode on directory
- `/test-suite --full framework/services/` — full mode on directory
- `/test-suite --quick framework/llm/adapter.py` — quick mode on file
- `/test-suite --arch framework/` — architecture review only
- `/test-suite --deep framework/services/` — arch + code + tests
- `/test-suite` (no path) — ask user what to test

**Config loading** (check in order, merge top-down):
1. CLI flags (highest priority)
2. `.probekit.yml` in current directory
3. `.probekit.yml` in git root
4. Defaults in this SKILL.md (lowest priority)

If `.probekit.yml` found, read sections: `paths.review_dir`, `thresholds`, `exclude.paths`, `features.skills`, `scoring.weights`.
If not found — use defaults. Do NOT require it.

Detect target language from file extensions. Select unit test skill accordingly.

**Step 1.5 — Stage relevance check**

Apply Stage Relevance Gate rules. Log skipped stages. Proceed with relevant stages only.

**Step 2 — Stage 1: Architecture Review**

_Skip if mode is `quick`, `quality`, `types`, `comprehension`, or `hygiene`._
Invoke `probekit-arch-review` on target. Record: {Gate, Score, Blocking, findings_summary}.
Build structured context (see `references/inter-skill-context.md`).
If mode is `arch` — skip to Step 8.

**Step 2.5 — Stage 1.5: Type Audit**

_Skip if mode is `arch`, `health`, `secure`, `comprehension`, or `hygiene`._
_Check relevance gate: skip if no `.ts`/`.vue`/typed files._
Invoke `probekit-type-audit`. Run type checker (vue-tsc / tsc / mypy) + pattern scan.
**Blocking gate:** If compiler errors > 0 — **STOP pipeline** before code-audit.
If mode is `types` — skip to Step 8.

**Step 3 — Stage 2: Code Audit**

Invoke `probekit-code-audit`. Pass hotspot files from arch stage.

**Step 3.1 — Auto-Fix CRITICALs**

If code-audit found CRITICALs, apply Auto-Fix Protocol (see above).
- For each CRITICAL: evaluate auto-fix eligibility → fix → test → confirm or revert.
- Recalculate code-audit score after fixes.
- **Blocking gate:** If Gate = FAIL after auto-fixes — **STOP pipeline**. Report and do NOT proceed.

**Step 3.5 — Stage 3: Security Audit**

_Skip if mode is `quick`, `quality`, or `arch`._
Invoke `probekit-security-audit`. Pass security findings from code-audit.
If mode is `secure` — also run Step 3.7, then skip to Step 8.

**Step 3.7 — Stage 4: Dependency Audit**

_Skip if mode is `quick`, `quality`, or `arch`._
_Check relevance gate: skip if < 15 direct dependencies._
Invoke `probekit-dependency-audit`. No upstream context needed.

**Step 3.8 — Stage 5: Health Audit**

_Skip if mode is `quick`, `quality`, `arch`, `secure`, `types`, `comprehension`, or `hygiene`._
Invoke `probekit-health-audit`. Scans runtime artifacts: disk bloat, log rotation, DB growth, dead files, config drift, orphan data.
If mode is `health` — skip to Step 8.

**Step 3.9 — Stage 5.5: Comprehension Debt**

_Skip if mode is `quick`, `quality`, `arch`, `secure`, `health`, `types`, or `hygiene`._
_Check relevance gate: skip if < 50 git-tracked source files._
Invoke `probekit-comprehension-debt`. Analyzes naming clarity, abstraction depth, coupling complexity, documentation gaps.
If mode is `comprehension` — skip to Step 8.

**Step 4 — Stage 6: Unit Tests**

Invoke `probekit-unit-test`.
Pass findings with file:line:function for targeted test generation.
If mode is `quick` — skip to Step 8.

**Step 5 — Stage 7: Integration Tests**

_Check relevance gate: skip generation if existing coverage > 80%._
Invoke `probekit-integration-test`. Pass uncovered findings + boundary functions.
If mode is `quality` or `deep` — skip to Step 8.

**Step 6 — Stage 8: E2E/BDD Tests**

_Check relevance gate: skip if no user-facing web UI._
Invoke `probekit-e2e-bdd-test`. Skip if no user-facing endpoints.

**Step 7 — Stage 9: Performance Tests**

_Check relevance gate: skip if no HTTP endpoints._
Invoke `probekit-perf-test`. Use `smoke` profile.

**Step 7.5 — Stage 10: Project Hygiene**

_Skip if mode is `quick`, `quality`, `arch`, `secure`, `health`, `types`, or `comprehension`._
_Check relevance gate: skip if < 20 git-tracked source files._
Invoke `probekit-project-hygiene`. Scans: dead files, duplicate code, stale dependencies, git bloat, orphan configs.
If mode is `hygiene` — skip to Step 8.

**Step 8 — Produce AUDIT-REPORT**

Read `references/output-template.md`. Aggregate all stage results.
Calculate overall score per `references/scoring-formula.md`.
**Produce ONE consolidated report:** `{{report_dir}}/AUDIT-REPORT-{YYYYMMDD}.md`
- Section 1: Fixed during audit (auto-fixes with diffs)
- Section 2: Remaining P1 (important)
- Section 3: Remaining P2 (medium)
- Section 4: Remaining P3 (recommended)
- Section 5: Architecture strengths (DIAMOND patterns)
- Section 6: Test health
- Section 7: Runtime health

**Do NOT produce intermediate per-stage reports.** One report, no duplication.

**Step 9 — Update audit tracker**

Update `{{report_dir}}/AUDIT-TRACKER.md`.

## Skills NOT in Pipeline

| Skill | Reason |
|-------|--------|
| livemockup-studio | UI prototyping, not testing |
| simplify | Code quality improvement, not testing |

## Context Passing

Read `references/inter-skill-context.md` for the full protocol on passing structured context between stages.

## Quick Reference

Invoke:
- `/test-suite {path}` — quality mode (default)
- `/test-suite --full {path}` — all 13 stages
- `/test-suite --quick {path}` — type-audit + code-audit + unit-test
- `/test-suite --arch {path}` — architecture only
- `/test-suite --deep {path}` — arch + type + code + security + health + comprehension + unit + integration
- `/test-suite --secure {path}` — code-audit + security-audit + dependency-audit
- `/test-suite --health {path}` — runtime health audit
- `/test-suite --types {path}` — type system analysis only
- `/test-suite --comprehension {path}` — comprehension debt analysis
- `/test-suite --hygiene {path}` — project hygiene scan

## Changelog

### v4.0.0 (2026-04-14)
- **NEW:** type-audit stage (Step 2.5) — type system analysis with blocking gate on compiler errors
- **NEW:** comprehension-debt stage (Step 3.9) — naming, abstraction, coupling, documentation analysis
- **NEW:** project-hygiene stage (Step 7.5) — dead files, duplicates, stale deps, git bloat
- **NEW:** 3 new modes: `types`, `comprehension`, `hygiene`
- **CHANGED:** Universal pipeline: 13 stages instead of 10
- **CHANGED:** `quick` mode now includes type-audit
- **CHANGED:** `deep` mode now includes type-audit + comprehension-debt

### v3.1.0 (2026-04-05)
- **CHANGED:** Removed project-specific stages (arch-review-bogame, code-audit-bogame, health-audit-bogame, godot-unit-test)
- **CHANGED:** Universal pipeline: 10 stages instead of 12
- **CHANGED:** Language routing simplified — no Godot-specific routing

### v3.0.0 (2026-04-05)
- **NEW:** Auto-Fix Protocol — automatically fixes safe CRITICALs (localized, < 20 LOC, testable), reverts on test failure
- **NEW:** Stage Relevance Gate — skips irrelevant stages based on project state
- **NEW:** Consolidated report format — single AUDIT-REPORT with Fixed/P1/P2/P3 sections, no intermediate reports

### v2.5.0
- Initial release with 12-stage pipeline, 7 modes, quality gates

## Anchor

[*] test-suite v4.0.0 * ready
[>] | NEXT: user command
