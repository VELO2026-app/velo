---
name: probekit-project-hygiene
description: "Project hygiene audit — finds dead files, dead code, duplicate files, stale dependencies, unused configs, orphan tests, archive duplicates, empty directories, stale docs, and git-tracked bloat. Provides justified action plan (DELETE/ARCHIVE/CONSOLIDATE/REVIEW) with dry-run by default. Triggers on: 'project hygiene', 'find junk', 'cleanup audit', 'dead code', 'find duplicates', 'repo bloat', '/probekit-project-hygiene'."
---

# project-hygiene v1.0.0

Project hygiene audit for any codebase. Scans for all forms of project
waste: dead files, dead code, duplicates, stale dependencies, unused
configs, orphan tests, and git-tracked bloat. Each finding includes
justification (why it is safe to remove) and a recommended action.

**Scope**: git-tracked files and project structure. Does NOT scan
runtime artifacts (logs, databases, caches) — that is health-audit's
domain. Does NOT scan node_modules, .venv, or other gitignored dirs.

**Key principle**: Every recommendation must be **justified**. Never
suggest deleting a file without proving it has zero references.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's docs/01_refer path replaced with the
     git-untracked scratch dir the rest of the family already uses (dda9a6f,
     PROMPT №385). VELO has no docs/01_refer/. -->
report_dir: .tmp/probekit-review

## Modes

| Mode | Behavior |
|------|----------|
| (default) | Dry-run: scan + report, no changes |
| `--fix` | Delete/archive files marked DELETE/ARCHIVE after user confirmation |
| `--focus dead-files` | Run only PH-DEAD-FILES + PH-DEAD-CODE probes |
| `--focus deps` | Run only PH-STALE-DEPS probe |
| `--focus duplicates` | Run only PH-DUPLICATES + PH-ARCHIVE-DUPS probes |

## Execution Steps

**Step 1 — Identify input**
Parse the user's request to extract:
- Target: directory or "full project" (default: git root)
- Mode: default (dry-run), `--fix` (apply changes), `--focus` (subset)
- Exclusions: directories to skip (default: skip paths in .gitignore)

Read `ENVIRONMENT.md` if it exists — extract project language, framework, working directories.

**Step 2 — Build file inventory**
Run `git ls-files` to get all tracked files with sizes.
Build inventory: {path, size_bytes, extension, last_modified_commit, directory}.
Calculate total_tracked_bytes for waste ratio scoring.

**Step 3 — Execute Probes**

Read `references/probe-definitions.md` for detection methods and thresholds.

Run all 10 probes (or subset per --focus):

1. **PH-DEAD-FILES**: Find non-source files with zero references anywhere in codebase.
   **Scope:** Config, docs, data, assets, scripts — NOT source code files (.ts, .vue, .py, .go, etc.).
   Orphan source files are owned by `probekit-code-audit` (Section 13) which uses import analysis + LOC-based severity.
   - For each non-source file: grep its filename (without extension) across all other files
   - Exclude: package manifests (package.json, tsconfig, etc.), entry points (index.html)
   - Verify: also check git log for recent activity (< 30 days = grace period)

2. **PH-DEAD-CODE**: Find unused exports, functions, variables within files.
   - For each source file: extract exported symbols, grep for usage elsewhere
   - Focus on: exported functions never imported, exported constants never used
   - Skip: type exports (interfaces, types — may be used implicitly)

3. **PH-DUPLICATES**: Find files with identical or near-identical content.
   - Compare file sizes first (quick filter), then content hash for exact matches
   - For near-duplicates: compare first 50 lines of files with same name in different dirs

4. **PH-STALE-DEPS**: Find packages declared but never imported in code.
   - Read package.json dependencies + devDependencies
   - For each: grep for package name in import/require statements across all source files
   - Skip: packages used via CLI (eslint, prettier, vitest, husky, lint-staged, vue-tsc)
   - Skip: Vite plugins (configured in vite.config.ts, not imported in src/)

5. **PH-UNUSED-CONFIG**: Find dead config entries.
   - Read .env.example: for each variable, check if used in code (process.env.X or import.meta.env.X)
   - Read config files: check for sections/keys with no code reference

6. **PH-ORPHAN-TESTS**: Find test files whose target module no longer exists.
   - For each test file: extract the module it imports (e.g., auth.test.ts → stores/auth.ts)
   - Check if the target module still exists on disk

7. **PH-ARCHIVE-DUPS**: Find files in archive/ directories that are copies of active files.
   - For each file in archive/: check if an identical file exists in docs/, src/, or other active dirs
   - Compare by content hash, not just filename

8. **PH-EMPTY-DIRS**: Find empty directories and .gitkeep-only directories.
   - Walk directory tree, find dirs with 0 files or only .gitkeep
   - Skip: directories that are placeholders for future modules (check if referenced in docs)

9. **PH-STALE-DOCS**: Find documentation with broken internal references.
   - For each .md file in docs/: extract file path references (e.g., `src/api/users.ts`)
   - Check if referenced paths actually exist on disk
   - Flag broken references as stale documentation

10. **PH-GIT-BLOAT**: Find large binary files tracked by git.
    - List all git-tracked files > 100KB
    - Flag binary files (images, archives, compiled assets) that could use Git LFS
    - Flag files > 500KB as CRITICAL regardless of type

**Step 4 — Classify and justify**

Read `references/action-types.md` for action classification rules.

For each finding, assign:
- **Severity**: 🔴 CRITICAL / 🟡 WARNING / 🟢 SUGGESTION
- **Action**: DELETE / ARCHIVE / CONSOLIDATE / REVIEW
- **Justification**: specific proof (e.g., "0 imports found via grep", "identical hash to docs/02_spec/01_Declaration.md")
- **Safety**: what breaks if removed (usually "nothing — zero references")

**Step 5 — Score**

Calculate waste metrics:
```
waste_bytes = sum(all DELETE-recommended file sizes)
waste_ratio = waste_bytes / total_tracked_bytes
severity_points = (critical × 1.5) + (warning × 0.5) + (suggestion × 0.1)
score = max(1, min(10, 10 - severity_points))
```

Quality gate:
- PASS: waste_ratio < 5%, 0 CRITICAL
- WARN: waste_ratio 5-15% or 1-2 CRITICAL
- FAIL: waste_ratio > 15% or 3+ CRITICAL

**Step 6 — Write report**

Save to `{report_dir}/HYGIENE-{YYYYMMDD}.md` using output-template.md format.

**Step 7 — Apply fixes (if --fix)**

If `--fix` mode:
1. Show the full action plan to user
2. Wait for confirmation
3. For DELETE actions: `git rm` the file
4. For ARCHIVE actions: `git mv` to archive/ directory
5. Create recovery manifest listing removed files with git SHAs
6. Stage changes but do NOT commit — let user review and commit

**Step 8 — Update audit tracker (if exists)**

Read `probekit-core/references/audit-tracker-format.md`.
Append row to `{report_dir}/AUDIT-TRACKER.md`.

## Anchor

[*] project-hygiene v1.0.0 * ready
[>] | NEXT: user command
