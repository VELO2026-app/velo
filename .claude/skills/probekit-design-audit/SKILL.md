---
name: probekit-design-audit
description: "v1.0.0 | Design token compliance for VELO's Vue 3 frontend. Checks colors, fonts, spacing, radius, shadows against variables.css, the derived reference. Use when: 'design audit', 'check design tokens', 'brand compliance', 'color check', 'дизайн аудит'."
---

# design-audit v1.0.0

Design token compliance audit for VELO's Vue 3 frontend.
Judges SCREENS against the SYSTEM: do components and views use the tokens in
`variables.css`, or do they bypass them?

## Configuration

<!-- VELO-tuned (PROMPT №436): CBS's mockups/frontend/* paths swapped for VELO's
     real tree.

     brand_ref: VELO HAS NO BRAND DOCUMENT, and one must NOT be invented -- the
     brand standard is the operator's to define, and a made-up one would be a
     fake authority that this skill then enforces. Instead the reference is
     DERIVED from VELO's own token file by scripts/derive_token_reference.py.
     That is not circular: the skill judges SCREENS against the SYSTEM, and the
     system is 204 semantically-named tokens in a 439-line file -- reading it is
     not making up a standard. (Operator ruling, PROMPT №436.)

     The narrow circularity risk IS real: if a bad token already lives in the
     system, naive derivation encodes it as canonical. That is why the generator
     FLAGS, and never BLESSES -- see the rule below. -->
source_dir: frontend/src
token_file: frontend/src/styles/variables.css
brand_ref: (none — derived; see scripts/derive_token_reference.py)
report_dir: .tmp/probekit-review

## THE RULE: FLAG, DO NOT BLESS

The generator reports suspicious things as QUESTIONS for a human. It NEVER
auto-deletes a token, NEVER auto-merges a duplicate, and NEVER encodes a flagged
value as canonical. The operator is the design authority; a collision may be
deliberate.

## THE READ-PATH RULE (why a naive audit lies here)

A token is used if EITHER `var(--x)` appears, OR its NAME appears as a string.
Both paths are mandatory. Three traps in this repo, all verified PROMPT №436:

1. **By-name reads.** 13 `--velo-fog-*` tokens have ZERO `var()` usages and are
   read by name via `getComputedStyle` (`MobileLayout.vue:150-161` through a
   `tok()` helper; same in `UserShell.vue`, `MasterShell.vue`). A `var()`-only
   counter calls them dead. Deleting them deletes working layout.
2. **Runtime-defined (the mirror).** `--velo-frozen-vh` and `--velo-vvh` are
   never in `variables.css`; they are WRITTEN by `setProperty()` in
   `useBackgroundStabilizer.ts:74,99,104` and read as
   `var(--velo-frozen-vh, 100lvh)`. "Referenced but undefined" is true only from
   the CSS file's point of view. They are not dangling.
3. **Mask alpha, not colour.** The 20 `#000` in `.vue` `<style>` blocks are all
   inside `mask-image` gradients — an alpha channel, not a brand colour. A naive
   "hardcoded colour" probe raises 20 CRITICALs and a "fix" breaks the fog masks.
   Real hardcoded colours in `.vue` styles: ZERO.

## The generator

`python .claude/skills/probekit-design-audit/scripts/derive_token_reference.py`
(`--json` for machine output). Run from the repo root. Emits the derived
reference plus the questions list: duplicate values under different names,
zero-use, single-use, near-miss drift, runtime-defined, genuinely undefined,
naming splits, and the raw-literal bypass counts.

## Probes

Read `references/probe-definitions.md` for full probe specifications.

LIVE — P1: Hardcoded Colors (CRITICAL), P2: Font Compliance (HIGH),
P3: Spacing Tokens (MEDIUM), P4: Radius Tokens (MEDIUM), P5: Shadow Tokens (MEDIUM).

INERT — P6: Dark Mode (HIGH). VELO has no dark mode; the probe finds nothing and
its silence is not a pass. Kept: it is one theme away from mattering.

DROPPED for VELO (PROMPT №436) — P7: Logo Icon Color enforced CBS's orange-logo
rule; neither token nor brand exists here. P8: Token Sync diffed a second copy of
variables.css; VELO has exactly one, and it says so itself (variables.css:4-5).
Numbering is deliberately NOT reshuffled, so older reports stay readable.

## Execution Steps

0. Run `scripts/derive_token_reference.py` — derive the reference and the
   questions list. Read THE READ-PATH RULE above first; a var()-only count lies.
1. Read variables.css — build token map
2. Run the LIVE probes (P1–P5)
3. Classify findings by severity (P1/P2/P3)
4. Output report per `references/output-template.md`
5. FLAG, DO NOT BLESS: questions go to the operator; do not resolve them here.

## Output Format

```markdown
# Design Audit Report — VELO Frontend
Date: {date}
Target: {source_dir}

## Summary
| Probe | Status | Findings |
|-------|--------|----------|
| P1 Hardcoded Colors | PASS/FAIL | N issues |
| ... | ... | ... |

## Findings
### P1: {description}
| # | Severity | File:Line | Issue | Fix |
```

## Anchor

[*] design-audit v1.0.0 * ready
