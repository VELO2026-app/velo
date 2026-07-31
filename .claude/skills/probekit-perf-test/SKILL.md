---
name: probekit-perf-test
description: "Performance testing skill for Claude Code. Generates, runs, and analyzes load/stress/spike/soak/smoke tests against HTTP APIs, endpoints, and services. Triggers on: 'run load test', 'performance test', 'stress test', 'check how many users', 'how will this handle traffic', '/probekit-perf-test', or when a user asks about throughput, latency, RPS, or system capacity, 'пробкит нагрузка', 'пробкит перф'."
---

# perf-test v1.2.0

Performance testing skill. Discovers endpoints, generates test scripts,
runs tests, analyzes results with p50/p95/p99 metrics, and produces a
scored report with pass/fail gates. Supports k6, Locust, Artillery,
pytest-benchmark, and stdlib fallback — auto-detected from project environment.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's docs/01_refer path replaced with the
     git-untracked scratch dir the rest of the family already uses (dda9a6f,
     PROMPT №385). VELO has no docs/01_refer/.

     NO LOCAL TARGET -- read this before running (PROMPT №435). This skill needs
     a live HTTP endpoint. VELO's backend runs in Docker on the VPS; there is no
     local API and no Docker locally, so the only reachable targets are the
     shared TEST and PROD servers. Do NOT point a load/stress/spike/soak run at
     either without the operator's explicit go: TEST is what the tester is
     signing off on, and PROD is real users. A smoke run against TEST is the
     only mode that is reasonable by default. Thresholds below are the CBS
     generic defaults and have NOT been calibrated to VELO's traffic. -->
report_dir: .tmp/probekit-review
default_thresholds:
  p95_ms: 500
  p99_ms: 1500
  error_rate_pct: 1.0   # hard FAIL threshold; 3-tier: PASS < 0.5%, WARN 0.5–1.0%, FAIL > 1.0% — see metrics-thresholds.md
slo:                     # optional — enables SLO Compliance section in report
  # latency_p95_ms: 200
  # latency_p99_ms: 1000
  # max_error_rate: 0.001   # 0.1%
  # min_rps: 500

## Execution Steps

**Step 1 — Identify input**
Parse the user's request to extract:
- Target: URL, file path, directory, service name, or "current project"
- Test type hint: load / stress / spike / soak / smoke (if stated; else auto-select)
- Focus hint (e.g. `-- focus on checkout flow`) — text after `--` or `—`
- `--dry-run` flag → generate script but do NOT execute it
- `--type=<smoke|load|stress|spike|soak>` → override auto-selection
- `--profile` flag → run profiler in parallel with load test (see Step 8.5)
- `--slo <spec>` → define SLO targets inline (e.g. `--slo p95=200,p99=1000,error=0.1%,rps=500`)
- If no target → ask: "What should I test? Provide a URL, file path, or describe the service."

Read `ENVIRONMENT.md` if it exists — extract shell type, tool pitfalls, project path.

**Step 2 — Detect environment and tool**
Read `references/tool-detection.md`.
Detect which performance testing tool is available and appropriate.
Priority order: k6 → Locust → Artillery → pytest-benchmark → stdlib fallback.
Detect project language, framework, and existing test conventions.
Record: tool_name, run_command, script_extension, install_command (if tool missing).

If no tool is available:
- For Python projects → recommend Locust (`pip install locust`)
- For JS/Node projects → recommend k6 (`choco install k6` / `brew install k6`)
- Generate script for recommended tool, note installation step in report

**Step 3 — Discover endpoints and user flows**
Read the target:
- If URL provided → use directly as single endpoint
- If file/directory → scan for route definitions, API handlers, endpoint decorators
  Python: FastAPI/Flask/Django route patterns
  Node: Express routes, Next.js API routes
  Go: http.HandleFunc, gin.GET, echo.GET
  Other: detect by framework heuristics
- Build endpoint list with: method, path, expected response code, auth requirements
- Identify critical business flows (auth, CRUD operations, data-heavy endpoints)
- Flag endpoints that likely hit DB, external services, or file I/O — these are bottleneck candidates

If no routes found → scan for any HTTP calls in the codebase and test those.

**Step 4 — Select test type and profile**
Read `references/test-types.md`.
If `--type` flag given → use it.
Otherwise auto-select based on:
- First run / unknown baseline → smoke first, then load
- User says "how much can it handle" → stress
- User says "sudden traffic burst" → spike
- User says "memory leak" or "long run" → soak
- CI/CD context or quick check → smoke

Output: selected test type + rationale.

**Step 5 — Determine thresholds**
Read `references/metrics-thresholds.md`.
Start from Configuration defaults above.
Adjust based on:
- Endpoint type (static files get tighter limits than DB-heavy endpoints)
- Test type (soak and spike use different pass criteria — see metrics-thresholds.md)
- Any SLO hints from user or codebase (comments, README, config files)
Output: threshold table per endpoint or globally, noting any test-type overrides.

