---
name: probekit-dependency-audit
description: "Dependency analysis skill. Audits manifest files for version pinning, typosquatting, abandonment signals, suspicious install scripts, and import/manifest mismatches. Triggers on: 'dependency audit', 'check dependencies', 'audit packages', 'typosquatting check', '/probekit-dependency-audit', 'пробкит зависимости', 'пробкит пакеты'."
---

# dependency-audit v1.1.0

Dependency analysis skill for Claude Code.
Reads manifest and lock files to audit version pinning, detect suspicious
packages (typosquatting), check for abandonment signals, and verify that
all imports have corresponding manifest entries.

**Scope**: static analysis of manifest files and import statements.
Cannot check CVE databases or download packages at runtime.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's docs/01_refer path replaced with the
     git-untracked scratch dir the rest of the family already uses (dda9a6f,
     PROMPT №385). VELO has no docs/01_refer/. -->
report_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Find manifest files**
Scan target for dependency manifest files:
- Python: `requirements.txt`, `requirements/*.txt`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile`, `poetry.lock`, `pip.lock`
- Node: `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- Go: `go.mod`, `go.sum`
- Rust: `Cargo.toml`, `Cargo.lock`
- Java/Kotlin: `build.gradle`, `pom.xml`
- Ruby: `Gemfile`, `Gemfile.lock`

If no manifest found → report: "No dependency manifests found." and stop.

**Step 2 — Version pinning audit**
Read `references/version-pinning.md`.

For each dependency in manifest:
- Check pinning level: unpinned → lower bound → range → compatible → exact → exact+lock
- Flag 🔴 CRITICAL: unpinned (`requests`, `"*"`, `"latest"`) or lower-bound only (`>=2.0`)
- Flag 🟡 WARNING: range without lock (`>=2.28,<3` without lock file), caret/tilde in npm without lockfile
- Flag 🟢 OK: exact pin or lock file present

Check for lock file:
- Lock file exists and is committed → good
- Lock file missing for production project → 🟡 WARNING
- Lock file in `.gitignore` → 🔴 CRITICAL

**Step 3 — Suspicious package detection**
Read `references/risk-signals.md`.

For each dependency name, check:
1. **Typosquatting**: Levenshtein distance ≤ 2 from top-500 packages in ecosystem
   - Character substitution: `0/o`, `1/l/i`, `rn/m`
   - Missing/doubled characters
   - Hyphen/underscore confusion
   - Flag: 🔴 CRITICAL if distance = 1 from popular package

2. **Install scripts** (npm only): Check `package.json` for suspicious `preinstall`/`postinstall`
   - 🔴 if script contains: `curl`, `wget`, `http.get`, `child_process`, `eval`
   - 🟡 if `node-gyp rebuild` on non-native package

3. **Import/manifest mismatch**: Scan source code for imports not in manifest
   - Python: `import X` where X not in requirements
   - Node: `require('X')` / `import X from 'X'` where X not in package.json
   - Flag: 🟡 WARNING (may be stdlib or dev dependency)

**Step 3.5 — Phantom dependency detection (reverse-check)**

Scan source code for actual import usage, then compare against manifest:

1. Collect all unique third-party imports from source code:
   - Python: `import X`, `from X import ...` (exclude stdlib modules)
   - Node: `require('X')`, `import ... from 'X'` (exclude relative paths)
   - Go: `import "X"` (exclude stdlib)
2. Collect all dependency names from manifest files
3. Cross-reference:
   - **Phantom dependency**: in manifest but never imported by source code
     - 🟡 WARNING: package in requirements.txt/package.json but zero imports in src/
     - Exclude: plugins, CLI tools, type stubs, runtime-only deps (e.g., uvicorn, gunicorn)
     - If manifest has comment explaining why → downgrade to 🟢 SUGGESTION
   - **Shadow import**: imported in code but not in manifest (already covered in Step 3.3)
4. Report phantom dependencies with:
   - Package name and version from manifest
   - Grep result showing zero matches in source code
   - Recommendation: verify if runtime-only or truly unused, then remove

**Step 4 — Abandonment signals**
For each dependency, check what's observable from manifest/lock:
- Version date (if in lock file): last update > 2 years → 🟡 WARNING
- `deprecated` field in package.json → 🟡 WARNING
- Known abandoned packages list (hardcoded top-20 known cases)

Note: Claude Code cannot query npm registry or PyPI API. Flag only what's visible in local files.

**Step 5 — Report**
Read `references/output-template.md`.
Build report with:
- Pinning summary table (per dependency: name, version spec, pinning level, severity)
- Suspicious packages (if any)
- Import/manifest mismatches
- Abandonment signals
- Overall pinning score

Save to `{{report_dir}}/DEPENDENCY-AUDIT-<target>-<YYYYMMDD>.md`

**Step 6 — Update audit tracker**
Append entry to `{{report_dir}}/AUDIT-TRACKER.md`.

## Limitations

Claude Code **cannot**:
- ❌ Query CVE/NVD database for known vulnerabilities
- ❌ Download and inspect package source code
- ❌ Check npm/PyPI registry for maintainer changes
- ❌ Run `npm audit` or `pip-audit` (but can recommend them)

Claude Code **can**:
- ✅ Read lock files and check version pinning
- ✅ Detect typosquatting by name similarity to popular packages
- ✅ Check install scripts in package.json
- ✅ Verify all imports have manifest entries
- ✅ Detect phantom dependencies (in manifest, not in code)
- ✅ Detect abandoned packages from visible signals

## Quick Reference

See `references/user-guide.md` for invocation examples.

## Anchor

[*] dependency-audit v1.1.0 * ready
[>] | NEXT: user command
