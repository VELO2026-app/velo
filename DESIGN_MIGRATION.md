# VELΘ Design Migration Plan v4

> **Freshness (ПРОМТ №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> ACTIVELY MISLEADING overall — NOT rewritten this round (no specific line-level correction
> was in scope for this pass). Flagging the overall problem instead: this entire document's
> premise — design tokens sourced from mockups/Figma via a `design/veltheta` migration
> branch — predates and conflicts with the 2026-06-10 operator ruling that dropped Figma
> permanently in favor of an operator-sent SVG-per-screen source (canon in
> `VELO-Frontend-Specification.md` header, `VELO-Frontend.md` header). Whether the concrete
> file list / CSS values below were ever applied, and how much has since drifted, is
> UNVERIFIED as of this pass. Treat this document as historical process description, not a
> current migration plan to execute.

> **Рабочая ветка:** создать `design/veltheta` от `main`
> **Деплой теста:** VPS переключить на `design/veltheta`, `velo update`
> **Все задания выполняет Claude Code** в рабочей ветке

---

## Принципы 

1. Имена CSS-переменных не трогать — только значения справа от `:`
2. Новые переменные — добавлять в конец `variables.css`, не переименовывать старые
3. Фон — через `body { background }` в `global.css` (импортируется в `main.ts` → попадает в JS-бандл, Telegram не кеширует)
4. Каждое задание = точный код, без интерпретации

---

## Полный список файлов (37 штук, проверено по коду)

```
СТИЛИ
  frontend/src/styles/variables.css
  frontend/src/styles/global.css
  frontend/index.html

UI-КОМПОНЕНТЫ (изменить существующие)
  frontend/src/components/ui/VButton.vue
  frontend/src/components/ui/VInput.vue
  frontend/src/components/ui/VCard.vue
  frontend/src/components/ui/VBadge.vue
  frontend/src/components/ui/VProgressBar.vue
  frontend/src/components/ui/VeloLogo.vue

UI-КОМПОНЕНТЫ (создать новые)
  frontend/src/components/ui/VTag.vue
  frontend/src/components/ui/VNotification.vue
  frontend/src/components/ui/VToggle.vue
  frontend/src/components/ui/VAccordion.vue
  frontend/src/components/ui/index.ts  (добавить 4 экспорта)

ИКОНКИ (создать новые Vue-компоненты)
  frontend/src/components/ui/icons/IconHome.vue
  frontend/src/components/ui/icons/IconCalendar.vue
  frontend/src/components/ui/icons/IconDiary.vue
  frontend/src/components/ui/icons/IconProfile.vue
  frontend/src/components/ui/icons/IconDashboard.vue
  frontend/src/components/ui/icons/IconPractices.vue
  frontend/src/components/ui/icons/IconAnalytics.vue
  frontend/src/components/ui/icons/IconBrain.vue
  frontend/src/components/ui/icons/IconGroup.vue
  frontend/src/components/ui/icons/IconFeedback.vue
  frontend/src/components/ui/icons/IconClock.vue

LAYOUT
  frontend/src/components/layout/MobileLayout.vue
  frontend/src/components/layout/AdminLayout.vue
  frontend/src/components/layout/VTabBar.vue
  frontend/src/components/layout/VHeader.vue
  frontend/src/router/tabs.ts

VIEWS — AUTH/STANDALONE
  frontend/src/views/auth/LoadingView.vue
  frontend/src/views/auth/StandaloneStubView.vue
  frontend/src/views/NotFoundView.vue

VIEWS — MASTER (отдельный фон)
  frontend/src/views/master/MasterApplyView.vue

SHARED COMPONENTS
  frontend/src/components/shared/PracticeCard.vue
  frontend/src/components/shared/BookingCard.vue
  frontend/src/components/shared/BookingPopup.vue
```

**Остальные views (user/*, master/*, admin/*) автоматически получают новый вид** через обновлённые CSS-переменные из DS-1 и обновлённые компоненты. Отдельно их трогать не нужно — только точечные правки если что-то сломается.

---

## DS-1: variables.css

**Файл:** `frontend/src/styles/variables.css`

Заменить только значения, имена не трогать:

```css
/* === Colors: Primary === */
--velo-primary: #627a9c;
--velo-primary-light: #627a9c;
--velo-primary-dark: #4c6589;

/* === Colors: Background === */
--velo-bg-start: #ffffff;
--velo-bg-end: #ffffff;
--velo-bg-subtle: rgba(98, 122, 156, 0.06);
--velo-bg-card: #ffffff;

/* === Colors: Text === */
--velo-text-primary: #4c6589;
--velo-text-secondary: rgba(76, 101, 137, 0.70);
--velo-text-muted: rgba(76, 101, 137, 0.50);

/* === Colors: Borders === */
--velo-border: #abbfda;
--velo-border-light: rgba(171, 191, 218, 0.30);

/* === Colors: Semantic base === */
--velo-success: #76dde6;
--velo-warning: #fbc088;
--velo-error: #f795a2;
--velo-info: #76dde6;

/* === Colors: Semantic tints === */
--velo-warning-bg: rgba(251, 192, 136, 0.40);
--velo-warning-bg-hover: rgba(251, 192, 136, 0.55);
--velo-warning-border: #fbc088;
--velo-warning-text: #a16124;
--velo-warning-text-light: #d4863c;

--velo-error-bg: rgba(253, 226, 226, 0.40);
--velo-error-bg-subtle: rgba(253, 226, 226, 0.40);
--velo-error-border: #f795a2;
--velo-error-text: #a16124;

--velo-success-bg: rgba(118, 221, 230, 0.40);
--velo-success-text: #26767d;

--velo-info-bg: rgba(118, 221, 230, 0.40);
--velo-info-text: #2f9ea8;

/* === Colors: Mood === */
--velo-mood-low: #f795a2;
--velo-mood-mid: #fbc088;
--velo-mood-high: #76dde6;

/* === Typography === */
--font-body: 'Marmelad', 'Noto Sans', sans-serif;
--font-heading: 'Marmelad', 'Noto Sans', sans-serif;

--text-xs: 14px;
--text-sm: 15px;
--text-base: 18px;
--text-lg: 20px;
--text-xl: 32px;
--text-2xl: 50px;
--text-3xl: 32px;

/* === Spacing === */
--space-1: 4px;
--space-2: 8px;
--space-3: 14px;
--space-4: 16px;
--space-5: 24px;
--space-6: 24px;
--space-8: 33px;
--space-10: 48px;

/* === Borders === */
--radius-sm: 15px;
--radius-md: 15px;
--radius-lg: 15px;
--radius-xl: 100px;
--radius-full: 9999px;   ← НЕ ТРОГАТЬ

/* === Shadows === */
--shadow-sm: none;
--shadow-md: none;
--shadow-lg: none;
--shadow-xl: none;
```

Добавить в конец файла (новые переменные):

```css
/* === VELΘ: Glass colors === */
--velo-glass-blue-15: rgba(98, 122, 156, 0.15);
--velo-glass-blue-60: rgba(171, 191, 218, 0.60);
--velo-glass-teal-30: rgba(118, 221, 230, 0.30);
--velo-glass-teal-40: rgba(118, 221, 230, 0.40);
--velo-glass-peach-40: rgba(251, 192, 136, 0.40);
--velo-glass-white-01: rgba(255, 255, 255, 0.01);

/* === VELΘ: Primitive palette === */
--velo-teal-400: #76dde6;
--velo-teal-600: #2f9ea8;
--velo-teal-700: #26767d;
--velo-peach-300: #fbc088;
--velo-peach-500: #d4863c;
--velo-peach-700: #a16124;
--velo-pink-300: #f795a2;
--velo-pink-100: #fde2e2;
--velo-blue-100: #e2f0fd;
--velo-blue-200: #abbfda;
--velo-sand-100: #fdf3e2;

/* === VELΘ: Glow shadow === */
--velo-shadow-glow: 0px 0px 20.9px 7px #ffffff;

/* === VELΘ: Layout === */
--velo-content-width: 336px;
--velo-screen-width: 402px;
--velo-screen-padding: 33px;

/* === VELΘ: Navigation === */
--velo-nav-active-bg: #627a9c;
--velo-nav-inactive-bg: rgba(98, 122, 156, 0.15);

/* === VELΘ: Z-index background === */
--z-background: -1;
--z-content: 1;
```

---

## DS-2: global.css + index.html + 3 views с фоном

### `frontend/index.html`

Найти строки с Inter и Playfair Display, заменить на:
```html
<link href="https://fonts.googleapis.com/css2?family=Marmelad&display=swap" rel="stylesheet">
```

### `frontend/src/styles/global.css`

Заменить весь файл:

```css
/* =============================================================================
 * VELΘ Frontend — Global Styles
 * =========================================================================== */

/* === Reset === */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* === Base === */
html {
  font-size: var(--text-base);
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}

body {
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--text-base);
  letter-spacing: 0.02em;
  line-height: 1.5;
  color: var(--velo-text-primary);
  background: url('/bg/background.png') center / cover no-repeat fixed;
  overscroll-behavior: none;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* === Typography === */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-body);
  font-weight: 400;
  line-height: 1.3;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
}

