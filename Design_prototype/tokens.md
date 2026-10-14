# Design Tokens — VELΘ App

> Source of truth for all design values. Use semantic or intent tokens in code.
> Primitive tokens are reference only.

---

## Colors

### Primitive

| Token | Value | Notes |
|-------|-------|-------|
| color-blue-500 | #4c6589 | Core brand blue-slate |
| color-blue-600 | #627a9c | Darker blue-slate |
| color-blue-700 | #5c7292 | Mid blue-slate |
| color-blue-200 | #abbfda | Light blue border |
| color-blue-100 | #e2f0fd | Very light blue tint |
| color-teal-400 | #76dde6 | Bright teal |
| color-teal-600 | #2f9ea8 | Deep teal text |
| color-teal-700 | #26767d | Darker teal text |
| color-peach-300 | #fbc088 | Peach / warm orange |
| color-peach-500 | #d4863c | Deep orange |
| color-peach-700 | #a16124 | Dark amber |
| color-pink-300 | #f795a2 | Soft pink / rose |
| color-pink-100 | #fde2e2 | Very light pink tint |
| color-sand-100 | #fdf3e2 | Warm sand tint |
| color-white | #ffffff | Pure white |
| color-glass-blue-15 | rgba(98,122,156,0.15) | Glass blue — 15% opacity |
| color-glass-blue-40 | rgba(171,191,218,0.15) | Light glass blue — 15% |
| color-glass-blue-60 | rgba(171,191,218,0.60) | Light glass blue — 60% |
| color-glass-teal-30 | rgba(118,221,230,0.30) | Glass teal — 30% |
| color-glass-teal-40 | rgba(118,221,230,0.40) | Glass teal — 40% |
| color-glass-peach-40 | rgba(251,192,136,0.40) | Glass peach — 40% |
| color-glass-white-01 | rgba(255,255,255,0.01) | Near-transparent white |

### Semantic

| Token | Maps To | Description |
|-------|---------|-------------|
| color-brand-primary | color-blue-600 | Main CTA / active nav / filled button |
| color-brand-text | color-blue-500 | Primary text, labels, headings |
| color-brand-text-light | color-blue-700 | Alternate text (Welcome screen) |
| color-brand-border | color-blue-200 | Input focus border, dividers |
| color-neutral-surface | color-white | Cards, panels, input backgrounds |
| color-neutral-background | color-white | Page background (photo overlay gives the tint) |
| color-feedback-warning-bg | color-glass-peach-40 | Warning notification fill |
| color-feedback-warning-border | color-peach-300 | Warning notification border |
| color-feedback-warning-title | color-peach-700 | Warning title text |
| color-feedback-warning-body | color-peach-500 | Warning body text |
| color-feedback-success-bg | color-glass-teal-40 | Success/info notification fill |
| color-feedback-success-border | color-teal-400 | Success/info notification border |
| color-feedback-success-title | color-teal-700 | Success title text |
| color-feedback-success-body | color-teal-600 | Success body / link text |
| color-feedback-danger | color-pink-300 | Danger action button (cancel) |
| color-tag-pink-bg | color-pink-100 | Tag background — Mindfulness category |
| color-tag-blue-bg | color-blue-100 | Tag background — Медитация category |
| color-tag-sand-bg | color-sand-100 | Tag background — MBSR / warm category |
| color-tag-text | color-brand-text | All tag text |
| color-status-confirmed-bg | color-glass-teal-30 | Confirmed / Paid status badge bg |
| color-status-confirmed-text | color-teal-600 | Confirmed / Paid status text |

### Intent