**Step 6 — Generate test script**
Read `references/tool-detection.md` for tool-specific script patterns.
Generate a complete, runnable test script:
- Parameterized base URL (env variable, not hardcoded)
- All discovered endpoints with appropriate HTTP methods and headers
- Realistic think time / sleep between requests (1–3s default)
- Thresholds embedded in script (k6 options / Locust @events / Artillery config)
- Response validation (status code + basic body check)
- Load profile from selected test type
- Comments explaining each section

Save script to: `tests/perf/<test_type>-<YYYYMMDD>.<ext>`
(e.g. `tests/perf/load-20260315.js` or `tests/perf/stress-20260315.py`)

**Step 7 — Run test (unless --dry-run)**
Execute the test script with appropriate command.
Use shell-safe quoting for the detected shell type.
Capture full stdout/stderr output.
If tool not installed → output install instruction, skip execution, set run_result = "not executed".
If execution fails (non-perf error: import error, syntax error, connection refused) →
  diagnose, fix script, retry once. If still fails → report error with diagnosis.

**Step 8 — Parse and analyze results**
Read `references/metrics-thresholds.md`.
Extract from test output:
- p50, p95, p99 latency per endpoint (or globally if tool doesn't support per-endpoint)
- RPS (requests per second) — peak and sustained
- Error rate (%)
- Total requests, failed requests
- Virtual users peak
- Any threshold violations reported by the tool

Apply pass/fail gate per the full 3-tier logic in metrics-thresholds.md:
- CRITICAL FAIL: error rate > 1.0% OR p99 > 3000ms
- WARNING:       p95 in 500–1000ms OR p99 in 1500–3000ms OR p99/p50 ratio > 2.5×
- PASS:          all thresholds met

For SPIKE tests only, apply spike-specific gate (see metrics-thresholds.md):
- CRITICAL FAIL: error rate > 5% OR system crashes and requires restart
- WARNING:       error rate 1–5% OR p95 does not recover within 30s post-spike

For SOAK tests only, apply soak-specific gate (see metrics-thresholds.md):
- CRITICAL FAIL: error rate > 1% at any point, or any sustained spike pattern
- WARNING:       p95 at end > 120% of p95 at start (degradation detected)
- PASS:          p95 at end ≤ 120% of p95 at start AND error rate < 1% throughout
  Note: record p95 at T=0 (first 2 minutes) and T=end (last 2 minutes) for comparison.

Identify bottleneck candidates:
- Endpoints with p99 > 3× their p95 → likely intermittent blocking
- Endpoints where error rate spikes before latency → capacity ceiling
- Endpoints where latency climbs linearly with VUs → no connection pooling

**Step 8.5 — Profiling analysis (optional)**
Run ONLY if `--profile` flag is set or user explicitly requested profiling.
Read `references/profiling-guide.md`.

1. Detect profiling tool for project language (py-spy / clinic.js / pprof)
2. If tool not installed → add 🟢 SUGGESTION to report: "Install <tool> for CPU profiling"
3. If tool available → run profiler in parallel with load test (see profiling-guide.md for commands)
4. Parse profiler output — identify top CPU consumers per slow endpoint
5. Match against 5 bottleneck patterns (Serialization, N+1, GC, Lock Contention, Regex)
6. Build "Bottleneck Analysis" section with concrete fix recommendations

If profiling was NOT run (no flag, no user request):
- Still produce a metrics-based Bottleneck Analysis using patterns from metrics-thresholds.md
- Note: "For deeper analysis, re-run with `--profile`"

**Step 9 — Produce report**
Read `references/output-template.md`.
Build final report. Adapt language to user's language.

Include these sections in order:
- Header, Environment, Endpoints Tested, Results (existing)
- Findings (existing)
- Bottleneck Analysis (from Step 8.5 — always present, depth depends on profiling)
- SLO Compliance (if SLO targets defined — see below)
- Generated Script, Next Steps, Final Score, Audit Tracker Update (existing)

**SLO Compliance section** (Step 9):
Read `references/slo-mapping.md`.
Check for SLO targets in this order:
1. `--slo` flag from user input
2. `.probekit.yml` → `perf.slo` section
3. `slo` section in Configuration above (if uncommented)
4. Codebase hints (SLO comments in config, README)
If SLO targets found → produce SLO Compliance section per slo-mapping.md format.
If no targets → note "No SLO targets defined" and skip section.

Save to `{{report_dir}}/PERF-TEST-<target>-<YYYYMMDD>.md`
Inform user of exact path.

**Step 9.5 — Update audit tracker**
Read or create `{{report_dir}}/AUDIT-TRACKER.md`.
Append entry per output-template.md Audit Tracker Update section.
Delta vs previous run: show latency regression/improvement.

## Quick Reference

See `references/user-guide.md` for invocation examples.

## Anchor

[*] perf-test v1.2.0 * ready
[>] | NEXT: user command