a {
  color: var(--velo-primary);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

/* === Images === */
img, svg {
  display: block;
  max-width: 100%;
}

/* === Buttons reset === */
button {
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  border: none;
  background: none;
  padding: 0;
  color: inherit;
}

/* === Inputs reset === */
input, select, textarea {
  font-family: inherit;
  font-size: inherit;
  color: inherit;
}

/* === Lists === */
ul, ol {
  list-style: none;
}

/* === Scrollbar === */
::-webkit-scrollbar {
  width: 4px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--velo-blue-200);
  border-radius: var(--radius-full);
}
```

### Фоновое изображение

Скопировать `Design_prototype/assets/backgrounds/background.png` в `frontend/public/bg/background.png`.

### `frontend/src/views/auth/LoadingView.vue`

В `<style scoped>` найти `.loading {` и убрать строку `background: var(--velo-bg-start);`

### `frontend/src/views/auth/StandaloneStubView.vue`

В `<style scoped>` найти `.stub {` и убрать строку `background: var(--velo-bg-start);`

### `frontend/src/views/NotFoundView.vue`

В `<style scoped>` найти `.not-found {` и убрать строку `background: var(--velo-bg-start);`

### `frontend/src/views/master/MasterApplyView.vue`

В `<style scoped>` найти `.apply-view {` и заменить:
```css
/* было */
background: linear-gradient(135deg, var(--velo-bg-start) 0%, var(--velo-bg-end) 100%);
/* стало */
background: transparent;
```

---

## DS-3: UI Components

### `frontend/src/components/ui/VButton.vue`

**`<script setup>`** — заменить тип `variant` и `size`, убрать `block`:
```typescript
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    disabled?: boolean
    loading?: boolean
  }>(),
  {
    variant: 'primary',
    size: 'md',
    disabled: false,
    loading: false,
  },
)
```

**`<template>`** — убрать `'v-btn--block': block` из `:class`.

**`<style scoped>`** — полная замена:
```css
.v-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  font-family: var(--font-body);
  font-weight: 400;
  letter-spacing: 0.02em;
  border: 1px solid #ffffff;
  border-radius: var(--radius-full);
  cursor: pointer;
  position: relative;
  white-space: nowrap;
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
  transition: transform var(--transition-fast), opacity var(--transition-fast);
}
.v-btn--md {
  height: 50px;
  font-size: var(--text-lg);
  padding: 0 var(--space-5);
}
.v-btn--sm {
  height: 36px;
  font-size: var(--text-sm);
  padding: 0 var(--space-4);
  width: auto;
}
.v-btn--primary {
  background: var(--velo-primary);
  color: #ffffff;
}
.v-btn--secondary {
  background: var(--velo-glass-blue-60);
  color: var(--velo-text-primary);
}
.v-btn--ghost {
  background: var(--velo-glass-white-01);
  color: var(--velo-text-primary);
}
.v-btn--danger {
  background: var(--velo-error);
  color: #ffffff;
}
.v-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.v-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.v-btn--loading {
  cursor: wait;
}
.v-btn__content--hidden {
  visibility: hidden;
}
.v-btn__spinner {
  position: absolute;
  width: 18px;
  height: 18px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: v-btn-spin 0.6s linear infinite;
}
@keyframes v-btn-spin {
  to { transform: rotate(360deg); }
}
```

**Grep и замени по всему `frontend/src/`:**
- `variant="outline"` → `variant="ghost"`
- `size="lg"` → `size="md"`
- `:block="true"` → убрать атрибут
- `block` как standalone атрибут на `<VButton` → убрать

---

### `frontend/src/components/ui/VInput.vue`

**`<script setup>`** — убрать проп `error?: string`.

**`<template>`** — убрать:
- `:class="{ 'v-input--error': !!error }"` с корневого div
- `<span v-if="error" class="v-input__error">{{ error }}</span>`

**`<style scoped>`** — полная замена:
```css
.v-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.v-input__label {
  display: block;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-secondary);
}
.v-input__field {
  width: 100%;
  height: 40px;
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
  background: #ffffff;
  border: none;
  border-radius: 5px;
  outline: none;
  transition: border var(--transition-fast);
}
.v-input__field:focus {
  border: 2px solid var(--velo-border);
}
.v-input__field::placeholder {
  color: var(--velo-text-muted);
}
.v-input__field:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

