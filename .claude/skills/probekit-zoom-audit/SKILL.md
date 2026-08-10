---
name: probekit-zoom-audit
description: "v1.0.0 | Static audit of VELO's Zoom integration code — no live account, no credentials, no mocked test generation. Checks token-cache latency assumptions, account-vs-per-meeting setting authority, write-only Zoom fields, identification-chain overreach, meeting-deletion asymmetry, collapsed failure states, stub-mode divergence, the attendance lock (SW1), and env-only knob drift. Use when: 'zoom audit', 'check zoom integration', 'audit zoom code', 'zoom regression check', 'аудит зум'."
---

# zoom-audit v1.0.0

Static audit of VELO's Zoom integration code. Judges OUR CODE against assumption-patterns we
have already gotten wrong on this account — three separate instances inside twenty-four hours
(PROMPT №617-622: zero recordings existed because nothing set `auto_recording`; an S2S scope
believed unavailable turned out to be a console setting away; a Cyrillic convert-token shipped
twice before a whole-diff scan caught it). What repeats is OUR OWN code, not Zoom's API — so
that is what this skill hunts.

## Scope, ruled by the owner (PROMPT №624) — read before running or extending this skill

Two other shapes were considered and rejected:

- **A mock-driven integration-test generator.** Rejected: it would only verify our own
  ASSUMPTIONS about how Zoom behaves, encoded as mock responses. A wrong assumption stays green
  forever under a mock that agrees with it — the exact failure mode `probekit-integration-test`
  and `probekit-e2e-bdd-test` exist to avoid for API/DB seams elsewhere, and it would be worse
  here specifically because Zoom's real behavior has already surprised this codebase multiple
  times (recording never enabled, S2S scope reports contradicting each other, account settings
  overriding per-meeting fields).
- **A live-account checklist.** Rejected for THIS deliverable, not forever: exercising the real
  Zoom account needs credentials and the owner's hands on the console — that is a runbook, not
  something an agent can run unattended. It may come later as a separate, explicitly-scoped
  piece; this skill is not it and must not grow live calls into itself.

This skill therefore: reads code, greps code, never calls `api.zoom.us`, never needs
`ZOOM_ACCOUNT_ID`/`ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET`, and never writes a test file. If a
finding needs live-account confirmation to resolve, the report says so and stops — it does not
attempt the call.

## Configuration

```
source_dir: backend/app/modules/zoom
also_scans:
  - backend/app/modules/bookings/          # entitlement + the recording endpoint (P7 reference)
  - backend/app/modules/practices/cancel_service.py   # sole ZoomMeeting-deletion call site (P6)
  - backend/app/modules/practices/service.py          # ZOOM_VISIBLE_BOOKING_STATUSES, zoom_link gating
  - backend/app/core/config.py             # is_zoom_stub, the two env-only knobs (P8, P10)
  - backend/tests/test_zoom_*.py           # stub-vs-real coverage check (P8)
frontend_touchpoints:                       # secondary sweep, P5/P6/P7 principles only —
                                             # everything else in this file is backend-only by
                                             # construction (token cache, stub mode, the lock,
                                             # env knobs are backend concepts with no frontend
                                             # analogue)
  - frontend/src/utils/zoomLink.ts
  - frontend/src/views/user/PracticeLiveView.vue
  - frontend/src/views/user/PracticeDetailView.vue
  - frontend/src/views/user/UserDashboardView.vue
  - frontend/src/views/master/MasterDashboardView.vue
report_dir: .tmp/probekit-review
```

## Probes

Read `references/probe-definitions.md` for full probe specifications (P1–P10, all LIVE):
P1: Zero-Result False Positives (CRITICAL, process rule), P2: Token-Cache Latency Assumptions
(WARNING), P3: Account-Level Settings Overriding Per-Meeting Fields (WARNING), P4: Write-Only
Zoom Fields (WARNING), P5: Identification-Chain Overreach (CRITICAL), P6: Deletion-Asymmetry
Assumptions (WARNING), P7: Collapsed Failure States (CRITICAL), P8: Stub-Mode Divergence
(WARNING), P9: Attendance Lock Weakening — SW1 (CRITICAL), P10: Env-Only Knob Documentation
Drift (WARNING).

## Execution Steps

1. **Run P1's control first**, before anything else — confirm the scan can find real Zoom code
   at all (`references/probe-definitions.md` P1). If the control fails, STOP: fix the scan
   scope before running P2–P10, or every "clean" result below is meaningless.
2. Read `source_dir` + `also_scans` — build a map of every Zoom-touching function and its
   callers (`grep -rln "zoom" backend/app/modules/` as the starting net, then follow imports).
3. Run P2–P10 against that map. For each probe, run its Detection command, then READ every hit
   (`probekit-core/references/validation-anti-bias.md` Rule 1 — FIRSTHAND: a grep hit is a
   candidate, not a finding, until the surrounding code is actually read).
4. Sweep `frontend_touchpoints` for P5/P6/P7 only — the other seven probes have no frontend
   analogue and should not be forced onto frontend files.
5. Classify every surviving candidate by severity (core `severity-format.md` decision tree),
   using each probe's CRITICAL/HIGH/MEDIUM/LOW default tier as the starting point, not the
   final word — a specific instance can be more or less severe than its probe's default.
6. Output the report per the format below. **FIX NOTHING.** This skill audits; it does not
   patch. Every finding is reported for a human decision, even an obvious-looking one.
7. If a probe finds ZERO issues, say so explicitly AND name what proved the probe could have
   fired (the P1 control, or a second independent pattern per Rule 2 of the anti-bias
   reference) — a silent zero is the result P1 exists to distrust.
8. Append one row to `AUDIT-TRACKER.md` per `probekit-core/references/audit-tracker-format.md`
   (skill: `zoom-audit`, key metric: `N findings across P1-P10`).

## Output Format

```markdown
# Zoom Audit Report — VELO Backend
Date: {date}
Target: backend/app/modules/zoom/ (+ bookings/, practices/cancel_service.py, core/config.py)
P1 control: {PASS/FAIL — command run + result}

## Summary
| Probe | Status | Findings |
|-------|--------|----------|
| P1 Zero-Result False Positives | ... | N |
| P2 Token-Cache Latency | ... | N |
| ... | ... | ... |

## Findings
### P5: Identification-Chain Overreach
🔴 CRITICAL — {short description}
Location: {file:line}
Issue: {what's wrong}
Impact: {what will happen if not fixed}
Fix: {NOT applied — for the owner's next batch}
```

Findings-only report — no fixes applied, no code touched, per Hard Constraint above.

## Anchor

[*] zoom-audit v1.0.0 * ready
