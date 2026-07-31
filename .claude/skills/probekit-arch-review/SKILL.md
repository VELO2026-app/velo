---
name: probekit-arch-review
description: "Project-independent architecture review of modules, coupling, cohesion, layering, error design, data flow, and testability. Emits a scored report. Use when reviewing code structure."
---

# arch-review v1.4.1

Project-independent architecture review for Claude Code.
Evaluates structural quality of any codebase against universal principles and produces a scored report with actionable findings and severity markers.

**Triggers:** `architecture review`, `arch review`, `review architecture`, `проверь архитектуру`, `архитектурный ревью`, `пробкит архитектура`, `пробкит арх`, `/probekit-arch-review`, or when structural/design issues are the focus.

## Configuration

<!-- VELO-tuned (PROMPT №386, sweep): CBS's docs/01_refer path replaced with a
     git-untracked scratch dir; VELO has no docs/01_refer/ or ENVIRONMENT.md. -->
review_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Identify input and environment**

Determine what to review: file, directory, or entire project.
- File/directory path → read, detect language and framework
- Path with focus hint (e.g., `/arch-review src/ -- focus on coupling`) →
  path is everything before `--` or `—`; text after is a focus hint,
  apply it as additional attention during all sections (not a filter — still run all sections)
- `--fix` flag (or words "fix", "починь", "исправь") →
  set fix_mode = true; remove flag from path
- No input → ask: "What would you like me to review architecturally? Provide a path or describe the scope."

Check for ENVIRONMENT.md, ARCHITECTURE.md, or similar docs in the project.
If found — read for architecture context before proceeding.
(VELO note, PROMPT №386: no ENVIRONMENT.md; repo root has spec docs -- see
[[velo_spec_index]] memory -- but for this sweep keep it simple, do not wire them in.
Shell is Windows Git-Bash/PowerShell, no docker/VPS locally.)

**Step 2 — Structural reconnaissance**

Before diving into sections, build a mental model:
1. Read directory tree (2 levels deep) to understand module layout
2. Identify entry points (main, app, index, router files)
3. Map import graph: which modules import which (sample 10-15 key files)
4. Identify configuration and dependency injection patterns
5. Note language, framework, package manager, test framework

Output: brief "Architecture Snapshot" paragraph (included in report header).

**Step 3 — Run architecture analysis**

Read `references/analysis-sections-structure.md` and `references/analysis-sections-behavior.md`.
Execute all 12 sections in order. No skipping.
Apply severity markers from `references/severity-format.md` to every finding.

**Step 4 — Pattern quality scan**

Read `references/good-patterns.md`, `references/bad-patterns.md`, and `references/diamond-patterns.md`.
Check codebase against known good, bad, and diamond architecture patterns.
Add findings as Section 13: Pattern Quality Assessment.

**Step 5 — Architecture balance scorecard**

Score 13 dimensions (0–10 each):

| Dimension | What it measures |
|-----------|-----------------|
| Modularity | Clear boundaries, single responsibility per module |
| Coupling | Low inter-module coupling, dependency injection |
| Cohesion | High intra-module cohesion, related code together |
| Layering | Clear layer separation, no layer violations |
| Consistency | Same patterns across entire codebase |
| Error Design | Coherent error hierarchy, consistent handling |
| Data Flow | Clear transformation pipeline, no hidden state |
| Scalability | Horizontal scaling readiness, no bottlenecks |
| Testability | DI, interfaces, seams for testing |
| Evolvability | Can grow without rewriting core |
| Concurrency | Thread safety, async correctness, connection pooling |
| Observability | Structured logging, metrics, health checks, correlation IDs |
| Operational Health | Data growth policies, log rotation, cleanup mechanisms, runtime hygiene |

Calculate weighted average:
- Modularity, Coupling, Cohesion: weight 1.5x (structural foundation)
- Layering, Consistency: weight 1.2x (maintainability)
- Error Design, Data Flow, Scalability, Testability, Evolvability, Concurrency, Observability, Operational Health: weight 1.0x

Final score = weighted average, rounded to 1 decimal.

**Step 6 — Produce report**

Read `references/output-template.md`.
Build final scored report.
Adapt language to the user's language.
For small input (<5 files): output report inline in chat.
For large input (directory or 5+ files): save report to `{{review_dir}}/ARCH-REVIEW-<target>-<YYYYMMDD>.md` and inform the user.

**Step 7 — Update audit tracker**

Read or create `{{review_dir}}/AUDIT-TRACKER.md`.
Append entry with: date, scope reviewed, score, CRITICAL/WARNING/SUGGESTION counts.
If previous entries exist for the same scope — show delta.

**Step 8 — Fix mode (optional)**

If fix_mode is true:
Read `probekit-core/references/auto-fix-safety.md` — follow its Safety Checklist and Fix-Verify-Revert Protocol.
1. CRITICAL then WARNING findings: run the 5-point checklist, write the line "this breaks: ..." (name the blast radius before touching code) → apply → verify → confirm or revert.
2. Skip SUGGESTION fixes (per core standard: never auto-fix).
3. Record the pre-fix weighted score, re-run Step 3 on modified areas for a post-fix score, then report the literal delta (old → new). If the score did not rise, list which findings remain.
4. Report using standard auto-fix table format (see core reference).

If fix_mode is false — skip this step.

## Quality Gate

The architecture review **PASSES** when:
- Score ≥ 5.0/10
- Zero CRITICAL findings

**WARN** when:
- Score 3.0–4.9/10
- CRITICAL findings exist but are isolated

**FAIL** when:
- Score < 3.0/10
- Systemic CRITICAL findings (same issue across 3+ modules)

## Quick Reference

Invoke: `/arch-review <path>` or `/arch-review src/ -- focus on coupling`

## Changelog

- **v1.4.1** — ASCII description, triggers moved to body. Fix-mode levers: name-what-breaks (L6), score-delta (L5). CRLF normalized.
- **v1.4.0** — Moved comprehension debt dimensions (Contract Explicitness, Risk Governance, AI Fitness) to probekit-comprehension-debt where they belong. Removed Step 3.5 comprehension debt architecture scan. Scorecard reduced from 16 to 13 dimensions.

## Anchor

[*] arch-review v1.4.1 * ready
[>] | NEXT: user command