**Grep по всему `frontend/src/`:** найти `:error=` на `<VInput` → удалить проп.

---

### `frontend/src/components/ui/VCard.vue`

**`<style scoped>`** — заменить `.v-card`:
```css
.v-card {
  background: #ffffff;
  border: none;
  border-radius: var(--radius-md);
  padding: var(--space-4);
  transition: transform var(--transition-fast);
}
.v-card--clickable {
  cursor: pointer;
}
.v-card--clickable:active {
  transform: scale(0.98);
}
.v-card--no-padding {
  padding: 0;
}
```

---

### `frontend/src/components/ui/VBadge.vue`

**`<style scoped>`** — полная замена (сейчас hardcoded hex):
```css
.v-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  height: 23px;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 400;
  letter-spacing: 0.02em;
  border-radius: 71px;
  white-space: nowrap;
}
.v-badge--success {
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}
.v-badge--warning {
  background: var(--velo-glass-peach-40);
  color: var(--velo-peach-700);
}
.v-badge--error {
  background: var(--velo-pink-100);
  color: var(--velo-pink-300);
}
.v-badge--info {
  background: var(--velo-blue-100);
  color: var(--velo-text-primary);
}
```

---

### `frontend/src/components/ui/VProgressBar.vue`

В `<style scoped>` заменить только `.v-progress__track`:
```css
.v-progress__track {
  flex: 1;
  height: 8px;
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  overflow: hidden;
}
```

---

### `frontend/src/components/ui/VeloLogo.vue`

Заменить fallback:
```html
<!-- было -->
fill="var(--velo-primary, #334D6E)"
<!-- стало -->
fill="var(--velo-primary, #627a9c)"
```

---

### НОВЫЙ: `frontend/src/components/ui/VTag.vue`

