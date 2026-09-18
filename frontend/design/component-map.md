# Карта компонентов — Vue DS ↔ Figma

> Сгенерирована из барелов и шапок компонентов 2026-09-18 (Фаза 3в, ТЗ п. 11.2/11.6.1).
> Источник назначений — шапки самих файлов (`src/components/ui/*.vue`); здесь — краткая форма.
> Колонка Figma заполняется по экспортам/списку компонентов Figma (Уровень 0, п. 11.5) — до тех пор «—».
>
> **Правило:** компонент для экрана берётся только из этой карты, через барелы
> `@/components/ui` и `@/components/icons`. Новый компонент = карта + барел + утверждение владельца.
> Правила превращения дизайна в код — рядом: [design.rules.md](./design.rules.md).

## Кнопки и навигация

| Vue | Назначение | Ключевые пропсы | Figma |
| --- | --- | --- | --- |
| `VButton` | основная кнопка, стеклянная пилюля | `variant` primary/secondary/danger/ghost/outline, `size`, `block`, `disabled`, `loading` | — |
| `VBackButton` | единая кнопка «назад» (белый круг 44×44) | `ariaLabel`, `variant` | — |
| `VMoreLink` | единый контрол «Подробнее» (лейбл + пилюля со стрелкой) | `label` | — |
| `VListRow` | строка белой карточки-списка с опциональным lead-визуалом | `title`, `subtitle`, `clickable` | — |
| `VMenuRow` | строка настроек/профиля: белая плашка + иконка/стрелка/бейдж | `label`, `variant`, `showArrow`, `badge`, `dot` | — |
| `VProgressRow` | строка-метр с прогресс-треком (админ) | `label`, `value`, `chevron`, `clickable` | — |
| `VMenu` + `VMenuItem` | кебаб «…» + поповер круглых иконочных кнопок | `ariaLabel` / `icon`, `ariaLabel` | — |

## Ввод и выбор

| Vue | Назначение | Ключевые пропсы | Figma |
| --- | --- | --- | --- |
| `VInput` | инпут с лейблом, без рамки в покое, фокус-ринг | `modelValue`, `label`, `placeholder`, `type`, `error`, `disabled` | — |
| `VTextarea` | многострочный ввод | `modelValue`, `label`, `placeholder`, `rows`, `error`, `disabled` | — |
| `VSelect` | нативный select в белой плашке | `modelValue`, `label`, `placeholder`, `options`, `error`, `disabled` | — |
| `VCheckbox` | квадратный чекбокс + подпись | `modelValue`, `label`, `disabled`, `size` | — |
| `VSwitch` | булев переключатель (пилюля + ручка) | `modelValue`, `disabled`, `ariaLabel` | — |
| `VRadioGroup` | радио-список одиночного выбора | `modelValue`, `options` | — |
| `VDayPicker` | выбор дня недели: семь круглых тумблеров ПН…ВС | `modelValue`, `ariaLabel` | — |
| `VWheel` | iOS-скролл-вил: выбор центрированным элементом | `modelValue`, `options`, `itemHeight` | — |
| `VSegment` / `VSegmentTrack` | сегмент-контрол: пилюли / «трек + бегунок» | `modelValue`, `options` (+ `variant` у track) | — |

## Оверлеи и обратная связь

| Vue | Назначение | Ключевые пропсы | Figma |
| --- | --- | --- | --- |
| `VModal` | модальный диалог: оверлей, Esc/клик-вне, транзишены | `open`, `closeOnOverlay`, `showClose` | — |
| `VBottomSheet` | флэш-шит: ручка, тайтл, контент, опц. primary-кнопка | `open`, `title`, `saveLabel` | — |
| `VConfirmDialog` | подтверждение поверх канона `VModal` | `open`, `title`, `message`, `confirmLabel` | — |
| `VToast` | тосты снизу, автозакрытие (монтируется раз в `App.vue`) | — | — |
| `VLoader` | CSS-спиннер | `size` | — |
| `VEmptyState` | пустое состояние | `icon`, `title`, `description`, `variant` | — |

## Отображение данных

| Vue | Назначение | Ключевые пропсы | Figma |
| --- | --- | --- | --- |
| `VCard` | белый card-канон (opaque white + бордер + radius) | `clickable`, `padding` | — |
| `VStatCard` | карточка числовой статистики + дельта-тренд | `value`, `label`, `icon`, `clickable`, `layout` | — |
| `VMetricHero` | hero-метрика: иконочный круг + крупное значение (админ) | `value`, `label` | — |
| `VBarChart` | недельный бар-чарт (админ) | `bars`, `emptyText` | — |
| `VRatingBar` | строка распределения оценок: иконка + цветной трек | `label`, `value`, `barColor` | — |
| `VRatingBadges` | трио бейджей fire/good/confused | `fire`, `good`, `confused` | — |
| `VBadge` | пилюля-статус | `variant` | — |
| `VTag` | пилюля-тег категории (стеклянный тинт) | `variant` | — |
| `VChip` | стеклянный чип: таг или фильтр | `size`, `active`, `clickable` | — |
| `VAvatar` | круглый аватар: картинка или инициалы | `name`, `url`, `size` | — |
| `VAccordion` | раскрывающаяся строка | `title`, `defaultOpen` | — |
| `VPaginationDots` | канонические точки переключения шагов | `total`, `active` | — |
| `VeloLogo` | логотип-мандала VELΘ | `size`, `variant`, `spin` | — |

## Иконки — 81 шт. (`@/components/icons`)

- все рисуются `currentColor`, принимают `size` (по умолчанию 24);
- исключения-иллюстрации со своими градиентами: `IconMoodLow/Mid/High`, `VeloLogo`;
- **новые иконочные пакеты не тянуть** — новая иконка = новый SVG-компонент в бареле (как в `Design_prototype/assets/icons/`).

## Фичевые композиты (`shared/`, `layout/`)

Не часть DS и не входят в карту: собираются из компонентов выше (примеры — `BookingCard`, `CalendarPracticeCard`, `DiarySearchResults`, `WeekStrip`, `VTabBar`). При сборке нового экрана сначала искать готовое здесь, затем — карту DS.

## Как обновлять карту

Новый компонент: файл в `ui/` (или иконка в `icons/`) → экспорт в барел → строка в этой карте → утверждение владельца. Назначение компонента living в шапке файла; карта — краткая форма и единственный список.
