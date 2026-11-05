# `@velo/ui` — UI-кит VELO (приватный пакет монорепы)

> P1-каркас (FE-116) + P2 батч A (FE-117) + P2 хвост A/батч B (FE-140) +
> P4 иконки (FE-119) + P5-швы FE-143 (dom mini-seam, перенос
> useBodyScrollLock, инверсия useKeyboardFieldScroll): каркас, контракт
> токенов и Storybook подняты до переноса; **батч A (FE-117) перенёс первые
> 7 компонентов** (VAvatar,
> VBadge, VButton, VCard, VChip, VListRow, VTag); **FE-140 доложил хвост A
>
> - батч B — 9 компонентов** (VLoader, VSegment c типом `SegmentOption`,
>   VSegmentTrack, VSwitch, VPaginationDots, VRatingBar, VStatCard,
>   VMetricHero, VWheel) со сторями и конвенциями §7.2; **FE-119 (P4) перенёс
>   12 сквозных иконок** в `src/icons/` (стрелка, галка, крест, точки,
>   required-маркеры, предупреждение + семья `ICON_MAP` для VEmptyState) —
>   домен-иконки остаются в приложении. Остальные компоненты переезжают
>   батчами в P3–P6.

## Что здесь чему подчиняется

- **Пакет приватный** (`private: true`), публикация во внешний npm не
  планируется; потребитель один — `frontend` (`workspace:*` с батча A —
  баррел приложения ре-экспортирует пакет по компоненту).
- **`vue` — peer** (`^3.5`): никогда не бандлится.
- **Стили едут как есть** в SFC `<style>`; значения — только `var(--velo-*)`
  и голые масштабные токены. **Токены не уезжают в пакет** (принцип 2):
  `variables.css` остаётся в приложении и является контрактом хоста.

## Контракт токенов (§3.6) — машинно-читаемый

Каждый `var(--…)`, который использует пакет, обязан:

1. входить в список ниже (добавление — в PR, который вводит использование);
2. быть объявленным в золотом `frontend/src/styles/variables.css`;
3. **tier-правило (§7.3)**: только семантические и компонентные уровни.
   Примитивный цветовой рамп (`--velo-teal|peach|pink|blue|sand-NNN`,
   `--velo-white`) и сырые значения (hex — stylelint `color-no-hex` уже
   первый слой) запрещены. Список ниже — allowlist, поэтому примитив в него
   не попадает в принципе. **Единственное исключение (батч A + батч B +
   иконки P4, FE-117/FE-140/FE-119):** компоненты едут «как есть» (§3.3), и
   часть вариантных цветов до сих пор не имеет семантических ролей — эти
   ровно 9 токенов внесены в закрытый `LEGACY_MIGRATED_RAMP` в тесте (ниже
   с пометкой `*legacy-ramp`) и уходят оттуда только PR-ом, который выводит
   использование. FE-119 (P4) новых вхождений не добавило: `--velo-white`
   у иконки IconRequiredDone — тот же «как есть» инлайн-штрих (SVG
   presentation-атрибут не читает `var()`). Новый примитив по-прежнему
   роняет гейт.

Проверяется тестом `src/styles/token-contract.test.ts` в каждом `pnpm test`.