```vue
<!--
  VELΘ Frontend -- VTag Component
  Pill-shaped category label.
  Variants: blue | pink | sand
-->
<template>
  <span class="v-tag" :class="`v-tag--${variant}`">
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{ variant?: 'blue' | 'pink' | 'sand' }>(),
  { variant: 'blue' },
)
</script>

<style scoped>
.v-tag {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 8px;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
  border-radius: var(--radius-full);
  white-space: nowrap;
}
.v-tag--blue  { background: var(--velo-blue-100); }
.v-tag--pink  { background: var(--velo-pink-100); }
.v-tag--sand  { background: var(--velo-sand-100); }
</style>
```

---

### НОВЫЙ: `frontend/src/components/ui/VNotification.vue`

```vue
<!--
  VELΘ Frontend -- VNotification Component
  Inline notification banner. Replaces per-field error states in forms.
  Variants: warning | success
-->
<template>
  <div v-if="title" class="v-notification" :class="`v-notification--${variant}`">
    <div class="v-notification__title">{{ title }}</div>
    <div v-if="body" class="v-notification__body">{{ body }}</div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'warning' | 'success'
    title?: string
    body?: string
  }>(),
  { variant: 'warning' },
)
</script>

<style scoped>
.v-notification {
  width: 100%;
  min-height: 66px;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.v-notification--warning {
  background: var(--velo-warning-bg);
  border: 2px solid var(--velo-warning-border);
}
.v-notification--success {
  background: var(--velo-success-bg);
  border: 2px solid var(--velo-success);
}
.v-notification__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  letter-spacing: 0.02em;
}
.v-notification--warning .v-notification__title { color: var(--velo-warning-text); }
.v-notification--success .v-notification__title { color: var(--velo-success-text); }
.v-notification__body {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 400;
  letter-spacing: 0.02em;
}
.v-notification--warning .v-notification__body { color: var(--velo-warning-text-light); }
.v-notification--success .v-notification__body { color: var(--velo-info-text); }
</style>
```

---

### НОВЫЙ: `frontend/src/components/ui/VToggle.vue`

```vue
<!--
  VELΘ Frontend -- VToggle Component
  Segmented control. Used in AI-summary (Неделя / Месяц).
-->
<template>
  <div class="v-toggle">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="v-toggle__item"
      :class="{ 'v-toggle__item--active': modelValue === opt.value }"
      @click="$emit('update:modelValue', opt.value)"
    >{{ opt.label }}</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: string
  options: Array<{ value: string; label: string }>
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<style scoped>
.v-toggle {
  display: inline-flex;
  height: 30px;
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  padding: 2px;
  gap: 2px;
}
.v-toggle__item {
  flex: 1;
  padding: 0 14px;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
  border-radius: var(--radius-full);
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
  white-space: nowrap;
}
.v-toggle__item--active {
  background: var(--velo-primary);
  color: #ffffff;
}
</style>
```

---

### НОВЫЙ: `frontend/src/components/ui/VAccordion.vue`

```vue
<!--
  VELΘ Frontend -- VAccordion Component
  Expandable row. Used in Practice Detail.
-->
<template>
  <div class="v-accordion">
    <button class="v-accordion__header" @click="open = !open">
      <span class="v-accordion__title">{{ title }}</span>
      <span class="v-accordion__icon" :class="{ 'v-accordion__icon--open': open }">▾</span>
    </button>
    <Transition name="v-accordion">
      <div v-show="open" class="v-accordion__body">
        <slot />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ title: string }>()
const open = ref(false)
</script>

<style scoped>
.v-accordion {
  width: 100%;
  background: #ffffff;
  border-radius: var(--radius-md);
  overflow: hidden;
}
.v-accordion__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  background: none;
  border: none;
  cursor: pointer;
}
.v-accordion__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
}
.v-accordion__icon {
  font-size: 18px;
  color: var(--velo-text-primary);
  transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
}
.v-accordion__icon--open { transform: rotate(180deg); }
.v-accordion__body {
  padding: 0 16px 14px;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-secondary);
  line-height: 1.5;
}
.v-accordion-enter-active { transition: opacity 250ms cubic-bezier(0.4, 0, 0.2, 1); }
.v-accordion-leave-active { transition: opacity 150ms cubic-bezier(0.4, 0, 1, 1); }
.v-accordion-enter-from, .v-accordion-leave-to { opacity: 0; }
</style>
```

---

### `frontend/src/components/ui/index.ts`

Добавить в конец файла:
```typescript
export { default as VTag } from './VTag.vue'
export { default as VNotification } from './VNotification.vue'
export { default as VToggle } from './VToggle.vue'
export { default as VAccordion } from './VAccordion.vue'
```

---

## DS-4: Layout Components

### `frontend/src/components/layout/MobileLayout.vue`

В `<style scoped>` заменить `.mobile-layout`:
```css
.mobile-layout {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  min-height: 100vh;
  background: transparent;
}
.mobile-layout__main {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  -webkit-overflow-scrolling: touch;
}
```

---

### `frontend/src/components/layout/AdminLayout.vue`

В `<style scoped>` заменить `.admin-layout`:
```css
.admin-layout {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  min-height: 100vh;
  background: transparent;
}
.admin-layout__main {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  -webkit-overflow-scrolling: touch;
}
```

---

### `frontend/src/components/layout/VHeader.vue`

