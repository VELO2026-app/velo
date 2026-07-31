---
name: probekit-security-audit
description: "Security code review scanning source for OWASP Top 10, hardcoded secrets, insecure defaults, and auth/authz gaps. Use for a security audit or to find vulnerabilities."
---

# security-audit v1.3.0

**Triggers:** `security audit`, `security review`, `find vulnerabilities`, `check for secrets`, `/probekit-security-audit`, `пробкит безопасность`, `пробкит секьюрити`.

Security-focused code review for Claude Code. Produces a scored report with
severity markers and concrete fix recommendations.

**Scope**: code-level security only. Does NOT cover infrastructure, network
security, or runtime scanning — only what Claude Code detects by reading source.

## Configuration

<!-- VELO-tuned (PROMPT №386, sweep): CBS's docs/01_refer path replaced with a
     git-untracked scratch dir; VELO has no docs/01_refer/ or ENVIRONMENT.md. -->
report_dir: .tmp/probekit-review

## Execution Steps

**Step 1 — Identify input**
Parse the user's request to extract:
- Target: file path, directory, or "current project"
- Focus hint: e.g. `-- focus on auth` or `-- focus on API`
- `--fix` flag → auto-fix safe patterns (e.g., replace `verify=False` with `verify=True`)
- If no target → ask: "What should I audit? Provide a file path, directory, or describe the scope."

Read `ENVIRONMENT.md` if it exists — extract project language, framework.
(VELO note, PROMPT №386: no ENVIRONMENT.md in this repo -- language/framework is known:
Vue 3 + TS frontend, FastAPI + Python backend. Shell is Windows Git-Bash/PowerShell;
no docker/VPS locally.)

**Step 2 — Detect environment**
Detect project language and framework from imports and file extensions.
This determines which detection patterns to apply from references.

**Step 3 — OWASP Top 10 scan**
Read `references/owasp-checklist.md`.

For each applicable OWASP category, scan target files for detection patterns:
- A01: Broken Access Control — IDOR, missing auth checks, path traversal
- A02: Cryptographic Failures — weak hashing, hardcoded keys, disabled TLS verification
- A03: Injection — SQL injection, command injection, XSS sinks, template injection
- A04: Insecure Design — missing rate limiting, no input validation framework
- A05: Security Misconfiguration — debug=True, CORS=*, verbose errors in prod
- A06: Vulnerable Components — (defer to dependency-audit, note if manifest exists)
- A07: Auth Failures — weak password policy, missing MFA hooks, session fixation
- A08: Data Integrity — insecure deserialization, missing CSRF protection
- A09: Logging Failures — missing security event logging, PII in logs
- A10: SSRF — unvalidated URL fetching from user input

For each finding: record severity (🔴/🟡 per `references/severity-format.md`), file:line, OWASP category, CWE, fix suggestion.

**Step 3.5 — Data Flow Tracing**

Read `references/data-flow-tracing.md`.

Trace sensitive data from entry to storage/exit:
1. Identify sensitive data entry points (user input, API payloads, file uploads, webhook bodies)
2. For each entry point, trace the data through the code:
   - Where is it validated/sanitized?
   - Where is it stored (DB, file, cache, log)?
   - Where is it sent externally (API calls, emails, webhooks)?
   - Is it ever logged with PII intact?
3. Build a data flow map: Entry -> [Transform] -> [Store/Exit]
4. Flag paths where sensitive data flows without sanitization or encryption
5. Flag paths where sensitive data reaches logs or error messages

For each unprotected flow: record severity, source file:line, data type, flow path, fix suggestion.

**Step 4 — Secret detection**
Read `references/secret-patterns.md`.

Scan ALL files in target for hardcoded secrets using regex patterns:
- Cloud provider keys (AWS AKIA*, GCP AIza*, Azure connection strings)
- API keys (Stripe sk_live_*, OpenAI sk-*, GitHub ghp_*)
- Private keys (-----BEGIN RSA PRIVATE KEY-----)
- Generic patterns (password=, secret=, token= with literal values)
- Database connection strings with embedded credentials

Exclude:
- Files matching `.gitignore` patterns
- Test fixtures with obviously fake values (test123, example, placeholder)
- Environment variable references ($ENV, os.environ, process.env)
- Comments that document expected format (not actual secrets)

For each secret found: 🔴 CRITICAL severity.

**Step 5 — Auth/AuthZ matrix**
If auth-related code detected (login, JWT, session, OAuth):

Build matrix:
| Endpoint/Function | Auth Required? | AuthZ Check? | Owner Check? | Issue |
Scan for:
- Endpoints without auth middleware
- Auth checks without authorization (logged in but no role check)
- Missing owner verification on resource access (IDOR)
- JWT without signature verification
- Session without expiration

**Step 6 — Insecure defaults scan**
Scan for common insecure defaults that should be tightened:
- `DEBUG = True` / `debug: true` in non-test code
- `CORS(app, origins="*")` / `Access-Control-Allow-Origin: *`
- `ALLOWED_HOSTS = ['*']`
- `verify=False` / `rejectUnauthorized: false`
- `random` used for security tokens instead of `secrets`/`crypto`
- Weak crypto: MD5/SHA1 for passwords, DES, RC4, ECB mode

**Step 7 — Report**
Read `references/output-template.md`.
Build final report grouped by OWASP category.
Save to `{{report_dir}}/SECURITY-AUDIT-<target>-<YYYYMMDD>.md`

**Step 7.5 — Fix mode (if --fix)**
Read `probekit-core/references/auto-fix-safety.md` — follow Safety Checklist and Fix-Verify-Revert Protocol.
For each 🔴 finding with a safe auto-fix (per core checklist):
- `verify=False` → `verify=True`
- `DEBUG = True` → `DEBUG = os.environ.get('DEBUG', 'False') == 'True'`
- `import random` for tokens → `import secrets`
Apply fix, verify with tests, show diff, note in report using standard auto-fix table format.
Do NOT auto-fix: auth logic, SQL queries, complex patterns (per core NEVER-fixable list).

**Step 8 — Update audit tracker**
Read or create `{{report_dir}}/AUDIT-TRACKER.md`.
Append entry with: skill=`security-audit`, key findings count by OWASP category.

## Relationship to code-audit

Deeper than code-audit Section 4: full OWASP Top 10 with CWE mapping, secret
scanning, auth/authz matrix, and insecure-defaults catalog. They do not conflict.
See `references/user-guide.md` for invocation examples.

## Anchor

[*] security-audit v1.2.0 * ready
[>] | NEXT: user command
