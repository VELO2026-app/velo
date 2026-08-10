---
name: probekit-health-audit
description: "Runtime health audit — disk bloat, log rotation, DB growth, dead files, config drift, orphan data. Triggers on: 'health audit', 'disk audit', 'runtime audit', 'bloat check', 'cleanup audit'."
---

# probekit-health-audit v1.2.0

Audits runtime artifacts that code-level skills miss: log files, databases, caches,
vendored binaries, and configuration drift. Catches the problems that only surface
when you look at the **running system**, not just the source code.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's docs/01_refer path replaced with the
     git-untracked scratch dir the rest of the family already uses (dda9a6f,
     PROMPT №385). VELO has no docs/01_refer/.

     INERT PROBES against VELO -- marked, NOT rewritten (PROMPT №435):
     every SQLite probe below (*.db file growth, VACUUM, journal/WAL size,
     PRAGMA checks). VELO's backend is Postgres in Docker on the VPS; there is
     no .db file to stat and no local Docker or VPS access from this repo, so
     those probes find nothing and their silence is NOT a pass. The disk/log/
     dead-file/config-drift probes still apply to the repo working tree.
     Rewriting them for Postgres is a separate, sized task -- do not infer a
     clean bill of health from an inert probe. -->
```yaml
review_dir: .tmp/probekit-review
```

## Execution Steps

**Step 0 — Environment Detection**

Read `probekit-core/references/environment-detection.md`.
Detect OS, shell, project root, package manager.
Adapt all file-size and path commands to detected platform (PowerShell on Windows, bash on Linux/macOS).

**Step 1 — Load Severity Rules**

Read `probekit-core/references/severity-format.md` — universal severity markers.
Read `references/severity-format.md` — health-audit-specific escalation rules.

**Step 2 — Load Probe Definitions**

Read `references/probe-definitions.md` — full specification of all 12 probes with thresholds, detection methods, and scoring.

**Step 3 — Execute Probes (12 dimensions)**

Run each probe in order. For each probe: scan target, collect evidence, assign severity, score 0-10.

| # | Probe | What It Checks |
|---|-------|----------------|
| 1 | **Disk Bloat** | Files exceeding size thresholds in gitignored dirs (logs/, data/, runtime/, cache/) |
| 2 | **Log Rotation** | Every log file handler has rotation configured (RotatingFileHandler or equivalent) |
| 3 | **Log Duplication** | Single event is not written to multiple files (trace write chains) |
| 4 | **DB Growth** | Tables with time-series data have TTL/cleanup and it actually runs |
| 5 | **Dead Files** | Files/directories on disk with zero references from code |
| 6 | **Config Drift** | Config declares policy X but code implements Y (or doesn't implement at all) |
| 7 | **Orphan Data** | Legacy-named artifacts (old project names, deprecated DB files, stale caches) |
| 8 | **ADR Currency** | Architecture Decision Records exist, are current, cover key decisions |
| 9 | **Domain Rules Coverage** | Domain knowledge in .claude/rules/ or CLAUDE.md, not just developer heads |
| 10 | **SQLite Table Sizes** | Individual table row counts and disk footprint against thresholds |
| 11 | **Memory Entry Age** | Stale entries in memory/episodic tables older than retention policy |
| 12 | **WAL/Log Freshness** | WAL file size and last checkpoint time; log files not rotated recently |

**Step 4 — Cross-Probe Analysis**

After all probes complete, check for compound issues:
- Disk Bloat + No Log Rotation = systemic logging failure (escalate to CRITICAL)
- DB Growth + Config Drift = policy exists but is dead letter (escalate to CRITICAL)
- Dead Files + Orphan Data = legacy cleanup never completed (escalate to WARNING)
- No ADRs + Config Drift = decisions undocumented AND drifting (escalate to CRITICAL)
- No Domain Rules + Large Codebase (> 50 source files) = AI flying blind (escalate to CRITICAL)
- Large SQLite Tables + No DB Growth cleanup = storage degradation imminent (escalate to CRITICAL)
- Stale Memory Entries + No TTL = memory system accumulating noise (escalate to WARNING)
- WAL > 10 MB + No recent checkpoint = write performance degradation risk (escalate to WARNING)

**Step 5 — Score and Report**

Calculate per-probe scores (0-10) and weighted average.
Read `references/output-template.md` for exact report format.

Output destination:
- Quick check (< 5 findings): inline in chat
- Full audit (5+ findings): save to `{{review_dir}}/HEALTH-AUDIT-<target>-<YYYYMMDD>.md`

**Step 6 — Update Audit Tracker**

Read `probekit-core/references/audit-tracker-format.md`.
Append row to `{{review_dir}}/AUDIT-TRACKER.md`.

## Quality Gate

**PASSES** when:
- Average score >= 6.0/10
- Zero CRITICAL findings
- All log handlers have rotation

**WARN** when:
- Average score >= 4.0/10 but < 6.0
- OR 1-2 CRITICAL findings with clear fix path

**FAIL** when:
- Average score < 4.0/10
- OR 3+ CRITICAL findings
- OR any probe scores 0/10

## Quick Reference

Invoke:
- `/probekit-health-audit framework/` — audit framework runtime artifacts
- `/probekit-health-audit data/` — audit database files
- `/probekit-health-audit .` — full project health audit
- `/probekit-health-audit --fix framework/logs/` — auto-fix rotation issues

## Anchor

[*] probekit-health-audit v1.2.0 * ready
[>] | NEXT: user command