**`<style scoped>`** — полная замена:
```css
.v-header {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky, 200);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  background: transparent;
  min-height: 56px;
}
.v-header__left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.v-header__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 36px;
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  border-radius: var(--radius-full);
  border: 1px solid #ffffff;
  background: var(--velo-glass-blue-15);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  flex-shrink: 0;
  transition: opacity var(--transition-fast);
}
.v-header__back:active { opacity: 0.7; }
.v-header__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.v-header__badge {
  background: var(--velo-primary);
  color: white;
  font-size: var(--text-xs);
  font-weight: 400;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.v-header__right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
```

---

### `frontend/src/components/layout/VTabBar.vue`

**`<style scoped>`** — полная замена:
```css
.v-tabbar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 20px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  background: transparent;
  z-index: var(--z-sticky, 200);
}
.v-tabbar__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 63px;
  height: 63px;
  border-radius: 50%;
  border: 1.26px solid #ffffff;
  color: var(--velo-text-primary);
  transition: background var(--transition-fast);
  position: relative;
  cursor: pointer;
}
.v-tabbar__item--active {
  background: var(--velo-nav-active-bg);
  color: #ffffff;
}
.v-tabbar__item:not(.v-tabbar__item--active) {
  background: var(--velo-nav-inactive-bg);
  backdrop-filter: blur(2.52px);
  -webkit-backdrop-filter: blur(2.52px);
}
.v-tabbar__icon {
  font-size: 22px;
  line-height: 1;
}
.v-tabbar__label {
  font-family: var(--font-body);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.02em;
  margin-top: 2px;
}
.v-tabbar__badge {
  position: absolute;
  top: 6px;
  right: 6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--velo-error);
  color: white;
  font-size: 9px;
  font-weight: 400;
  border-radius: var(--radius-full);
}
```

---

## DS-5: Иконки

Все иконки — fill-based, `currentColor`, viewBox от оригинала из Design_prototype.

Шаблон каждого компонента:
```vue
<template>
  <svg :width="size" :height="size" viewBox="..." fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- paths из .svg файла -->
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>
```

### Иконки из Design_prototype (SVG-содержимое брать из файлов в репо)

**`frontend/src/components/ui/icons/IconHome.vue`** — из `Design_prototype/assets/icons/icon-home.svg` (viewBox="0 0 512 512")

**`frontend/src/components/ui/icons/IconCalendar.vue`** — из `Design_prototype/assets/icons/icon-calendar.svg` (viewBox="0 0 512 512")

**`frontend/src/components/ui/icons/IconDiary.vue`** — из `Design_prototype/assets/icons/icon-diary.svg` (viewBox="0 0 512 512")

**`frontend/src/components/ui/icons/IconProfile.vue`** — из `Design_prototype/assets/icons/icon-profile.svg` (viewBox="0 0 384 512")

**`frontend/src/components/ui/icons/IconBrain.vue`** — из `Design_prototype/assets/icons/icon-brain.svg` (viewBox="0 0 512 512")

**`frontend/src/components/ui/icons/IconGroup.vue`** — из `Design_prototype/assets/icons/icon-group.svg` (viewBox="0 0 515 513")

**`frontend/src/components/ui/icons/IconFeedback.vue`** — из `Design_prototype/assets/icons/icon-feedback.svg` (viewBox="0 0 512 491")

**`frontend/src/components/ui/icons/IconClock.vue`** — из `Design_prototype/assets/icons/icon-clock.svg` (viewBox="0 0 512 512")

### Иконки которых нет в Design_prototype (сделать в том же fill-стиле)

**`frontend/src/components/ui/icons/IconPractices.vue`** — для master таба "Практики":
```vue
<template>
  <svg :width="size" :height="size" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M64 0H448L469 5L486 16L500 31L509 49L512 64V448L507 469L496 486L481 500L463 509L448 512H64L43 507L26 496L12 481L3 463L0 448V64L5 43L16 26L31 12L49 3L64 0ZM85 43L69 47L57 57L47 69L43 85V427L47 443L57 455L69 465L85 469H427L443 465L455 455L465 443L469 427V85L465 69L455 57L443 47L427 43H85ZM170 128H342L356 133L366 143L371 157V171L366 185L356 195L342 200H170L156 195L146 185L141 171V157L146 143L156 133L170 128ZM128 256H384L398 261L408 271L413 285V299L408 313L398 323L384 328H128L114 323L104 313L99 299V285L104 271L114 261L128 256ZM170 384H342L356 389L366 399L371 413V427L366 441L356 451L342 456H170L156 451L146 441L141 427V413L146 399L156 389L170 384Z" fill="currentColor"/>
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>
```

**`frontend/src/components/ui/icons/IconAnalytics.vue`** — для master таба "Аналитика":
```vue
<template>
  <svg :width="size" :height="size" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 512V448L171 277L277 383L512 85V149L277 447L171 341L0 512Z" fill="currentColor"/>
    <path d="M320 0H512V192L432 112L277 267L171 161L0 332V268L171 97L277 203L432 48L320 0Z" fill="currentColor"/>
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>
```

**`frontend/src/components/ui/icons/IconDashboard.vue`** — для admin таба "Дашборд":
```vue
<template>
  <svg :width="size" :height="size" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 0H234V234H0V0ZM278 0H512V234H278V0ZM0 278H234V512H0V278ZM278 278H512V512H278V278ZM43 43V191H191V43H43ZM321 43V191H469V43H321ZM43 321V469H191V321H43ZM321 321V469H469V321H321Z" fill="currentColor"/>
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>
```

