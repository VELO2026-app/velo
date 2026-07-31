---
name: probekit-comprehension-debt
description: "Comprehension debt audit via git: churn, code age, duplication, ownership, context window fitness. Measures the gap between code volume and how well a team understands it. Use when auditing that gap."
---

# comprehension-debt v1.1.1

Measures comprehension debt — the invisible gap between code volume and how much
of it any human genuinely understands. Based on Addy Osmani's framework (2026),
GitClear data (211M lines), METR RCT, and Anthropic RCT findings.

**Triggers:** `comprehension debt`, `comprehension audit`, `churn audit`, `ownership matrix`, `who understands this code`, `/probekit-comprehension-debt`, `пробкит понимание`, `пробкит долг понимания`.

Traditional metrics (velocity, coverage, DORA) do not detect comprehension debt.
This skill provides proxy metrics that make the invisible visible.

## Configuration

<!-- VELO-tuned (PROMPT №385, trial): CBS's docs/01_refer path replaced with a
     git-untracked scratch dir; VELO has no docs/01_refer/. -->
review_dir: .tmp/probekit-review

## Execution Steps

**Step 0 — Environment Detection**

Check for ENVIRONMENT.md. Detect OS, shell, git availability.
All commands use `git log`, `git diff`, `git shortlog` — require a git repository.
If not a git repository: abort with "comprehension-debt requires a git repository."
(VELO note, PROMPT №385: no ENVIRONMENT.md in this repo -- shell is Windows
Git-Bash/PowerShell, git is available, `D:/02_Projects/velo` is a git repo.)

**Step 1 — Identify input and scope**

Input formats:
- `/comprehension-debt` (no path) — full repository analysis
- `/comprehension-debt src/api/` — scoped to directory
- `/comprehension-debt --days 60` — custom time window (default: 30 days)
- `/comprehension-debt --deep` — include per-file ownership matrix (slower)

Parse flags:
- `--days N` → set analysis_window = N days (default 30)
- `--deep` → set deep_mode = true (generates per-file ownership matrix)
- `--fix` → set fix_mode = true (generates actionable recommendations file)

**Step 2 — Load probe definitions**

Read `references/probe-definitions.md` for all 7 probes with thresholds and scoring.
Read `references/severity-format.md` (from probekit-core) for severity markers.

**Step 3 — Execute Probes (7 dimensions)**

Run each probe in order. For each: collect git data, analyze, assign severity, score 0-10.

| # | Probe | What It Measures |
|---|-------|-----------------|
| 1 | **Code Churn** | % lines rewritten within 14 days of creation |
| 2 | **Code Age Distribution** | % of changes touching code older than 30 days |
| 3 | **Duplication Ratio** | Copy/paste volume vs refactoring (moved code) volume |
| 4 | **Context Window Fitness** | Modules exceeding 200 LOC — AI comprehension boundary |
| 5 | **Ownership Clarity** | Files with single vs multiple authors, bus factor |
| 6 | **Commit Explainability** | Can commit messages explain what and why without reading diff |
| 7 | **Risk Tiering** | Critical code paths have proportional governance and review gates |

**Step 4 — Ownership Matrix (deep mode only)**

If deep_mode = true:
Read `references/ownership-matrix.md`.
Generate per-file ownership classification:
- **Green:** Single author, recent activity, clear commit messages
- **Yellow:** Multiple authors, all with meaningful commits, reviewable
- **Orange:** AI-heavy commits, superficial review signals, needs re-read
- **Red:** No clear owner, stale, nobody can explain without reading

Output: table sorted by risk (Red first), with file path, classification, reason.

**Step 5 — Cross-Probe Analysis**

After all probes complete, write the compound-findings list (L6: name-what-breaks).
Emit one line per rule below, each marked HIT or CLEAR with the two probe scores that
decided it — never skip a rule, and an empty list must be stated as "no compounds: all CLEAR":
- High Churn + Low Code Age = "add it and forget it" pattern (escalate to CRITICAL)
- High Duplication + Low Context Window Fitness = AI generating without reuse (escalate to CRITICAL)
- Low Ownership Clarity + High Churn = code nobody owns being constantly rewritten (escalate to CRITICAL)
- Low Explainability + High Churn = changes nobody can explain (escalate to WARNING)

**Step 6 — Score and Report**

Read `references/output-template.md` for exact report format.

Calculate per-probe scores (0-10) and weighted average:
- Code Churn: weight 1.5x (strongest signal of comprehension gaps)
- Duplication Ratio: weight 1.5x (compounds fastest)
- Context Window Fitness: weight 1.2x (structural enabler)
- Risk Tiering: weight 1.2x (governance proportionality)
- Code Age Distribution, Ownership Clarity, Commit Explainability: weight 1.0x

Final score = weighted average, rounded to 1 decimal.

Output destination:
- Quick check (< 5 findings): inline in chat
- Full audit (5+ findings): save to `{{review_dir}}/COMPREHENSION-DEBT-<target>-<YYYYMMDD>.md`

**Step 7 — Update Audit Tracker**

Append row to `{{review_dir}}/AUDIT-TRACKER.md`.

**Step 8 — Fix mode (optional)**

If fix_mode = true:
Read `references/fix-recommendations.md`.
Generate actionable file: `{{review_dir}}/COMPREHENSION-DEBT-FIXES-<YYYYMMDD>.md` with:
1. Top 10 files needing comprehension review (Red/Orange from ownership matrix)
2. Top 5 modules to split for context window fitness
3. Top 5 duplication clusters to consolidate
4. Suggested `.claude/rules/` entries for domains with no rules coverage
5. Three-file protocol list: the 3 files with largest recent diffs to read fully

## Quality Gate

**PASSES** when:
- Average score >= 6.0/10
- Zero CRITICAL compound findings
- Churn rate < 5%

**WARN** when:
- Average score >= 4.0/10 but < 6.0
- OR churn rate 5-8%
- OR 1-2 CRITICAL compound findings

**FAIL** when:
- Average score < 4.0/10
- OR churn rate > 8%
- OR 3+ CRITICAL compound findings

## Quick Reference

Invoke:
- `/comprehension-debt` — full repo, 30-day window
- `/comprehension-debt framework/` — scoped to framework directory
- `/comprehension-debt --days 60` — 60-day analysis window
- `/comprehension-debt --deep` — include per-file ownership matrix
- `/comprehension-debt --fix` — generate actionable recommendations

## Anchor

[*] comprehension-debt v1.1.1 * ready
[>] | NEXT: user command