```velo-ui-token-contract
# --- bare scale family (frozen names, PROMPT №437) ---
--font-body
--font-heading
--radius-full
--radius-md
--radius-xl
--space-1
--space-2
--space-3
--space-4
--space-5
--space-hairline
--transition-base
--transition-fast
# --- semantic / component tokens (batch A FE-117 + batch B FE-140) ---
--velo-bg-card-solid
--velo-bg-subtle
--velo-blue-100            # *legacy-ramp (VBadge/VTag blue variant)
--velo-border
--velo-border-card
--velo-border-width
--velo-dur-base
--velo-dur-press
--velo-dur-pulse
--velo-ease-breath
--velo-ease-out
--velo-error
--velo-fog-color
--velo-fs-12
--velo-fs-14
--velo-fs-16
--velo-fs-18
--velo-fs-22
--velo-fs-24
--velo-fs-28
--velo-fs-32
--velo-gap-11
--velo-gap-2
--velo-gap-3
--velo-gap-6
--velo-glass-blue-15
--velo-glass-blue-200-15
--velo-glass-blue-60
--velo-glass-blue-700-60
--velo-glass-border
--velo-glass-peach-40
--velo-glass-teal-30
--velo-glass-white-01
--velo-glass-white-30
--velo-inset-12
--velo-nav-inactive-bg
--velo-peach-700           # *legacy-ramp (VBadge/VTag warning text)
--velo-pink-100            # *legacy-ramp (VBadge/VTag error bg)
--velo-pink-300            # *legacy-ramp (VBadge error text, VButton danger)
--velo-pink-500            # *legacy-ramp (VStatCard rose value/delta)
--velo-primary
--velo-primary-dark
--velo-radius-badge
--velo-sand-100            # *legacy-ramp (VTag sand bg)
--velo-shadow-glow
--velo-shadow-switch
--velo-skeleton-delay
--velo-skeleton-fill
--velo-size-40
--velo-size-44
--velo-size-50
--velo-teal-400            # *legacy-ramp (VMetricHero icon glyph)
--velo-teal-600            # *legacy-ramp (VBadge success text, VStatCard teal)
--velo-text-muted
--velo-text-primary
--velo-text-secondary
--velo-white               # *legacy-ramp (active/danger text on fills, FE-119: IconRequiredDone check stroke)
```

## Стратегия CSS (§3.3)

Стили компонентов едут в пакете как есть (`*.vue` SFC). **Разрешение
потребления (решение батча A, FE-117):** приложение собирает **исходники**
пакета — `frontend` резолвит `@velo/ui` в `packages/velo-ui/src` (точный
алиас в `vite.config`/`vitest.config` + `paths` в tsconfig). Компонентные
стили продолжают ехать в чанках приложения ровно там же, где ехали до
переноса, поэтому каскад `variables.css → компоненты → skin-tokens.css`
не меняется ни для золотой сборки, ни для скина, и битовое сравнение
чанков батча A сводится к ожидаемым механическим диффам (пути модулей и
scope-id). Побочный выигрыш: ни один гейт (CI, Docker, pre-commit) не
зависит от порядка «сначала собрать пакет». Css-бандл `dist/velo-ui.css`
(`@velo/ui/style.css`) остаётся артефактом пакета для ВТОРОГО хоста и
проверяется сборкой в CI; если владелец вернёт потребление через дист
(буква §3.3), переключение — это замена алиаса на экспорты `exports`.

## Структура (§3.5): папка на компонент

```
src/components/VButton/
  VButton.vue        # SFC как есть (стили внутри)
  VButton.test.ts    # тест колокализован, не в плоском каталоге
  VButton.stories.ts # сторя пишется в переносном PR, не в конце
  index.ts           # ре-экспорт для баррела
```

Баррел `src/index.ts` собирается из папочных `index.ts`. Батч A (FE-117)
посадил в эту структуру 7 живых компонентов (VAvatar, VBadge, VButton,
VCard, VChip, VListRow, VTag); FE-140 доложил хвост A + батч B — 9
компонентов (VLoader, VSegment, VSegmentTrack, VSwitch, VPaginationDots,
VRatingBar, VStatCard, VMetricHero, VWheel), каждый со сторей и
колокализованным тестом, написанным до переноса. Конвенции §7.2 применены
в переносных PR: `data-velo-*` состояния/варианты (additive), attrs-корень
и слоты как швы — VLoader режет i18n-зависимость через attrs (локализованную
подпись баррел приложения подставляет обёрткой до P3), VStatCard — через
слот `pending` с каноническим фолбэком вместо импорта VSkeleton (скелетоны
вне карты батча остаются в приложении). Заглушка VStub, доказавшая конвейер
в P1, удалена её же первым реальным батчем.