**`frontend/src/components/ui/icons/IconMasters.vue`** — для admin таба "Мастера" (использовать icon-group.svg):
Это тот же компонент что и `IconGroup.vue` — создать как алиас или просто скопировать.

**`frontend/src/components/ui/icons/IconModeration.vue`** — для admin таба "Модерация":
```vue
<template>
  <svg :width="size" :height="size" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M256 0L512 128V256C512 384 416 469 256 512C96 469 0 384 0 256V128L256 0ZM256 55L43 163V256C43 358 123 428 256 464C389 428 469 358 469 256V163L256 55ZM235 149H277V299H235V149ZM235 341H277V384H235V341Z" fill="currentColor"/>
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>
```

### `frontend/src/router/tabs.ts`

Заменить emoji на импорты SVG-компонентов. Изменить тип `TabItem.icon` в `VTabBar.vue` с `string` на `string | Component`, рендерить через `<component :is="item.icon">` если это не строка.

```typescript
import { defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import type { TabItem } from '@/components/layout/VTabBar.vue'

const IconHome = defineAsyncComponent(() => import('@/components/ui/icons/IconHome.vue'))
const IconCalendar = defineAsyncComponent(() => import('@/components/ui/icons/IconCalendar.vue'))
const IconDiary = defineAsyncComponent(() => import('@/components/ui/icons/IconDiary.vue'))
const IconProfile = defineAsyncComponent(() => import('@/components/ui/icons/IconProfile.vue'))
const IconDashboard = defineAsyncComponent(() => import('@/components/ui/icons/IconDashboard.vue'))
const IconPractices = defineAsyncComponent(() => import('@/components/ui/icons/IconPractices.vue'))
const IconAnalytics = defineAsyncComponent(() => import('@/components/ui/icons/IconAnalytics.vue'))
const IconMasters = defineAsyncComponent(() => import('@/components/ui/icons/IconGroup.vue'))
const IconModeration = defineAsyncComponent(() => import('@/components/ui/icons/IconModeration.vue'))

export const USER_TABS: TabItem[] = [
  { icon: IconHome,     label: 'Дашборд',   to: '/user/dashboard' },
  { icon: IconCalendar, label: 'Календарь', to: '/user/calendar' },
  { icon: IconDiary,    label: 'Дневник',   to: '/user/diary' },
  { icon: IconProfile,  label: 'Я',         to: '/user/profile' },
]

export const MASTER_TABS: TabItem[] = [
  { icon: IconDashboard,  label: 'Дашборд',   to: '/master/dashboard' },
  { icon: IconPractices,  label: 'Практики',  to: '/master/practices' },
  { icon: IconAnalytics,  label: 'Аналитика', to: '/master/analytics' },
  { icon: IconProfile,    label: 'Я',         to: '/master/profile' },
]

export const ADMIN_TABS: TabItem[] = [
  { icon: IconDashboard,   label: 'Дашборд',    to: '/admin/dashboard' },
  { icon: IconMasters,     label: 'Мастера',    to: '/admin/masters' },
  { icon: IconModeration,  label: 'Модерация',  to: '/admin/reports' },
]
```

### `frontend/src/components/layout/VTabBar.vue`

Обновить тип `TabItem` и шаблон:

```typescript
import type { Component } from 'vue'

export interface TabItem {
  icon: string | Component
  label: string
  to: string
  badge?: number | string
}
```

В `<template>` заменить отображение иконки:
```html
<!-- было -->
<span class="v-tabbar__icon">{{ item.icon }}</span>

<!-- стало -->
<component
  v-if="typeof item.icon !== 'string'"
  :is="item.icon"
  class="v-tabbar__icon"
  :size="22"
/>
<span v-else class="v-tabbar__icon">{{ item.icon }}</span>
```

---

## DS-6: Shared Components

### `frontend/src/components/shared/PracticeCard.vue`

В `<style scoped>`:
- `.practice-card`: `border: none`, `border-radius: var(--radius-md)`
- `.practice-card:hover`: убрать `box-shadow: 0 8px 24px rgba(51, 77, 110, 0.12)`
- `.practice-card__title`: `font-weight: 400`
- `.practice-card__price`: `font-weight: 400`

### `frontend/src/components/shared/BookingCard.vue`

В `<style scoped>`:
- `.booking-card`: `border: none`, `border-radius: var(--radius-md)`
- `.booking-card__title`: `font-weight: 400`

### `frontend/src/components/shared/BookingPopup.vue`

В `<style scoped>`:
- `.popup__title`: `font-family: var(--font-body)`, `font-weight: 400`

---

## DS-6: Shared Components

### `frontend/src/components/shared/PracticeCard.vue`

В `<style scoped>` точечные замены:
```css
/* .practice-card — убрать border, исправить radius */
border: none;                        /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);     /* было: var(--radius-lg) */

/* .practice-card:hover — убрать shadow */
/* убрать строку: box-shadow: 0 8px 24px rgba(51, 77, 110, 0.12); */

/* .practice-card__title */
font-weight: 400;    /* было: 600 */

/* .practice-card__price */
font-weight: 400;    /* было: 600 */
```

