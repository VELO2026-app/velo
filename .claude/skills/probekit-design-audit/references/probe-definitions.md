# Design Audit — Probe Definitions

Design system compliance probes for VELO (VELO-tuned, PROMPT №436).
Live probes: P1-P5. P6 is INERT (no dark mode). P7/P8 are DROPPED (CBS-specific).
Read severity from `probekit-core/references/severity-format.md`.

## P1: Hardcoded Colors (CRITICAL)

Scan all `.vue` and `.css` files for hex colors, rgb(), hsl() values.

**Allowed:**
- `var(--*)` CSS variables
- `currentColor`, `inherit`, `transparent`
- `#fff` / `#ffffff` (pure white — universal constant)
- `#000` / `#000000` (pure black — universal constant)
- Colors inside `variables.css` itself (token definitions)
- Colors inside comments

**Forbidden:**
- Any other hex color (`#cc3203`, `#E8651A`, etc.) — must use token
- `rgb()` / `rgba()` outside variables.css
- `hsl()` / `hsla()` outside variables.css
- CSS named colors (`red`, `blue`, `green`, `white`, `black`, `gray`, `grey`, `orange`, etc.)

**Detection:**
```bash
grep -rn --include='*.vue' --include='*.css' -E '#[0-9a-fA-F]{3,8}' src/ | grep -v variables.css | grep -v node_modules
grep -rn --include='*.vue' -E '\b(red|blue|green|white|black|gray|grey|orange|yellow|purple|pink|teal)\b' src/components/ src/views/
```

## P2: Font Compliance (HIGH)

Verify all font usage goes through `var(--font)`.

**Checks:**
- No `font-family:` declarations except `var(--font)`, `inherit`, `monospace` (for code blocks)
- Font weights: only 400/500/600/700/800 (Montserrat range)
- Font sizes follow typography scale (12/13/14/15/16/17/18/20/24/28/32/48px)

**Detection:**
```bash
grep -rn --include='*.vue' 'font-family' src/ | grep -v 'var(--font)' | grep -v 'inherit'
```

## P3: Spacing Token Usage (MEDIUM)

Verify spacing uses `var(--space-*)` tokens, not hardcoded px values.

**Allowed px values:** `0`, `1px` (borders), `2px` (borders, small gaps), values inside `variables.css`, `env(safe-area-*)` values.

**Detection:**
```bash
grep -rn --include='*.vue' -E '(padding|margin|gap):\s*\d+px' src/ | grep -v variables.css
```

## P4: Radius Token Usage (MEDIUM)

Verify border-radius uses `var(--radius-*)`.

**Detection:**
```bash
grep -rn --include='*.vue' 'border-radius' src/ | grep -v 'var(--radius' | grep -v '50%'
```

## P5: Shadow Token Usage (MEDIUM)

Verify box-shadow uses `var(--shadow-*)`.

**Detection:**
```bash
grep -rn --include='*.vue' 'box-shadow' src/ | grep -v 'var(--shadow' | grep -v 'none'
```

## P6: Dark Mode Completeness — INERT for VELO (PROMPT №436)

VELO has NO dark mode: zero `prefers-color-scheme` in variables.css or
global.css, and no theme tokens. This probe finds nothing today and its silence
is NOT a pass.

Kept, not dropped -- unlike P7/P8 this is one theme away from mattering, and the
Telegram Mini App webview does expose a colour scheme. NOTE for whoever switches
it on: `platform/telegram.ts:33-34` already hardcodes `setHeaderColor('#334D6E')`
and `setBackgroundColor('#F8FAFC')`. Neither hex exists anywhere in
variables.css, so the app's own chrome is already outside the token system.

Verify components render correctly in both themes.

**Checks:**
- Background colors use semantic tokens (`--bg`, `--bg-subtle`, `--bg-elevated`)
- Text colors use semantic tokens (`--text`, `--text-secondary`, `--text-tertiary`)
- Border colors use `--border`
- No `background: white` or `color: black` literals

## P7: Logo Icon Color — DROPPED for VELO (PROMPT №436)

Upstream this enforced CBS HOME's logo rule: icon background must be
`--o-primary` (#cc3203), never `--accent` (#E8651A). Neither token, neither hex
and neither brand exists in VELO. The probe could only ever match nothing.

Dropped rather than marked inert: it is not one config away from meaning
something — it encodes another product's brand rule. If VELO ever gets a logo
rule, it comes from the operator as a brand decision, not from this file.

## P8: Token Sync — DROPPED for VELO (PROMPT №436)

Upstream this diffed the frontend's `variables.css` against a second copy at
`mockups/css/variables.css` — CBS kept two and they could drift. VELO has ONE:
`frontend/src/styles/variables.css`, and it says so itself ("this file is now
the single source of truth for all visual values", variables.css:4-5). There is
no second copy to diff, so this probe has nothing to compare and its silence
would read as "in sync".

Dropped, not inert. If a second copy ever appears, that is itself the bug.