| Token | Maps To | Used For |
|-------|---------|----------|
| color-action-cta-default | color-brand-primary | Primary button bg (Войти, Check-in, Забронировать) |
| color-action-cta-text | color-white | Primary button label |
| color-action-secondary-bg | color-glass-blue-60 | Secondary glass button (Google, secondary actions) |
| color-action-ghost-bg | color-glass-white-01 | Ghost button (Apple, Zoom) |
| color-action-danger-bg | color-feedback-danger | Destructive button (Отменить бронирование) |
| color-action-danger-text | color-white | Destructive button label |
| color-text-primary | color-brand-text | Body text, labels, headings |
| color-text-secondary | rgba(76,101,137,0.70) | Captions, meta info, timestamps |
| color-text-placeholder | rgba(76,101,137,0.50) | Input placeholder text |
| color-text-white | color-white | Text on filled/dark surfaces |
| color-surface-card | color-neutral-surface | Card and panel backgrounds |
| color-surface-input | color-neutral-surface | Input field background |
| color-border-input-default | color-neutral-surface | Input default (no visible border) |
| color-border-input-focus | color-brand-border | Input focused border (2px #abbfda) |
| color-border-glass | color-white | 1px white border on all glass elements |
| color-nav-active-bg | color-brand-primary | Active nav item fill |
| color-nav-inactive-bg | color-glass-blue-15 | Inactive nav item glass bg |
| color-gradient-start | color-teal-400 | Gradient left (#76dde6) |
| color-gradient-end | color-pink-300 | Gradient right (#f795a2) |

---

## Typography

### Font Families

| Token | Value | Fallback |
|-------|-------|----------|
| font-family-display | Marmelad | Noto Sans, sans-serif |

> Only one font family used across the entire app. Weight is always Regular (400).

### Scale

| Token | px | rem | Letter-spacing |
|-------|----|-----|---------------|
| font-size-xs | 14px | 0.875rem | 0.28px (0.02em) |
| font-size-sm | 15px | 0.9375rem | 0.30px (0.02em) |
| font-size-md | 18px | 1.125rem | 0.36px (0.02em) |
| font-size-lg | 20px | 1.25rem | 0.40px (0.02em) |
| font-size-xl | 32px | 2rem | 0.64px (0.02em) |
| font-size-2xl | 50px | 3.125rem | 1.00px (0.02em) |

> Rule: letter-spacing = font-size × 0.02. Always use `tracking-[{value}px]` matching this ratio.

### Weights

| Token | Value |
|-------|-------|
| font-weight-regular | 400 |

> Only weight used in the design. No bold, medium, or semibold found.

### Line Heights

| Token | Value |
|-------|-------|
| line-height-normal | normal (browser default) |

### Intent (Text Styles)

| Token | Size | Weight | Letter-spacing | Line Height |
|-------|------|--------|----------------|-------------|
| font-hero | font-size-2xl | 400 | 1.00px | normal |
| font-heading-xl | font-size-xl | 400 | 0.64px | normal |
| font-heading | font-size-md | 400 | 0.36px | normal |
| font-body | font-size-md | 400 | 0.36px | normal |
| font-button | font-size-lg | 400 | 0.40px | normal |
| font-label | font-size-sm | 400 | 0.30px | normal |
| font-caption | font-size-xs | 400 | 0.28px | normal |

---

## Spacing

| Token | Value | Usage |
|-------|-------|-------|
| spacing-none | 0 | — |
| spacing-xs | 8px | Inline gaps, icon-to-text |
| spacing-sm | 14px | Gap between text lines within a card |
| spacing-md | 16px | Internal card padding (approx) |
| spacing-lg | 24px | Between stacked elements in a section |
| spacing-xl | 33px | Screen horizontal margin (fixed) |
| spacing-2xl | 48px | Between major sections |
| spacing-content | 336px | Content column width (402px − 33px × 2) |

---

## Shadows

| Token | Value | Used For |
|-------|-------|----------|
| shadow-none | none | Flat elements |
| shadow-glow | 0px 0px 20.9px 7px #ffffff | All main buttons (primary, secondary, ghost) |
| shadow-blur | backdrop-filter: blur(2px) | All glass/frosted elements |

---

## Стили кнопок

| Вариант | Background | Opacity | Border | Text Color | Radius | Backdrop-blur | Где используется |
|---------|-----------|---------|--------|------------|--------|---------------|------------------|
| Primary (solid) | #627a9c | 100% | 1px solid #ffffff | #ffffff | radius-full (200px) | blur(2px) | CTA: «Войти», «Check-in», «Забронировать» |
| Secondary (glass) | rgba(171,191,218,0.60) | — | 1px solid #ffffff | #4c6589 | radius-full (200px) | blur(2px) | «Войти через Google» |
| Ghost | rgba(255,255,255,0.01) | — | 1px solid #ffffff | #4c6589 | radius-full (200px) | blur(2px) | «Войти через Apple», «Zoom» |
| Danger (solid) | #f795a2 | 100% | 1px solid #ffffff | #ffffff | radius-full (200px) | blur(2px) | «Отменить бронирование» |

### Примечания

- Все кнопки имеют одинаковый размер: **336×50px**, radius-full (200px)
- Все кнопки получают `box-shadow: 0px 0px 20.9px 7px #ffffff` (glow) — это рesting state, не hover
- Все кнопки используют `backdrop-filter: blur(2px)` — даже solid-кнопки
- Граница `1px solid #ffffff` присутствует у всех вариантов
- Разница между Secondary и Ghost — только степень непрозрачности фона:
  - Secondary: `rgba(171,191,218,0.60)` — заметное голубоватое стекло
  - Ghost: `rgba(255,255,255,0.01)` — практически прозрачный, виден только через бордер и glow
- Шрифт кнопок: `font-button` (Marmelad Regular, 20px, tracking 0.40px)

---

## Radii

| Token | Value | Used For |
|-------|-------|----------|
| radius-none | 0 | — |
| radius-xs | 5px | Input fields, small chips |
| radius-sm | 15px | Cards, panels, notification banners, screens |
| radius-lg | 71px | Status badges (Подтверждена) |
| radius-pill | 100px | Tags/chips (Mindfulness, Медитация, MBSR) |
| radius-full | 200px | All pill buttons (CTA, secondary, ghost, back) |
| radius-circle | 50% | Avatar images |