**Иконки (FE-119, §4 P4)** — плоская семья, НЕ папка на компонент: глиф —
один template-only SFC на общем контракте `size` (по умолчанию 24,
currentColor), папка на глиф была бы шумом.

```
src/icons/
  IconCheck.vue       # 12 сквозных глифов: хром UI + семья ICON_MAP (VEmptyState)
  icons.test.ts       # один семейный тест (написан в приложении до git mv)
  icons.stories.ts    # одна витрина на всю семью
  index.ts            # баррел семьи; src/index.ts ре-экспортирует его звёздочно
```

Домен-иконки (IconBrain, IconBreathwork, IconMoodScale*, …) остаются в
`frontend/src/components/icons`; баррел приложения ре-экспортирует 12
сквозных из пакета — потребители не меняют импортов до P6/P8.

## Швы (FE-143, §4 P5 — предпосылки P6)

Три шва под перенос оверлеев и полей (VModal/VBottomSheet/VInput/VTextarea):

- **dom mini-seam — `src/platform/dom.ts`**: единственная дверь пакета к
  `document`, зеркало закона фронтенда (`no-restricted-globals`, включён в
  eslint пакета тем же FE-143). Мини-набор ровно под резидентов: пара
  `onDocumentEvent`/`offDocumentEvent` (Escape-keydown оверлеев в P6) и пара
  `setBodyOverflow`/`toggleRootClass` (записи скролл-лока). Пакет-внутренний:
  из баррела не экспортируется, приложение продолжает ходить через свой
  `@/platform/dom`.
- **`useBodyScrollLock` переехал** (`src/useBodyScrollLock.ts`, тесты вместе
  с кодом, контракт байт-в-байт): реф-счётчик и класс `velo-scroll-locked` —
  собственность кита, записи идут через dom-seam пакета. Потребители в
  приложении (VModal/VBottomSheet) меняют импорт на `@velo/ui`.
- **Инверсия `useKeyboardFieldScroll`** (`src/keyboardFieldScroll.ts`):
  provide-ключ `KEYBOARD_FIELD_SCROLL_INJECTION_KEY` + `useKeyboardFieldScroll()`
  с **дефолтом no-op**. Реализация остаётся в хосте (читает его
  platform/host); приложение даёт фабрику один раз в корне
  (`provideKeyboardFieldScroll()` в App.vue). Хост даёт именно ФАБРИКУ:
  каждый потребитель запускает её в своём setup, чтобы пер-компонентный
  unmount-cleanup (выселение visualViewport-листенера) сохранился.

## Storybook (§3.4)

```bash
pnpm storybook          # из корня репозитория (или pnpm storybook в пакете)
```

Скелет витрины живёт здесь с P1; каждая следующая сторя пишется в своём
батче и сверяется с Figma-фреймом. Витрина — «хост» для токенов: preview
подключает **золотой** `frontend/src/styles/variables.css` (пакет сам
никаких значений темы не несёт).

## Сборка и гейты

```bash
pnpm build      # vite lib-mode → dist/index.js + dist/velo-ui.css; vue-tsc → dist/types/*.d.ts
pnpm verify     # stylelint (тот же токен-замок, extends конфига приложения) + typecheck + vitest
```

Eslint-гейт пакета исполняется из `frontend/scripts/lint-budget.mjs`
(тот же нулевой бюджет FE-73): flat-config ESLint не линтит файлы вне
базового пути конфига, поэтому у пакета свой `eslint.config.js` (зеркало
закона фронтенда), который budget-скрипт запускает из каталога пакета.

## Инструментальные версии

- Storybook и `@storybook/vue3-vite` запинены точной версией `10.6.2`
  (2026-10-12): правило двух недель зрелости — свежейшие `10.6.4/5`
  моложе его. Обновление — отдельным PR с прогоном витрины.
- Остальные devDeps — те же диапазоны, что у `frontend` (единый lock-файл
  воркспейса разрешает их в те же версии).
