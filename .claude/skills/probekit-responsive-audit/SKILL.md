---
name: probekit-responsive-audit
description: "v1.0.0 | Responsive layout audit for VELO's Vue 3 Mini App frontend. Checks safe-area, dvh units, touch targets, viewport meta, sticky/fixed, breakpoints. Use when: 'responsive audit', 'check breakpoints', 'mobile check', 'layout audit', 'адаптивность'."
---

# responsive-audit v1.0.0

Responsive layout audit for VELO's Vue 3 frontend.
Verifies components work in the Telegram Mini App webview.

## Configuration

<!-- VELO-tuned (PROMPT №435): CBS's mockups/frontend/* paths swapped for VELO's
     real tree.

     WHY THIS SKILL MATTERS MORE HERE, NOT LESS: VELO is a Telegram Mini App. It
     renders in a webview whose height changes as Telegram's own chrome and the
     soft keyboard come and go -- so P2 (safe-area) and P8 (dvh units) are load-
     bearing here in a way they never are on a normal desktop-first site, where
     they are usually cosmetic. The Mini App is exactly the case they were
     written for. (Argued and accepted, PROMPT №435.)

     P6 (RTL Layout) is DROPPED, not inert -- VELO ships no RTL locale and the
     probe needs one to exist before it can mean anything. See
     references/probe-definitions.md for the removal note and the verbatim
     checks to restore if RTL ever lands. P7/P8 keep their numbers on purpose,
     so older reports stay readable.

     No review_dir: this skill reports to chat and never writes a file (Step 4
     below). Left as upstream designed it -- adding a report destination is a
     design change, not a path fix. -->
source_dir: frontend/src
index_html: frontend/index.html

## Probes

Read `references/probe-definitions.md` for full probe specifications
(P1–P5, P7–P8 — P6 is dropped for VELO, see above):
P1: Viewport Meta (CRITICAL), P2: Safe Area (HIGH), P3: Touch Target Size (HIGH),
P4: Flex/Grid Layout (MEDIUM), P5: Sticky vs Fixed (HIGH),
P7: Breakpoint Consistency (MEDIUM), P8: dvh Units (LOW).

## Execution Steps

1. Read index.html — check viewport meta
2. Read global.css — check safe-area
3. Scan components for P1-P8
4. Classify and report

## Anchor

[*] responsive-audit v1.0.0 * ready