---

### `frontend/src/components/shared/BookingCard.vue`

В `<style scoped>`:
```css
/* .booking-card */
border: none;                        /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);     /* было: var(--radius-lg) */

/* .booking-card--clickable:hover — убрать */
/* убрать строку: box-shadow: var(--shadow-md); */

/* .booking-card__title */
font-weight: 400;    /* было: 600 */
```

---

### `frontend/src/components/shared/BookingPopup.vue`

В `<style scoped>`:
```css
/* .popup__title */
font-family: var(--font-body);   /* было: var(--font-heading) */
font-weight: 400;                /* было: 600 */

/* .popup__promo-input:focus — убрать box-shadow */
/* убрать строку: box-shadow: 0 0 0 3px rgba(51, 77, 110, 0.1); */
```

---

### `frontend/src/components/shared/CancelBookingPopup.vue`

В `<style scoped>`:
```css
/* .cancel__title */
font-family: var(--font-body);   /* было: var(--font-heading) */
font-weight: 400;                /* было: 600 */

/* .cancel__warning--danger */
background: var(--velo-warning-bg);    /* было: #FEF3C7 — hardcoded hex */

/* .cancel__warning--safe */
background: var(--velo-success-bg);    /* было: rgba(34, 197, 94, 0.1) */
border: 1px solid var(--velo-success); /* было: var(--velo-success) — уже ок */

/* .cancel__warning--danger .cancel__warning-text */
color: var(--velo-warning-text);   /* было: #92400E — hardcoded hex */

/* .cancel__warning--safe .cancel__warning-text */
color: var(--velo-success-text);   /* было: #166534 — hardcoded hex */
```

---

## DS-7: User Views

Правило для всех user views: Claude Code проходит по каждому файлу и делает только перечисленные замены. Логику, шаблоны, TypeScript не трогать.

### Общие замены по всем `frontend/src/views/user/*.vue`

1. `font-family: var(--font-heading)` → `var(--font-body)`
2. `font-weight: 700` → `400`
3. `font-weight: 600` → `400`
4. `font-weight: 500` → `400`
5. `box-shadow: 0 ... rgba(51, 77, 110, ...)` → убрать строку
6. `rgba(51, 77, 110, 0.05)` → `var(--velo-glass-blue-15)`
7. `rgba(51, 77, 110, 0.1)` → `var(--velo-glass-blue-15)`
8. `rgba(51, 77, 110, 0.15)` → `var(--velo-glass-blue-15)`
9. `rgba(51, 77, 110, 0.3)` → `var(--velo-glass-blue-60)`

### Дополнительные точечные правки по файлам

**`frontend/src/views/user/DiaryView.vue`**
```css
/* .diary-card */
border: none;                        /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);     /* было: var(--radius-lg) */

/* .diary__form-actions */
background: transparent;             /* было: white */

/* .diary__input, .diary__textarea */
border: none;                        /* было: 1px solid var(--velo-border) */
border-radius: 5px;                  /* было: var(--radius-lg) */
/* focus: */
border: 2px solid var(--velo-border); /* было: border-color: var(--velo-primary) */
```

**`frontend/src/views/user/CheckinView.vue`**
```css
/* .checkin__mood-btn */
border: 1px solid var(--velo-border);   /* было: 2px solid var(--velo-border) */
border-radius: var(--radius-md);        /* было: 16px — hardcoded */

/* .checkin__mood-btn--selected */
border-color: var(--velo-primary);
background: var(--velo-glass-blue-15);  /* было: rgba(51, 77, 110, 0.05) */
/* убрать box-shadow */

/* все .checkin__mood-btn--selected.checkin__mood-btn--* — убрать */
/* (три блока с кастомными цветами per mood — убрать, оставить только общий selected) */

/* .checkin__textarea */
border: none;                           /* было: 1px solid var(--velo-border) */
border-radius: 5px;                     /* было: var(--radius-lg) */
/* focus: border: 2px solid var(--velo-border) */
```

**`frontend/src/views/user/FeedbackView.vue`**
```css
/* .feedback__rating-btn */
border: 1px solid var(--velo-border);   /* было: 2px solid */
border-radius: var(--radius-md);        /* было: 16px */

/* .feedback__rating-btn--selected.* — убрать все три блока per-rating */
/* оставить только общий: */
.feedback__rating-btn--selected {
  border-color: var(--velo-primary);
  background: var(--velo-glass-blue-15);
}

/* .feedback__textarea */
border: none;
border-radius: 5px;
/* focus: border: 2px solid var(--velo-border) */
```

**`frontend/src/views/user/TopupView.vue`**
```css
/* .topup__balance */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */

/* .topup__balance-value */
font-family: var(--font-body);         /* было: var(--font-heading) */

/* .topup__preset */
border: 1px solid var(--velo-border);  /* было: 2px solid */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */

/* .topup__preset--active */
background: var(--velo-glass-blue-15); /* было: rgba(51, 77, 110, 0.05) */

/* .topup__custom-input-wrap */
border: 1px solid var(--velo-border);  /* было: 2px solid var(--velo-primary) */
border-radius: var(--radius-md);       /* было: var(--radius-md) — ок */
```

