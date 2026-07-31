# Accessibility Audit — Probe Definitions

WCAG 2.1 AA compliance probes for VELO's Vue 3 frontend (VELO-tuned, PROMPT №435).
Read severity from `probekit-core/references/severity-format.md`.

## P1: Semantic HTML (CRITICAL)

Verify components use semantic elements instead of generic `<div>` / `<span>`.

**Checks:**
- Navigation uses `<nav>`, not `<div class="nav">`
- Lists use `<ul>`/`<ol>`/`<li>`, not styled divs
- Headings use `<h1>`-`<h6>` in correct hierarchy (no skipped levels)
- Buttons use `<button>`, not `<div @click>` or `<span @click>`
- Tables (if any) use `<table>`/`<thead>`/`<tbody>`, not div grids
- Main content wrapped in `<main>`
- Footer uses `<footer>`, header uses `<header>`

**Detection:**
```bash
grep -rn 'div.*@click\|span.*@click' src/components/ --include='*.vue'
grep -rn '<div class="nav\|<div class="header\|<div class="footer' src/ --include='*.vue'
```

## P2: ARIA Roles & Attributes (HIGH)

Verify correct ARIA usage — roles match element semantics, required attributes present.

**Checks:**
- `role="button"` only on non-button elements (prefer native `<button>`)
- `aria-label` present on icon-only buttons
- `aria-expanded` on toggle controls (dropdowns, accordions)
- `aria-hidden="true"` on decorative elements
- `aria-live` regions for dynamic content updates (toasts, alerts)
- No redundant ARIA (e.g., `role="button"` on `<button>`)

**Detection:**
```bash
grep -rn 'aria-' src/ --include='*.vue' | head -30
grep -rn 'role=' src/ --include='*.vue'
```

## P3: Keyboard Navigation (CRITICAL)

Verify all interactive elements are keyboard-accessible.

**Checks:**
- All `@click` handlers have `@keydown.enter` or `@keydown.space` equivalents (unless on native `<button>`/`<a>`)
- `tabindex` usage: `0` for focusable, `-1` for programmatic focus, never positive values
- No keyboard traps (modal dialogs must allow Escape to close)
- Tab order follows visual order (no unexpected `tabindex` jumps)
- Custom components with interactions are focusable

**Detection:**
```bash
grep -rn '@click' src/ --include='*.vue' | grep -v '<button\|<a ' | grep -v '@keydown'
grep -rn 'tabindex="[1-9]' src/ --include='*.vue'
```

## P4: Focus Management (HIGH)

Verify focus is managed correctly for dynamic UI changes.

**Checks:**
- Modal/dialog open: focus moves to first focusable element inside
- Modal/dialog close: focus returns to trigger element
- Route change: focus moves to main content or page heading
- `:focus-visible` styles defined (not just `:focus`)
- No `outline: none` or `outline: 0` without alternative focus indicator
- Tab bar / bottom nav items have visible focus indicators

**Detection:**
```bash
grep -rn 'outline:\s*none\|outline:\s*0' src/ --include='*.vue' --include='*.css'
grep -rn ':focus-visible\|:focus' src/ --include='*.vue' --include='*.css'
```

## P5: Color Contrast (HIGH)

Verify text meets WCAG AA contrast ratios.

**Checks:**
- Normal text (< 18px): contrast ratio >= 4.5:1
- Large text (>= 18px or >= 14px bold): contrast ratio >= 3:1
- UI components and graphical objects: contrast >= 3:1
- Placeholder text meets minimum contrast
- Colors defined via CSS variables (check both light and dark mode values)

**Method:**
1. Read `variables.css` for color tokens
2. Extract text/background color pairs from components
3. Calculate contrast ratios for common pairings
4. Flag pairs below thresholds

## P6: Form Labels (CRITICAL)

Verify all form inputs have associated labels.

**Checks:**
- Every `<input>`, `<select>`, `<textarea>` has a visible `<label>` with matching `for`/`id`
- OR `aria-label` / `aria-labelledby` attribute
- Placeholder text is NOT a substitute for labels
- Error messages are associated with inputs via `aria-describedby`
- Required fields use `aria-required="true"` or `required` attribute
- Form validation errors are announced to screen readers

**Detection:**
```bash
grep -rn '<input\|<select\|<textarea' src/ --include='*.vue' | grep -v 'aria-label\|:id'
```

## P7: Skip Links & Landmarks (MEDIUM)

Verify page structure allows efficient screen reader navigation.

**Checks:**
- Skip-to-content link as first focusable element (or in index.html)
- ARIA landmark roles: `<main>`, `<nav>`, `<header>`, `<footer>`, `<aside>` present
- Only one `<main>` per page
- Navigation regions have unique `aria-label` if multiple exist
- Heading hierarchy is logical (one `<h1>` per view, no skipped levels)

**Detection:**
```bash
grep -rn 'skip.*content\|skip.*nav\|skip.*main' src/ --include='*.vue' --include='*.html'
grep -rn '<main\|<nav\|<header\|<footer\|<aside' src/ --include='*.vue'
```

## P8: Screen Reader Text (MEDIUM)

Verify non-visual content is provided for screen reader users.

**Checks:**
- Images have `alt` text (or `alt=""` + `aria-hidden="true"` for decorative)
- Icon-only buttons have `aria-label`
- SVG icons have `<title>` or `aria-label`
- Status messages use `aria-live="polite"` or `role="status"`
- Loading states announce via `aria-busy="true"`
- `aria-label` values are translated (use `t()` — cross-ref with i18n-audit)

**Detection:**
```bash
grep -rn '<img' src/ --include='*.vue' | grep -v 'alt='
grep -rn '<svg' src/ --include='*.vue' | grep -v 'aria-label\|<title'
```
