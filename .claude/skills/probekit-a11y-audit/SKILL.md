---
name: probekit-a11y-audit
description: "v1.0.0 | Accessibility audit for VELO's Vue 3 frontend. Checks ARIA roles, contrast, keyboard nav, focus management, screen reader, semantic HTML, form labels, skip links. Use when: 'a11y audit', 'accessibility check', 'WCAG check', 'screen reader audit', 'доступность'."
---

# a11y-audit v1.0.0

Accessibility compliance audit for VELO's Vue 3 frontend.
Verifies WCAG 2.1 AA compliance across all components and views.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's mockups/frontend/* paths swapped for VELO's
     real tree. review_dir ADDED -- it was referenced by Step 5 below but never
     defined anywhere in this skill, so the tracker path was undefined.

     WHY THIS SKILL APPLIES HERE, despite the Mini App being RU-only: RU-only is
     an i18n property, not an accessibility one. Screen readers, keyboard focus
     order, contrast and form labels are orthogonal to how many languages ship.
     (Argued and accepted, PROMPT №435.)

     ONE INERT STEP -- marked, NOT rewritten: Step 3.4 "Cross-reference with
     i18n (ARIA labels must be translated)". VELO has no i18n surface today
     (LanguageTimezoneView.vue:13 says so in the product's own words), so there
     is nothing to cross-reference and that check silently finds nothing. Its
     silence is NOT a pass. It comes back when multi-language lands -- see
     probekit-i18n-audit, which is PAUSED for the same reason. -->
source_dir: frontend/src
index_html: frontend/index.html
review_dir: .tmp/probekit-review

## Probes

Read `references/probe-definitions.md` for full probe specifications (P1-P8):
P1: Semantic HTML (CRITICAL), P2: ARIA Roles & Attributes (HIGH),
P3: Keyboard Navigation (CRITICAL), P4: Focus Management (HIGH),
P5: Color Contrast (HIGH), P6: Form Labels (CRITICAL),
P7: Skip Links & Landmarks (MEDIUM), P8: Screen Reader Text (MEDIUM).

## Execution Steps

**Step 0 — Environment Detection**

Read `probekit-core/references/environment-detection.md`.
Detect OS, shell, project root.

**Step 1 — Load Severity Rules**

Read `probekit-core/references/severity-format.md` — universal severity markers.
Read `references/severity-format.md` — a11y-specific escalation rules.

**Step 2 — Load Probe Definitions**

Read `references/probe-definitions.md` — full specification of all 8 probes.

**Step 3 — Execute Probes**

1. Read index.html — check lang attribute, skip links
2. Scan all .vue files for P1-P8
3. Check global.css for focus styles, contrast utilities
4. Cross-reference with i18n (ARIA labels must be translated)

**Step 4 — Score and Report**

Calculate per-probe scores (0-10) and weighted average.
Read `references/output-template.md` for report format.

**Step 5 — Update Audit Tracker**

Read `probekit-core/references/audit-tracker-format.md`.
Append row to `{{review_dir}}/AUDIT-TRACKER.md`.

## Quality Gate

**PASSES** when:
- Average score >= 7.0/10
- Zero CRITICAL findings
- All interactive elements keyboard-accessible

**WARN** when:
- Average score >= 5.0/10 but < 7.0
- OR 1-2 CRITICAL findings with clear fix path

**FAIL** when:
- Average score < 5.0/10
- OR 3+ CRITICAL findings
- OR any probe scores 0/10

## Quick Reference

Invoke:
- `/probekit-a11y-audit src/components/` — audit components
- `/probekit-a11y-audit src/views/` — audit views
- `/probekit-a11y-audit .` — full project a11y audit

## Changelog

### v1.0.0 (2026-04-14)
- Initial release: 8 probes, WCAG 2.1 AA target
- Probes: semantic HTML, ARIA, keyboard nav, focus, contrast, labels, landmarks, screen reader

## Anchor

[*] a11y-audit v1.0.0 * ready
[>] | NEXT: user command
