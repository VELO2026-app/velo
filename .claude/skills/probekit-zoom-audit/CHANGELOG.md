# Changelog

## v1.0.0 — 2026-07-29

### Features
- **10 static probes**, all VELO-native — this skill has no upstream CBS ancestor, unlike
  most of the family (`probekit-design-audit`, `probekit-responsive-audit`, `probekit-a11y-audit`
  all trace to a CBS HOME original); every probe here was authored directly against a real
  defect already paid for in this repo or on this Zoom account (PROMPT №617-622).
- **P1 is a process rule, not a code pattern**: every other probe must prove it can fire
  (a control on known-present Zoom code) before reporting "0 findings" — the direct
  operationalization of `probekit-core/references/validation-anti-bias.md` Rule 2, pointed at
  this specific domain.
- **Static only, by owner ruling**: no live Zoom API calls, no credentials, no mocked
  integration-test generation. Two rejected alternative shapes recorded in SKILL.md's Scope
  section so they are not re-proposed without re-reading why they were declined.
- **Findings-only**: this skill never modifies code, unlike `code-audit`/`type-audit`'s
  optional `--fix` mode — every finding is reported for a human batch, always.

Toolchain: written directly against the repo (no `probekit-tools-CBS-Home` derivation) —
authored by Orchestrator-75, PROMPT №624.
