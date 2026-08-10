# Responsive Audit — Probe Definitions

Responsive layout probes for VELO's Telegram Mini App frontend (VELO-tuned, PROMPT №435).
Breakpoints: phone (≤480px) is the tier VELO ships to; tablet (481-1024px) and desktop (>1024px) are informational.
Read severity from `probekit-core/references/severity-format.md`.

## P1: Viewport Meta (CRITICAL)

Verify `index.html` has correct viewport meta tag.

**Required:**
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

**Checks:**
- `width=device-width` present
- `initial-scale=1.0` present
- `viewport-fit=cover` present (for notch devices)
- No `maximum-scale=1.0` or `user-scalable=no` (accessibility violation)

## P2: Safe Area (HIGH)

Verify safe-area-inset usage for notch/home-indicator devices.

**Checks:**
- `env(safe-area-inset-top)` in header/toolbar
- `env(safe-area-inset-bottom)` in tab bar / bottom nav
- Body padding includes safe-area in `global.css`

**Detection:**
```bash
grep -rn 'safe-area' src/ --include='*.vue' --include='*.css'
```

## P3: Touch Target Size (HIGH)

Verify interactive elements meet 44x44px minimum (WCAG 2.5.5).

**Checks:**
- Buttons: min-height 44px (or padding achieves it)
- Tab bar items: min-height 44px
- Input fields: min-height 44px
- Links in text: adequate padding

**Detection:**
```bash
grep -rn 'height.*[0-3][0-9]px\|min-height.*[0-3][0-9]px' src/components/ --include='*.vue'
```

## P4: Flex/Grid Layout (MEDIUM)

Verify responsive patterns.

**Checks:**
- Shells use `display: flex; flex-direction: column`
- Content area uses `overflow-y: auto` (not `overflow: scroll`)
- No fixed widths > 390px on mobile elements
- Grid layouts use `auto-fit` or `auto-fill` for responsiveness

## P5: Sticky vs Fixed (HIGH)

Verify headers and tab bars use `position: sticky`, NOT `position: fixed`.

**Exception:** Only the shell wrapper may use fixed positioning.

**Detection:**
```bash
grep -rn 'position:\s*fixed' src/components/ --include='*.vue'
```

## P6: RTL Layout — DROPPED for VELO (PROMPT №435)

Upstream this probe verified RTL compatibility for CBS's Arabic locale. VELO
ships no Arabic and no RTL locale, and has no i18n surface at all today
(`LanguageTimezoneView.vue:13`), so every check here was guaranteed to be
vacuous: there is no `[dir="rtl"]` to find and nothing to override.

Dropped rather than left inert, because unlike the other inert probes this one
is not one config away from meaning something — it needs a whole RTL locale to
exist first. If VELO ever ships one, restore it from the upstream CBS skill
rather than reconstructing it from this note.

The probe count is now P1–P5 + P7–P8. Numbering is deliberately NOT renumbered:
P7/P8 keep their identities so older reports stay readable.

Removed detection, kept verbatim so a future restore is a copy-paste and not a
reconstruction — the checks were: flex direction respected (no hardcoded
`margin-left` without an RTL override); text alignment uses `start`/`end` rather
than `left`/`right`; `[dir="rtl"]` selectors present for directional components.
Detection was `grep -rn 'margin-left\|padding-left\|text-align:\s*left'` over
`src/components/`.

## P7: Breakpoint Consistency (MEDIUM)

If media queries are used, verify breakpoints match VELO's device reality.

<!-- VELO-tuned (PROMPT №435): CBS's livemockup-studio desktop-first breakpoints
     replaced. VELO is a Telegram Mini App -- it renders in a phone-sized webview,
     so the tablet/desktop tiers below are informational, not a target. The
     phone tier is the one that matters. -->
**Breakpoints:**
- Phone: ≤ 480px — the tier VELO actually ships to
- Tablet: 481px – 1024px
- Desktop: > 1024px

**Detection:**
```bash
grep -rn '@media' src/ --include='*.vue' --include='*.css'
```

## P8: dvh Units (LOW)

Verify `100dvh` used instead of `100vh` for mobile viewport.

**Detection:**
```bash
grep -rn '100vh' src/ --include='*.vue' | grep -v '100dvh'
```
