---
name: probekit-code-audit
description: "Senior-engineer code review: finds bugs, security, performance, and test-quality issues with a scored report and fixes. Use when reviewing files, directories, or PRs, or when code is pasted."
---

# code-audit v2.5.0

Senior engineer code review skill. Finds bugs, security issues, bad practices, and test quality problems.
Produces a scored report with actionable fixes. Optionally auto-fixes findings.

**Triggers:** `review this code`, `audit`, `find bugs`, `check my code`, `code review`, `/probekit-code-audit`, `пробкит аудит`, `пробкит код`, or any file/directory/code snippet provided for review (even just "look at this").

## Configuration

<!-- VELO-tuned (PROMPT №385, trial): CBS's docs/01_refer path replaced with a
     git-untracked scratch dir; VELO has no docs/01_refer/. No ENVIRONMENT.md
     exists in this repo -- shell is Windows Git-Bash/PowerShell, no
     docker/VPS locally. -->
review_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Identify input and environment**
Determine what to review: single file, directory, or inline code.
- File/directory path → read with bash, detect language and framework
- Path with focus hint (e.g. `/code-audit src/auth/ -- focus on security`) →
  path is everything before `--` or `—`; text after is a focus hint applied as extra
  attention during all sections (not a filter — still run every section)
- `--fix` flag (or words "fix", "починь", "исправь") → set fix_mode = true; strip flag from path
- `--tests` flag (or "audit tests", "check tests", "проверь тесты", "what's wrong with my tests") →
  set test_audit_mode = true; Section 12 becomes primary focus (all sections still run)
- Inline code in chat → use directly
- No input yet → ask: "What would you like me to review? Provide a file path, directory, or paste the code."

Before running any review command, paste the output of an existence probe for
ENVIRONMENT.md (common locations: root, docs/01_refer/), e.g. `ls ENVIRONMENT.md docs/01_refer/ENVIRONMENT.md`.
If the probe shows it exists, read it and quote the shell/tool pitfalls that constrain
your commands; only then proceed. Do not hardcode shell syntax — adapt to the detected environment.
(VELO note, PROMPT №385: probe will show ENVIRONMENT.md absent -- this repo has none.
Shell is Windows Git-Bash/PowerShell; no docker/VPS locally, so any command touching
those is out of scope for this skill.)

**Step 2 — Run full analysis**
Read `references/analysis-sections-core.md`.
Execute all 9 sections in order. No skipping.
Apply severity markers from `references/severity-format.md` to every finding.

**Step 3 — Run AI-specific scan**
Read `references/ai-patterns-catalog.md` and `references/ai-patterns-checklist.md`.
Add Section 10: AI-Generated Code Patterns.
Run even if origin is unknown — AI patterns appear in human-written code too.

**Step 3.5 — Cross-module analysis (multi-file only)**
If reviewing 2+ files:
Read `references/analysis-sections-core.md` Section 11.
Run cross-module consistency check across all reviewed files.
Add findings to report as Section 11: Cross-Module Consistency.
Skip this step if reviewing a single file or inline code.

**Step 3.6 — Test audit (always run if test files present)**
Read `references/analysis-sections-test-audit.md`.
Detect test files automatically:
- Python: files matching test_*.py or *_test.py
- JS/TS: *.test.*, *.spec.*
- Go: *_test.go
- GDScript: test_*.gd or res://tests/
- Any other: files inside directories named test, tests, spec, specs
If test files found → run Section 12: Test Quality Audit.
If no test files found → write: "No test files detected." and close section.
If test_audit_mode = true → give Section 12 expanded treatment (check all subsections thoroughly).

**Step 3.7 — Orphan source file detection (directory reviews only)**

**Scope:** source files only (.ts, .vue, .py, .go, .gd, .js, .rs, .java). Non-source orphans
(config, docs, data, assets) belong to `probekit-project-hygiene` (PH-DEAD-FILES probe).

If reviewing a directory:
1. Recursively list all **source** files in the target.
2. For each non-test, non-config source file, grep the codebase for imports/references to its
   module/class/function and any manifest, config, or entry point.
3. A file is "orphan" if: zero imports from any other source file; not an entry point
   (main.py, app.py, __init__.py, index.*); not a config file (.toml, .yaml, .json, .env);
   not a migration, test, or documentation file.
4. Flag with LOC-based severity:
   - < 50 LOC: 🟢 SUGGESTION — likely dead code, verify and delete
   - 50-200 LOC: 🟡 WARNING — significant unreferenced code
   - > 200 LOC: 🔴 CRITICAL — major dead module

Add findings as Section 13: Orphan Source Files.
Skip for single file or inline code — write: "Skipped (single file review)."

**Step 4 — Produce report**
Read `references/output-template.md`. Build the final scored report.
Respond in the same language the user wrote in.
Small input (<100 LOC or inline code): output inline in chat.
Large input (file >100 LOC or directory): save to `{{review_dir}}` and tell the user the exact path.

**Step 4.5 — Update audit tracker**
Read or create `{{review_dir}}/AUDIT-TRACKER.md`.
Append entry with: date, files reviewed, score, CRITICAL/WARNING/SUGGESTION counts.
If previous entries exist for the same files — show delta (resolved/new findings).
See `references/output-template.md` for tracker format.

**Step 5 — Fix mode (optional)**
If fix_mode is true:
Read `probekit-core/references/auto-fix-safety.md` — follow its Safety Checklist and Fix-Verify-Revert Protocol.
1. CRITICAL findings: run the 5-point safety checklist → apply fix → verify → confirm or revert.
2. WARNING findings: same checklist → apply → verify → confirm or revert.
3. Skip SUGGESTION fixes (core standard: never auto-fix).
4. After all fixes, re-run a quick scan (Sections 2 + 4 only) on the modified files.
5. Report using the standard auto-fix table format (see core reference).
If fix_mode is false — skip this step.

## Quick Reference

See `references/user-guide.md` for installation, invocation, and usage examples.

## Anchor

[*] code-audit v2.4.0 * ready
[>] | NEXT: user command