**`frontend/src/views/user/TopupSuccessView.vue`** и **`TopupCancelView.vue`**
```css
/* .topup-result__title */
font-family: var(--font-body);
/* font-weight уже покрыто общим правилом выше */

/* .topup-result__balance */
font-family: var(--font-body);
```

**`frontend/src/views/user/NotFoundView.vue`**
```css
/* .not-found */
background: transparent;   /* было: var(--velo-bg-start) */

/* .not-found__title */
font-family: var(--font-body);
/* font-weight покрыто общим правилом */

/* .not-found__btn */
border-radius: var(--radius-full);  /* было: var(--radius-md) */
/* font-weight покрыто общим правилом */
```

**`frontend/src/views/user/MyBookingsView.vue`**
```css
/* .bookings__filter */
/* font-weight покрыто общим правилом */
/* border оставить — это функциональные chip-фильтры, не карточки */
```

---

## DS-8: Master Views

### Общие замены по всем `frontend/src/views/master/*.vue`

Те же 9 правил что и для DS-7 (font-heading → font-body, font-weight → 400, rgba убрать).

### Дополнительные точечные правки

**`frontend/src/views/master/MasterApplyView.vue`**
```css
/* .apply-view */
background: transparent;   /* было: linear-gradient(...) */
```

**`frontend/src/views/master/MasterProfileView.vue`**
```css
/* .master-profile__header */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */

/* .master-profile__section */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */

/* .master-profile__chip */
background: var(--velo-glass-blue-15); /* было: var(--velo-bg-subtle) */
border: none;                          /* было: 1px solid var(--velo-border) */

/* .master-profile__finance-link */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */
/* убрать: box-shadow + transform в hover */
```

**`frontend/src/views/master/MasterDashboardView.vue`**
```css
/* .master-dashboard__stat-card */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-md) — ок */

/* .master-dashboard__ai-card */
background: var(--velo-glass-blue-15); /* было: var(--velo-bg-subtle) */
border: none;                          /* было: 1px solid var(--velo-border) */

/* .master-dashboard__practice-card */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-md) — ок */

/* .master-dashboard__action-btn */
border: none;                          /* было: 1px solid var(--velo-border) */
```

**`frontend/src/views/master/MasterPracticesView.vue`**
```css
/* .master-practices__tabs */
background: transparent;               /* было: var(--velo-bg-card) */
border-bottom: none;                   /* было: 1px solid var(--velo-border) */
```

**`frontend/src/views/master/AnalyticsView.vue`**
```css
/* .analytics__stat-card */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */

/* .analytics__header */
border-bottom: none;                   /* было: 1px solid var(--velo-border) */

/* .analytics__tabs */
border-bottom: none;                   /* было: 2px solid var(--velo-border) */
```

**`frontend/src/views/master/CreatePracticeView.vue`** и **`EditPracticeView.vue`**
```css
/* .*__price-calc */
background: var(--velo-glass-blue-15); /* было: var(--velo-bg-subtle) */
border: none;                          /* было: 1px solid var(--velo-border) */

/* .*__date-input */
background: #ffffff;                   /* было: var(--velo-bg-card) */
border: none;                          /* было: 1px solid var(--velo-border) */
border-radius: 5px;                    /* было: var(--radius-md) */
/* focus: border: 2px solid var(--velo-border) */

/* .*__payment-option */
background: #ffffff;                   /* было: var(--velo-bg-card) */
border: 1px solid var(--velo-border);  /* оставить — функциональный */

/* .*__dialog */
border-radius: var(--radius-md);       /* было: var(--radius-lg) */
```

---

## DS-9: Admin Views

Admin — вне скоупа дизайна VELΘ. Только убрать явные сломы.

### Общие замены по всем `frontend/src/views/admin/*.vue`

1. `font-weight: 700` → `400`
2. `font-weight: 600` → `400`
3. `font-weight: 500` → `400`
4. `border-radius: var(--radius-lg)` → `var(--radius-md)` на карточках

**Не трогать в admin:**
- Цвета предупреждений и статусов — они уже на переменных
- `background: var(--velo-bg-card)` — оставить белый фон на карточках (admin не имеет фото-фона)
- `border: 1px solid var(--velo-border)` — оставить, это помогает читаемости в admin

---

## Порядок выполнения и деплоя

```
1. DS-1 → деплой → проверить что ничего не сломалось, цвета сдвинулись
2. DS-2 → деплой → проверить фон виден
3. DS-3 → деплой → проверить кнопки и инпуты
4. DS-4 → деплой → проверить навбар и хедер
5. DS-5 → деплой → проверить иконки (необязательно, emoji работают)
6. DS-6 → деплой → проверить карточки практик и бронирований
```

После каждого деплоя — скриншот, если что-то не так — чинить до следующей фазы.

---

## Что НЕ меняем

- Всю бизнес-логику, сторы, API
- TypeScript-типы
- Структуру шаблонов (только стили)
- Admin views — получат новый вид автоматически через DS-1
- `frontend/src/views/user/*` и `frontend/src/views/master/*` — получат новый вид через DS-1 + DS-3 + DS-6 автоматически. Трогать только если есть видимые сломы после деплоя DS-6.
