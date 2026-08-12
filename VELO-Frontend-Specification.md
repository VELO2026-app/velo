# VELO — Техническое задание: Frontend

**Версия:** 2.6
**Дата:** 6 июля 2026
**Статус:** Active

> **ИСТОЧНИК ДИЗАЙНА (канон, 2026-06):** Figma выведена из источников **навсегда**.
> Источник дизайна каждого экрана — присланный оператором **SVG текущего состояния
> экрана**; всякое UI-значение через DS-токен `--velo-*` / DS-компонент (DS-first).
> Фаза-история ниже (F0–F11) и упоминания «из мокапов» / Figma-node — исторический
> отчёт о первоначальной сборке, НЕ действующий источник дизайна.

> **История версий (v2.0–v2.6)** — вынесена в git-лог; фазовые детали каждой версии — в секциях PHASE F0–F16 ниже + Фронтовый Кодекс. Текущая версия — в шапке.

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> STALE-BUT-HARMLESS overall — NOT rewritten this round. Five spots referencing the deleted
> `AdminConsistencyView` / `/admin/consistency` screen (removed 2026-07-07, `9ca5619`) were
> corrected: the role table, two tree comments, the route table, and phase F8.3. Everything
> else in this document is UNVERIFIED as of this pass.

---

## 1. Обзор

### 1.1. Цель

Фронтенд VELO — единое SPA-приложение с ролевым роутингом, работающее в двух режимах:

1. **Telegram WebApp** — основной канал MVP. Открывается внутри Telegram, авторизация через initData
2. **Standalone PWA** — будущий режим. Устанавливается на Home Screen, авторизация через email/OAuth

Оба режима используют один и тот же код. Различия инкапсулированы в платформенной абстракции.

### 1.2. Критерии готовности MVP (Frontend)

| Критерий     | Описание                                           |
| ------------ | -------------------------------------------------- |
| Auth         | Telegram WebApp авторизация работает               |
| Каталог      | Юзер видит практики, может фильтровать             |
| Бронирование | Юзер записывается и отменяет запись                |
| Баланс       | Пополнение через Stripe, отображение баланса       |
| Master CRUD  | Мастер создаёт, редактирует, финализирует практики |
| Admin        | Верификация мастеров, статистика, модерация ✅     |
| PWA          | Приложение добавляется на Home Screen              |

### 1.3. Вне scope MVP (Frontend)

- Standalone-авторизация (email/OAuth) — только Telegram WebApp. **Экраны Phase A построены, но припаркованы:** спящие незалинкованные `/auth/*` (Landing/Login/восстановление×2), живут лишь с web-auth-бэком Zod E17 — см. F13
- Офлайн-режим (кроме заглушки "Нет подключения")
- Push-уведомления через Service Worker
- Тёмная тема (пока только светлая)
- Локализация (только русский)
- Анимации переходов между экранами

### 1.4. Три роли — одно приложение

Приложение определяет роль из `GET /api/v1/users/me` и показывает соответствующий интерфейс:

| Роль   | Tab Bar                               | Доступ                                            |
| ------ | ------------------------------------- | ------------------------------------------------- |
| user   | Дашборд, Календарь, Дневник, Профиль  | Каталог, бронирования, баланс                     |
| master | Дашборд, Практики, Аналитика, Профиль | Всё user + управление практиками, финансы мастера |
| admin  | Дашборд, Мастера, Модерация           | Верификация, статистика, жалобы         |

Master видит свои user-экраны + мастер-экраны. Переключение через профиль (не отдельное приложение).

> **Примечание (2026-06, обновлено v2.4):** переключение режима реализовано — у
> Мастера/Админа в профиле есть точка входа в пользовательский интерфейс. Ролевой
> свитч (`POST /users/me/role`) с F16 — capability-derived (A1=Б): verified-мастер
> ↔ user; админ — все три роли (round-trip через server-side маркер `home_role`);
> обычный юзер свитчиться не может; не-админ НИКОГДА не получает admin. Флаг
> `ROLE_SWITCH_ENABLED` и seeded `allowed_roles` удалены (F1=А).

---

## 2. Технологический стек

| Компонент | Технология          | Версия | Назначение                |
| --------- | ------------------- | ------ | ------------------------- |
| Фреймворк | Vue 3               | latest | Composition API, SFC      |
| Язык      | TypeScript          | 5.x    | Строгая типизация         |
| Сборка    | Vite                | latest | HMR, быстрая сборка       |
| Роутинг   | Vue Router          | 4.x    | Role-based guards         |
| Стейт     | Pinia               | latest | Реактивные хранилища      |
| HTTP      | Fetch (обёртка)     | native | Запросы к API             |
| PWA       | vite-plugin-pwa     | latest | Manifest + Service Worker |
| Стили     | Свой CSS            | —      | Дизайн-система из мокапов |
| Линтинг   | ESLint + Prettier   | latest | Качество кода             |
| Платформа | Telegram WebApp SDK | latest | initData, тема, haptic    |

### 2.1. Почему Vue 3

- Синтаксис ближе к HTML — интуитивен для бэкенд-разработчиков
- Однофайловые компоненты (.vue) — шаблон, логика, стили в одном файле
- Composition API — композиция логики без class-based паттернов
- Лучшая документация среди SPA-фреймворков
- Достаточная экосистема для MVP и масштабирования

### 2.2. Почему не React / Svelte

- **React:** JSX контринтуитивен для новичков, больше "магии" (хуки, ре-рендеры), для MVP разница несущественна
- **Svelte:** Маленькое коммьюнити, меньше примеров для Telegram WebApp

---

## 3. Архитектура

### 3.1. Структура проекта

```
velo/                              ← GitHub repo root (уже существует)
├── backend/                       ← Бэкенд (существует)
├── frontend/                      ← Фронтенд (новый)
│   ├── src/
│   │   ├── api/                   ← HTTP-клиент + типизированные методы
│   │   │   ├── client.ts          ← Base fetch обёртка, interceptors
│   │   │   ├── types.ts           ← TypeScript-интерфейсы (из OpenAPI)
│   │   │   ├── utils.ts           ← Shared helpers (buildQuery)
│   │   │   ├── auth.ts            ← POST /auth/telegram, logout
│   │   │   ├── users.ts           ← GET/PATCH /users/me
│   │   │   ├── practices.ts       ← CRUD практик
│   │   │   ├── bookings.ts        ← Бронирования + purchase + preview
│   │   │   ├── payments.ts        ← Topup
│   │   │   ├── masters.ts         ← Apply, profile, payout, withdrawals
│   │   │   └── admin.ts           ← Stats, verify, reports (consistency REMOVED 2026-07-07 `9ca5619`)
│   │   │
│   │   ├── components/            ← Переиспользуемые UI-компоненты
│   │   │   ├── ui/                ← Примитивы: VButton, VInput, VCard...
│   │   │   ├── layout/            ← VHeader, VTabBar, MobileLayout...
│   │   │   └── shared/            ← PracticeCard, BookingCard, BookingPopup, CancelBookingPopup...
│   │   │
│   │   ├── views/                 ← Экраны (по ролям)
│   │   │   ├── auth/              ← LoginView, LoadingView
│   │   │   ├── user/              ← Dashboard, Calendar, Practice, Bookings...
│   │   │   ├── master/            ← Dashboard, Practices, Analytics, Apply...
│   │   │   └── admin/             ← Dashboard, Masters, Reports... (Consistency REMOVED 2026-07-07 `9ca5619`)
│   │   │
│   │   ├── stores/                ← Pinia хранилища
│   │   │   ├── auth.ts            ← user, token, role, isAuthenticated
│   │   │   ├── practices.ts       ← list, filters, selected
│   │   │   ├── bookings.ts        ← my bookings
│   │   │   ├── balance.ts         ← balance_cents, operations
│   │   │   └── master.ts          ← master profile, practices, finance
│   │   │
│   │   ├── router/                ← Vue Router
│   │   │   ├── index.ts           ← Маршруты + guards
│   │   │   └── guards.ts          ← Auth guard, role guard
│   │   │
│   │   ├── platform/              ← Абстракция Telegram / Standalone
│   │   │   ├── index.ts           ← Автодетект среды, экспорт
│   │   │   ├── telegram.ts        ← Реальный Telegram WebApp SDK
│   │   │   ├── standalone.ts      ← Заглушки для браузера
│   │   │   └── types.ts           ← Общий интерфейс Platform
│   │   │
│   │   ├── composables/           ← Vue composables (переиспользуемая логика)
│   │   │   ├── useAuth.ts         ← Login/logout flow + waitUntilReady()
│   │   │   ├── usePagination.ts   ← Пагинация + infinite scroll
│   │   │   ├── useToast.ts        ← Всплывающие уведомления
│   │   │   └── useForm.ts         ← Валидация форм
│   │   │
│   │   ├── styles/                ← Глобальные стили
│   │   │   ├── variables.css      ← Дизайн-токены (из мокапов)
│   │   │   ├── components.css     ← Базовые стили компонентов
│   │   │   ├── global.css         ← Reset, typography, utilities
│   │   │   └── telegram.css       ← Telegram-specific overrides
│   │   │
│   │   ├── utils/                 ← Утилиты
│   │   │   ├── format.ts          ← Форматирование дат, валют, чисел
│   │   │   ├── currency.ts        ← eurStringToCents(), centsToEurString()
│   │   │   ├── commission.ts      ← COMMISSION_RATE константа
│   │   │   ├── practiceOptions.ts ← DURATION_OPTIONS, TIMEZONE_OPTIONS
│   │   │   ├── validation.ts      ← Общие валидаторы форм
│   │   │   ├── constants.ts       ← Статусы, роли, магические числа
│   │   │   └── adminHelpers.ts    ← Общие хелперы для admin-вью (F8)
│   │   │
│   │   ├── App.vue                ← Корневой компонент
│   │   └── main.ts                ← Точка входа: createApp, router, pinia
│   │
│   ├── public/
│   │   ├── manifest.json          ← PWA-манифест
│   │   ├── sw.js                  ← Service Worker (через vite-plugin-pwa)
│   │   ├── js/
│   │   │   └── telegram-web-app.js ← Локальная копия Telegram SDK (3331 строка)
│   │   └── icons/                 ← Иконки приложения (192, 512)
│   │
│   ├── index.html                 ← SPA entry point
│   ├── vite.config.ts             ← Vite + PWA plugin config
│   ├── tsconfig.json              ← TypeScript config
│   ├── eslint.config.js           ← ESLint flat config
│   ├── .prettierrc                ← Prettier config
│   ├── package.json               ← Dependencies
│   ├── .env.example               ← VITE_API_BASE_URL=...
│   ├── .gitignore                 ← node_modules, dist
│   ├── Dockerfile                 ← Multi-stage: node build → nginx
│   └── README.md                  ← Инструкция
│
├── velo-mockups/                  ← UI-прототипы (существуют)
├── VELO-Technical-Specification.md
├── VELO-Frontend-Specification.md ← ЭТОТ ДОКУМЕНТ
└── ...
```

### 3.2. Интеграция с бэкендом

```
Browser / Telegram
      │
      ▼
   Nginx (api.talentir.info)
      │
      ├── /*         → static files → frontend/dist/
      ├── /api/*     → proxy_pass   → Docker (FastAPI :8000)
      └── /health    → proxy_pass   → Docker (FastAPI :8000)
```

Фронтенд и бэкенд на одном домене — CORS не нужен.

При переезде на продакшн-сервер заказчика:

- Новый домен в .env (VITE_API_BASE_URL)
- Nginx: app.domain.com → фронтенд, api.domain.com → бэкенд
- Код не меняется

> **Бэкенд-контракты — обновление (backend-sourced, 2026-06-20).** Этот блок ведёт
> бэкенд (Zod); статус ВАЙРИНГА на стороне фронта — за фронт-командой (P0-вайринг
> сделан в `f6c9744`). Зафиксированы как ground-truth контракта:
> - **Новые эндпоинты под вайринг/сверку:** `GET /masters/me/income?period`,
>   `GET /masters/me/transactions`, `GET /masters/me/students` (+`/{id}`),
>   `GET /masters/me/reviews?attention=` (cross-practice, поле `practice_title`),
>   `GET /practices/{id}/reviews` (+`attention`), `GET /admin/metrics/check-in|feedback|return`,
>   `GET /admin/revenue`, `GET /admin/practices` (+`/{id}` + roster). Типы — в
>   `generated.ts` (118 типов после регенерации). Подробности контрактов — Бэковый
>   Кодекс §2.
> - **Авто-финализация по длительности — закрыта бэкендом.** Практики `scheduled/live`
>   переводятся в `completed` фоновым воркером по `scheduled_at + duration + buffer`
>   (15 мин); ручной `finalizePractice` / кнопка «Завершить» бэкенду больше не нужны.
> - **Чек-ин Zoom-независим (продуктовый инвариант, важно для явки).** Явка теперь
>   засчитывается и по PRE-чек-ину, поэтому путь к чек-ину НЕ должен гейтиться
>   наличием `zoom_link` (баннер на дашборде + кнопка на live-экране).
> - **`ROLE_SWITCH_ENABLED` удалён (v2.4/F16, `15d5b0d`)** вместе с W-4 security-WARNING;
>   безопасность роль-свитча — в самой capability-политике (`derive_allowed_roles`).
>   Строку в TEST `.env` удалить при деплое (№264): под Docker безвредна (env-var
>   инжект, неизвестный ключ игнорится), на bare-metal ФАТАЛЬНА (`extra_forbidden`
>   на dotenv-файле). Раннбук №261 её удаляет.

### 3.3. Платформенная абстракция

```typescript
// src/platform/types.ts
interface Platform {
  name: "telegram" | "standalone";
  init(): Promise<void>;
  getInitData(): string | null; // Telegram initData или null
  getTheme(): "light" | "dark";
  hapticFeedback(type: string): void;
  showBackButton(cb: () => void): void;
  hideBackButton(): void;
  close(): void;
}
```

Telegram WebApp обнаруживается по наличию `window.Telegram?.WebApp`. Если нет — standalone-режим.

### 3.4. Соглашения

**Именование файлов:**

- Компоненты: PascalCase (`PracticeCard.vue`, `VButton.vue`)
- Утилиты, stores, api: camelCase (`auth.ts`, `usePagination.ts`)
- Стили: kebab-case (`variables.css`, `global.css`)

**Префикс V для UI-примитивов:**

- `VButton`, `VInput`, `VCard` — собственные компоненты дизайн-системы
- Без префикса — доменные компоненты (`PracticeCard`, `BookingList`)

**Комментарии:** на английском (как в бэкенде).

---

## 4. Фазы разработки

---

## PHASE F0: Инфраструктура ✅

### F0.1: Инициализация проекта ✅

**Цель:** Проект собирается, деплоится на VPS, пустая страница открывается.

**Задачи:**

- [x] package.json с TypeScript, Vue Router, Pinia
- [x] Структура папок (src/api, components, views, stores, router, platform, styles, composables, utils)
- [x] ESLint flat config + Prettier (единый стиль кода)
- [x] tsconfig.json — strict mode, path aliases (`@/` → `src/`)
- [x] vite.config.ts — base path, proxy для dev, env переменные
- [x] .env.example (`VITE_API_BASE_URL=https://api.talentir.info`)
- [x] .gitignore (node_modules, dist, .env)
- [x] README.md (команды: install, dev, build, lint)

**Результат:**

```
frontend/
├── src/
│   ├── App.vue                ← Корневой компонент (<RouterView />)
│   ├── main.ts               ← createApp + router + pinia + стили
│   ├── router/
│   │   └── index.ts          ← / → HomeView, catch-all → /
│   ├── views/
│   │   ├── HomeView.vue      ← Плейсхолдер (лого + "VELO" + v0.1.0)
│   │   ├── auth/.gitkeep
│   │   ├── user/.gitkeep
│   │   ├── master/.gitkeep
│   │   └── admin/.gitkeep
│   ├── styles/
│   │   ├── variables.css     ← Дизайн-токены из мокапов (1:1)
│   │   └── global.css        ← CSS reset + typography + Google Fonts
│   ├── api/.gitkeep
│   ├── components/{ui,layout,shared}/.gitkeep
│   ├── stores/.gitkeep
│   ├── platform/.gitkeep
│   ├── composables/.gitkeep
│   └── utils/.gitkeep
├── public/icons/favicon.svg
├── index.html                 ← Telegram SDK CDN + PWA meta-теги
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js
├── .prettierrc
├── package.json
├── package-lock.json          ← Для детерминированных билдов (npm ci)
├── env.d.ts                   ← TypeScript декларации для .vue и Vite env
├── .env.example
├── .gitignore
└── README.md
```

**Решения, принятые при реализации:**

- `package-lock.json` коммитится в репо — без него `npm ci` в Docker не работает
- `env.d.ts` — декларации для TypeScript: `.vue` файлы как модули, `ImportMetaEnv` для `VITE_*`
- `.gitkeep` в пустых папках — Git не трекает пустые директории
- Telegram SDK через CDN `<script>` в index.html (рекомендация Telegram для актуальной версии)
- `vue-tsc --noEmit` перед `vite build` в скрипте build — type-check как gate

**Критерий готовности:** `npm run build` проходит, `npm run lint` без ошибок. ✅

---

### F0.2: Дизайн-система (перенос из мокапов) ✅

**Цель:** CSS-переменные и базовые стили из мокапов перенесены в проект.

**Задачи:**

- [x] src/styles/variables.css — дизайн-токены из velo-mockups/css/variables.css
- [x] src/styles/global.css — reset, typography, базовые утилиты
- [x] main.ts — импорт стилей (variables.css первым, потом global.css)

**Решения, принятые при реализации:**

- variables.css — 1:1 перенос из мокапов + добавлен `--velo-bg-card: #FFFFFF`
- global.css — Google Fonts (Inter + Playfair Display), CSS reset, scrollbar стилизация
- components.css не создавался отдельно — компонентные стили будут в scoped `<style>` внутри `.vue` файлов (Phase F2.1)
- telegram.css не создавался — будет добавлен при необходимости в Phase F1.1

**Критерий готовности:** HomeView.vue использует CSS-переменные, выглядит корректно. ✅

---

### F0.3: Docker + деплой на VPS ✅

**Цель:** Фронтенд деплоится через `velo update`, доступен по HTTPS.

**Задачи:**

- [x] frontend/Dockerfile (multi-stage: node:22-alpine build → nginx:alpine serve)
- [x] frontend/nginx.conf (внутренний nginx: SPA fallback, gzip, кеш assets)
- [x] frontend/.dockerignore
- [x] docker-compose.yml перенесён из backend/ в **корень репо**
- [x] Новый сервис `frontend` (build: ./frontend, порт 3000, healthcheck)
- [x] Сервис `app` — build context изменён на `./backend`, env_file → `./backend/.env`
- [x] Nginx на хосте: `/*` → frontend:3000, `/api/*` + `/health` + `/ready` → app:8000
- [x] install_velo.sh обновлён (COMPOSE_DIR → repo root, два upstream в nginx)
- [x] `velo update` собирает оба сервиса (`app` + `frontend`)

**Файлы:**

```
velo/ (repo root)
├── docker-compose.yml         ← ПЕРЕНЕСЁН из backend/ — управляет всем стеком
├── backend/
│   ├── Dockerfile             ← Без изменений
│   ├── .env                   ← Без изменений (env_file: ./backend/.env)
│   └── ...
├── frontend/
│   ├── Dockerfile             ← НОВЫЙ: node:22-alpine → nginx:alpine
│   ├── nginx.conf             ← НОВЫЙ: SPA fallback на порту 3000
│   ├── .dockerignore          ← НОВЫЙ
│   └── ...
└── scripts/
    └── install_velo.sh        ← ОБНОВЛЁН: 8 точечных замен
```

**Docker-сервисы:**

```
velo-app        → 127.0.0.1:8000  (FastAPI)
velo-frontend   → 127.0.0.1:3000  (Nginx + Vue SPA)
velo-postgres   → internal only
velo-redis      → internal only
```

**Маршрутизация (Nginx на хосте):**

```
https://api.talentir.info/api/*     → velo-app:8000
https://api.talentir.info/health    → velo-app:8000
https://api.talentir.info/ready     → velo-app:8000
https://api.talentir.info/*         → velo-frontend:3000
```

**Решения, принятые при реализации:**

- docker-compose.yml в корне репо (не в backend/) — один файл управляет обоими сервисами
- backend/docker-compose.yml удалён
- `.env` остаётся в `backend/` — это бэкенд-конфиг, фронтенду не нужен (VITE\_\* вкомпиливаются при build)
- frontend зависит от app (`depends_on: app: condition: service_healthy`) — стартует после бэкенда
- Внутренний nginx в контейнере фронтенда (порт 3000) + внешний nginx на хосте (SSL + маршрутизация)
- Stripe переменные добавлены в `.env` генератор install_velo.sh: `STRIPE_SECRET_KEY=TEST`, `STRIPE_WEBHOOK_SECRET=TEST`, `STRIPE_PUBLISHABLE_KEY=TEST`, `STRIPE_SUCCESS_URL=TEST`, `STRIPE_CANCEL_URL=TEST`

**Критерий готовности:** `curl https://api.talentir.info/` → HTML-страница с "VELO". 353 passed, 3 skipped. ✅

---

### F0.4: PWA-заготовка ✅

**Цель:** Приложение можно добавить на Home Screen.

**Задачи:**

- [x] vite-plugin-pwa в vite.config.ts
- [x] public/manifest.json (name, short_name, icons, theme_color, display: standalone)
- [x] Иконки: 192x192, 512x512 (placeholder, заменим на брендинг заказчика)
- [x] Service Worker: precache статики (только кеширование, без офлайна)
- [x] meta-теги в index.html (apple-mobile-web-app-capable, viewport)

**Решения, принятые при реализации:**

- VitePWA: стратегия `generateSW` (автогенерация SW из build output), `registerType: 'autoUpdate'` (автообновление без промпта)
- `manifest: false` в VitePWA — манифест обслуживается из `public/manifest.json` напрямую, а не инлайнится плагином
- Workbox glob patterns: `**/*.{js,css,html,ico,png,svg,woff2}` — precache всей статики, source maps исключены
- manifest.json: `display: standalone`, `orientation: portrait`, `theme_color: #334D6E`, `background_color: #F8FAFC`
- Иконки с `purpose: "any maskable"` — работают и как обычные, и как адаптивные (Android)
- index.html meta-теги: `apple-mobile-web-app-capable: yes`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-touch-icon` → icon-192.png
- Google Fonts загружаются через `<link>` в index.html (FIX 10.6: заменяет `@import` в global.css — устраняет FOIT)

**Критерий готовности:** iPhone Safari → "Добавить на экран" → приложение открывается в standalone-режиме (без адресной строки). ✅

---

## PHASE F1: Auth + Платформа ✅

### F1.1: Платформенная абстракция ✅

**Цель:** Приложение знает, где запущено, и адаптируется.

**Задачи:**

- [x] src/platform/types.ts — интерфейс Platform (8 методов)
- [x] src/platform/telegram.ts — обёртка над `window.Telegram.WebApp`:
  - `init()` — `WebApp.ready()`, `expand()`, `setHeaderColor('#334D6E')`, `setBackgroundColor('#F8FAFC')`
  - `getInitData()` — `WebApp.initData || null`
  - `getTheme()` — `WebApp.colorScheme || 'light'`
  - `hapticFeedback(style)` — `WebApp.HapticFeedback.impactOccurred(style)` в try/catch
  - `showBackButton(cb) / hideBackButton()` — `WebApp.BackButton` с onClick/offClick cleanup
  - `close()` — `WebApp.close()`
- [x] src/platform/standalone.ts — safe no-op заглушки:
  - `getInitData()` → `null`
  - `hapticFeedback()` → `console.debug`
  - `showBackButton(cb)` → `window.history.back()` fallback
- [x] src/platform/index.ts — автодетект по `window.Telegram?.WebApp`, экспорт singleton `platform`

**Решения, принятые при реализации:**

- FIX 10.1: `window.Telegram?.WebApp` проверяется лениво через getter, не при импорте модуля — предотвращает краш если CDN заблокирован
- Типизированы только методы, реально используемые в `telegram.ts` — минимальный surface area
- telegram.css не создавался — Telegram-specific overrides пока не нужны, цвета задаются через `setHeaderColor`/`setBackgroundColor`

**Критерий готовности:** `platform.name === 'telegram'` в Telegram, `platform.name === 'standalone'` в браузере. ✅

---

### F1.2: API-клиент ✅

**Цель:** Типизированный HTTP-клиент для общения с бэкендом.

**Задачи:**

- [x] src/api/client.ts:
  - `BASE_URL` из `import.meta.env.VITE_API_BASE_URL`
  - Обёртка над fetch: `get<T>()`, `post<T>()`, `patch<T>()`, `delete()`
  - Авто-подстановка `Authorization: Bearer {token}` через модульный `_token` (не импорт из store — избежание циклических зависимостей)
  - Обработка 401 → callback `_onUnauthorized()` → auth store очищает сессию (FIX 10.2)
  - Обработка 422 → парсинг массива ValidationError → join в строку
  - Обработка 204 → `return undefined as T` (logout и другие no-content ответы)
  - Обработка сетевых ошибок → `ApiNetworkError`
- [x] src/api/types.ts — TypeScript-интерфейсы:
  - `TelegramAuthRequest`, `AuthResponse`
  - `UserResponse`, `UserUpdate`, `UserRole`
  - `PaginatedResponse<T>` (generic)
  - `ApiError` (string | ValidationError[])

**Экспорты client.ts:**

```typescript
// Error classes
export class ApiResponseError extends Error { status: number; detail: string }
export class ApiNetworkError extends Error {}

// Token management (decoupled from Pinia to avoid circular imports)
export function setAuthToken(token: string | null): void
export function getAuthToken(): string | null

// 401 callback registration (FIX 10.2)
export function setOnUnauthorized(cb: () => void): void

// HTTP methods
export const api = {
  get<T>(path: string): Promise<T>,
  post<T>(path: string, body?: unknown): Promise<T>,
  patch<T>(path: string, body?: unknown): Promise<T>,
  delete(path: string): Promise<void>,
}
```

**Решения, принятые при реализации:**

- **Типизация (актуально с CR-01):** бэкенд-типы НЕ пишутся вручную — они
  автогенерируются из OpenAPI в `src/api/generated.ts` (`generate_ts_types.py`,
  перегенерация при `velo update`, «DO NOT EDIT»). `src/api/types.ts` — единая точка
  импорта: реэкспортит всё из `generated.ts` плюс добавляет ТОЛЬКО фронт-онли типы
  (фильтры, UI-юнионы, `ApiError`). Потребители импортируют из `@/api/types`, не из
  `@/api/generated`. (Изначально F1.2 типизировал вручную; codegen введён позже
  как CR-01 — см. Фронтовый Кодекс FP-09 / §1.3.)
- Токен хранится в модульной переменной `_token` (не в Pinia) — исключает circular dependency `client → store → client`
- 401 обработка через callback `setOnUnauthorized()` — client не знает о store, store регистрирует `_clearSession` при инициализации (FIX 10.2)
- Ошибки нормализованы: backend возвращает `string` на 400/401/403/404/409 и `Array<ValidationError>` на 422 — `client.ts` всегда приводит `detail` к строке

**Критерий готовности:** `api.get<UserResponse>('/api/v1/users/me')` возвращает типизированный ответ. ✅

---

### F1.3: Auth flow (Telegram) ✅

**Цель:** Юзер открывает WebApp → автоматически авторизован.

**Задачи:**

- [x] src/stores/auth.ts (Pinia):
  - `user: UserResponse | null`
  - `token: string | null`
  - `loading: boolean`
  - `isAuthenticated: boolean` (computed: `!!token && !!user`)
  - `role: UserRole | null` (computed из `user.role ?? null`, QW-4: null для неавторизованных)
  - `loginViaTelegram(initData)` — POST /auth/telegram → set token + user
  - `restoreSession()` — sessionStorage → set token → GET /users/me → set user
  - `fetchMe()` — GET /users/me (обновление профиля)
  - `logout()` — POST /auth/logout + очистка store
  - Персистенция token в `sessionStorage` под ключом `velo_token`
  - Регистрация `_onUnauthorized` callback в API client (FIX 10.2)
- [x] src/composables/useAuth.ts — объединяет platform + auth store:
  - `initAuth()` — вызывается один раз из App.vue `onMounted`:
    1. `platform.init()`
    2. `authStore.restoreSession()` — если сохранённый токен валиден → готово
    3. `platform.getInitData()` → если есть → `authStore.loginViaTelegram(initData)`
    4. Если нет → `isStandalone = true`
  - Module-level refs `isReady`, `isStandalone` (singleton composable pattern)
  - `waitUntilReady()` — Promise.race(isReady watcher, 10s timeout) для router guards (BUG-role-redirect fix)
  - `resetAuthState()` — для тестов (FIX 10.4)
- [x] src/views/auth/LoadingView.vue — экран загрузки (VeloLogo + заголовок "VELO" + CSS spinner)
- [x] src/views/auth/StandaloneStubView.vue — "Для входа откройте приложение через Telegram-бот" + кнопка "Открыть в Telegram"
- [x] src/components/ui/VeloLogo.vue — SVG лого как shared компонент (FIX 10.8: DRY)
- [x] src/App.vue — auth-шлюз на уровне корневого компонента:
  - `!isReady` → LoadingView
  - `isStandalone || !isAuthenticated` → StandaloneStubView
  - иначе → `<RouterView />`
  - **(расширено в F11.2):** между авторизацией и RouterView добавлена машина состояний `stage: welcome|onboarding|app` (WelcomeView / OnboardingView вне роутера). См. Phase F11.2

**Решения, принятые при реализации:**

- Auth guard на уровне App.vue, а не router `beforeEach`: App.vue выступает внешним шлюзом. Router guards добавляются в F2.2 для ролевого доступа
- `role` computed возвращает `null` для неавторизованных (QW-4), не `'user'` — предотвращает false positives
- `sessionStorage` (не `localStorage`) для токена: Telegram WebApp закрывает вкладку при выходе → sessionStorage очищается автоматически
- StandaloneStubView: URL бота из `VITE_TELEGRAM_BOT_URL` env variable (FIX 10.3)
- VeloLogo.vue: SVG с CSS fallback `var(--velo-primary, #334D6E)` (QW-5)
- Google Fonts перенесены из `@import` в `<link>` в index.html (FIX 10.6) — устраняет FOIT

**Зависимость от бэкенда:** POST /api/v1/auth/telegram (Phase 1.2 ✅).

**Критерий готовности:** Открываем WebApp в Telegram → автоматический логин → видим user в DevTools. ✅

---

### F1: Аудит и исправления

| ID       | Описание                                                                                                                         | Файл                                | Статус |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ |
| FIX 10.1 | WebApp accessed lazily via getter, not at module level — prevents crash if CDN blocked                                           | `platform/telegram.ts`              | ✅     |
| FIX 10.2 | 401 handler delegates cleanup to auth store via `onUnauthorized` callback — no direct token/sessionStorage mutation in client.ts | `api/client.ts`, `stores/auth.ts`   | ✅     |
| FIX 10.3 | Bot URL from `VITE_TELEGRAM_BOT_URL` env variable, not hardcoded                                                                 | `views/auth/StandaloneStubView.vue` | ✅     |
| FIX 10.4 | `isReady`/`isStandalone` as module-level refs (singleton composable pattern), `resetAuthState()` exposed for tests               | `composables/useAuth.ts`            | ✅     |
| FIX 10.6 | Google Fonts via `<link>` in index.html instead of `@import` in CSS — eliminates FOIT                                            | `index.html`, `styles/global.css`   | ✅     |
| FIX 10.8 | VeloLogo extracted to shared component (was copy-pasted in 3 views)                                                              | `components/ui/VeloLogo.vue`        | ✅     |
| QW-4     | `role` computed returns `null` (not `'user'`) for unauthenticated users                                                          | `stores/auth.ts`                    | ✅     |
| QW-5     | CSS fallback `var(--velo-primary, #334D6E)` in VeloLogo SVG                                                                      | `components/ui/VeloLogo.vue`        | ✅     |

---

## PHASE F2: Компоненты + Layout ✅

### F2.1: UI-компоненты (дизайн-система) ✅

**Цель:** Библиотека переиспользуемых компонентов из мокапов.

**Задачи:**

- [x] Компоненты из мокапов (1:1 перенос визуала):

**Примитивы (src/components/ui/):**

| Компонент    | Пропсы                                                              | Описание                     |
| ------------ | ------------------------------------------------------------------- | ---------------------------- |
| VButton      | variant (primary/secondary/outline/danger), size, disabled, loading | Кнопка с состояниями         |
| VInput       | label, placeholder, error, type                                     | Текстовое поле               |
| VTextarea    | label, placeholder, error, rows                                     | Многострочное поле           |
| VSelect      | label, options, error                                               | Выпадающий список            |
| VCheckbox    | label, checked                                                      | Чекбокс                      |
| VCard        | — (slot)                                                            | Карточка-контейнер           |
| VBadge       | variant (success/warning/error/info), text                          | Статусный бейдж              |
| VAvatar      | name, url, size                                                     | Аватар (инициалы или фото)   |
| VLoader      | size                                                                | Спиннер загрузки             |
| VDivider     | —                                                                   | Горизонтальный разделитель   |
| VEmptyState  | icon, title, description                                            | Пустое состояние             |
| VToast       | — (composable)                                                      | Всплывающее уведомление      |
| VStatCard    | value, label, icon                                                  | Числовая карточка статистики |
| VProgressBar | value, max, color                                                   | Полоска прогресса            |
| VModal       | open, closeOnOverlay, showClose                                     | Модальное окно (F4.1)        |

**Layout-компоненты (src/components/layout/):**

| Компонент    | Описание                                        |
| ------------ | ----------------------------------------------- |
| VHeader      | Заголовок с кнопкой назад и действием справа    |
| VTabBar      | Нижняя навигация (конфигурируется через пропсы) |
| MobileLayout | Header + `<slot>` + TabBar (для user и master)  |
| AdminLayout  | Аналогичный, с другим TabBar                    |

**Критерий готовности:** Все компоненты рендерятся корректно, переиспользуются в view-файлах. ✅

---

### F2.2: Роутинг + Layout ✅

**Цель:** Навигация между экранами, role-based доступ.

**Задачи:**

- [x] src/router/index.ts — маршруты:

```
/                          → редирект на /user/dashboard (или /master/ или /admin/)
/loading                   → LoadingView (авторизация в процессе)

/user/dashboard            → UserDashboardView
/user/calendar             → CalendarView
/user/diary                → DiaryView (Phase F9)
/user/profile              → UserProfileView
/user/practices/:id        → PracticeDetailView
/user/bookings             → MyBookingsView
/user/topup                → TopupView
/user/topup/success        → TopupSuccessView
/user/topup/cancel         → TopupCancelView

/master/dashboard          → MasterDashboardView
/master/practices          → MasterPracticesView
/master/practices/new      → CreatePracticeView
/master/practices/:id      → EditPracticeView
/master/practices/:id/attendance → AttendanceView
/master/analytics          → AnalyticsView (Phase F9)
/master/profile            → MasterProfileView
/master/finance            → MasterFinanceView
/master/apply              → MasterApplyView (3 шага)
/master/pending            → MasterPendingView (ожидание верификации)

/admin/dashboard           → AdminDashboardView
/admin/masters             → AdminMastersView
/admin/masters/:id         → AdminMasterReviewView
/admin/reports             → AdminReportsView
/admin/reports/:id         → AdminReportDetailView
[REMOVED 2026-07-07 `9ca5619`] /admin/consistency → AdminConsistencyView

/404                       → NotFoundView
```

- [x] src/router/guards.ts:
  - `authGuard` — не авторизован → /loading
  - `roleGuard('master')` — role не master/admin → /user/dashboard
  - `roleGuard('admin')` — role не admin → /user/dashboard
  - `masterStatusGuard` — мастер не верифицирован → /master/pending

- [x] Tab bar конфигурация по ролям:

| Роль   | Таб 1      | Таб 2        | Таб 3        | Таб 4      |
| ------ | ---------- | ------------ | ------------ | ---------- |
| user   | 🏠 Дашборд | 📅 Календарь | 📔 Дневник   | 👤 Профиль |
| master | 📊 Дашборд | 📅 Практики  | 📈 Аналитика | 👤 Профиль |
| admin  | 📊 Дашборд | 👥 Мастера   | ⚠️ Модерация | —          |

**Зависимость от бэкенда:** GET /api/v1/users/me (role) — Phase 1.4 ✅.

**Критерий готовности:** После логина юзер видит layout с tab bar. Переходы между экранами работают. ✅

---

## PHASE F3: Каталог практик ✅

### F3.1: Список практик ✅

**Цель:** Юзер видит доступные практики.

**Задачи:**

- [x] src/stores/practices.ts (Pinia):
  - `practices: PracticeResponse[]`
  - `total: number`
  - `filters: { date_from, date_to, type, sort_by }`
  - `loading: boolean`
  - `fetchPractices()` — GET /api/v1/practices с фильтрами и пагинацией
- [x] src/api/practices.ts — типизированные методы API
- [x] src/components/shared/PracticeCard.vue:
  - Карточка практики (из мокапов): иконка типа, название, мастер, дата/время, цена, кол-во мест
  - Бейдж статуса (scheduled, live)
  - Клик → /user/practices/:id
- [x] src/views/user/DashboardView.vue:
  - Приветствие с именем
  - "Ближайшие практики" — горизонтальный скролл или список
  - "Все практики" → ссылка на календарь
- [x] src/views/user/CalendarView.vue:
  - Вид по дням (список, не сетка — проще для MVP)
  - Фильтры: тип практики, диапазон дат
  - Бесконечный скролл (или кнопка "Показать ещё")
- [x] src/composables/usePagination.ts — переиспользуемая пагинация

**Зависимость от бэкенда:** GET /api/v1/practices (Phase 4.3 ✅).

**Критерий готовности:** Юзер видит список практик, фильтрует по типу и дате. ✅

---

### F3.2: Детали практики ✅

**Цель:** Экран конкретной практики с полной информацией.

**Задачи:**

- [x] src/views/user/PracticeDetailView.vue:
  - Заголовок, описание, мастер (имя, аватар)
  - Дата, время, длительность, timezone
  - Тип практики
  - Цена (или "Бесплатно")
  - Кол-во мест (свободно / всего)
  - Кнопка "Записаться" (или "Вы записаны" / "Мест нет")
  - Ссылка на waitlist, если мест нет (Phase F4)
- [x] src/api/practices.ts — `getPractice(id)`: GET /api/v1/practices/:id

**Зависимость от бэкенда:** GET /api/v1/practices/:id (Phase 4.3 ✅).

**Критерий готовности:** Клик по карточке → полная информация о практике. ✅

---

## PHASE F4: Бронирование + Баланс ✅

### F4.1: Бронирование ✅

**Цель:** Юзер записывается на практику.

**Задачи:**

- [x] Кнопка "Записаться" на PracticeDetailView:
  - POST /api/v1/practices/:id/purchase
  - Обработка ошибок: недостаточно средств (→ предложить пополнить), полная, уже записан
  - Success toast: "Вы записаны!"
- [x] Кнопка "Отменить запись" (если записан):
  - POST /api/v1/bookings/:id/cancel
  - Confirm dialog перед отменой
- [x] src/views/user/MyBookingsView.vue:
  - Список бронирований (upcoming / past)
  - Карточка: практика, дата, статус, кнопка отмены
- [x] Waitlist flow: кнопка "Встать в очередь" / "Выйти из очереди"
- [x] src/components/shared/BookingPopup.vue, CancelBookingPopup.vue

**Зависимость от бэкенда:** bookings CRUD (Phase 5 ✅).

**Критерий готовности:** Юзер записывается и отменяет запись. ✅

---

### F4.2: Баланс ✅

**Цель:** Юзер видит свой баланс.

**Задачи:**

- [x] src/stores/balance.ts (Pinia):
  - `balance_cents: number`
  - `refresh()` — GET /api/v1/users/me → balance_cents
- [x] Баланс в UserDashboardView и TopupView
- [x] `formatMoney(cents, 'EUR', 'ru', true)` — форматирование суммы

**Зависимость от бэкенда:** GET /api/v1/users/me (Phase 1.4 ✅).

**Критерий готовности:** Баланс отображается и обновляется после пополнения. ✅

---

## PHASE F5: Пополнение (Stripe) ✅

### F5.1: Topup flow ✅

**Цель:** Юзер пополняет баланс через Stripe.

**Задачи:**

- [x] src/views/user/TopupView.vue:
  - Текущий баланс (из balanceStore)
  - Предустановленные суммы (€5, €10, €20, €50) — grid 2x2
  - Произвольная сумма — input с валидацией (€1–€500, из backend config)
  - Кнопка "Пополнить" → POST /api/v1/payments/topup → redirect на checkout_url
  - C-1 fix: whitelist валидация checkout_url перед redirect (Stripe + наш домен)
  - W-27 fix: `formatMoney` вместо локального `formatEur`
- [x] src/views/user/TopupSuccessView.vue:
  - "✅ Баланс пополнен!" + обновлённый баланс из API (refresh на mount)
  - Кнопки: "На главную" (dashboard) / "Пополнить ещё" (topup)
- [x] src/views/user/TopupCancelView.vue:
  - "😕 Оплата отменена" + кнопки: "Попробовать снова" / "На главную"
- [x] src/api/payments.ts:
  - `createTopup(amountCents)` → POST /api/v1/payments/topup
  - Types: `TopupRequest`, `TopupResponse`
- [x] Бэкенд stub mode (stripe.py):
  - `is_stripe_stub=True` → instant confirm: Payment(confirmed) + record_user_ledger + return success_url
  - Позволяет тестировать полный flow без Stripe ключей

**F5 Code Review фиксы (применены):**
| ID | Проблема | Фикс |
|----|----------|------|
| C-1 | Open redirect через checkout_url | Whitelist валидация: `checkout.stripe.com` + `VITE_API_BASE_URL` |
| W-27 | formatEur дублирует formatMoney | Заменён на formatMoney |

**Зависимость от бэкенда:** POST /api/v1/payments/topup (Phase 6.3 ✅). Stub mode добавлен в F5.

**Критерий готовности:** Юзер пополняет баланс (stub mode или Stripe), видит обновлённую сумму. ✅

---

## PHASE F6: Master — Управление практиками ✅

### F6.1: Заявка мастера ✅

**Цель:** Обычный юзер подаёт заявку на мастера.

**Задачи:**

- [x] src/views/master/MasterApplyView.vue — 3-шаговая форма (из мокапов):
  - Шаг 1: Профиль (имя, email, телефон)
  - Шаг 2: Опыт (направления, стаж, языки)
  - Шаг 3: Документы (placeholder — загрузка не в MVP)
  - Progress bar (3 шага)
  - POST /api/v1/masters/apply
- [x] src/views/master/MasterPendingView.vue:
  - "Заявка отправлена, ожидайте верификации"
  - Статус из GET /api/v1/masters/me
- [x] Router guard: `applyGuard` — верифицированный мастер → /master/dashboard

**Зависимость от бэкенда:** POST /api/v1/masters/apply, GET /api/v1/masters/me (Phase 2 ✅).

**Критерий готовности:** Юзер подаёт заявку, видит статус ожидания. ✅

---

### F6.2: Список и создание практик ✅

**Цель:** Мастер управляет своими практиками.

**Задачи:**

- [x] src/stores/master.ts (Pinia):
  - `practices: PracticeResponse[]`
  - `profile: MasterProfileResponse | null`
  - `fetchMyPractices()` — GET /api/v1/masters/me/practices
  - `refreshMyPractices()` — принудительный рефреш кэша
  - `fetchMyProfile(force?)` — GET /api/v1/masters/me, lazy по умолчанию
- [x] src/views/master/MasterPracticesView.vue:
  - Список практик мастера (upcoming / past)
  - Кнопка "Создать практику"
  - Карточка: название, дата, статус, участники
- [x] src/views/master/CreatePracticeView.vue:
  - Форма: title, description, type, datetime (date+time picker), duration, timezone, max_participants, price
  - POST /api/v1/practices
  - Валидация: дата в будущем, duration в пределах config
  - `eurStringToCents()` для конвертации суммы
- [x] src/views/master/EditPracticeView.vue:
  - PATCH /api/v1/practices/:id
  - State machine: кнопки доступных переходов (draft→scheduled, scheduled→live, live→completed)
  - Кнопка "Удалить" (только для draft)
  - Кнопка "Опубликовать" (draft → scheduled)
  - Кнопка "Отменить" (scheduled/live → POST /cancel + confirm dialog)
  - Кнопка "Завершить" (live → POST /finalize + confirm dialog)
  - double-submit guard через `anyLoading` computed
  - `eurStringToCents()` / `centsToEurString()` из `@/utils/currency`
- [x] src/utils/currency.ts — `eurStringToCents()`, `centsToEurString()` (W-6: safe integer math)
- [x] src/utils/commission.ts — `COMMISSION_RATE` константа
- [x] src/utils/practiceOptions.ts — `DURATION_OPTIONS`, `TIMEZONE_OPTIONS`

**Зависимость от бэкенда:** practices CRUD (Phase 4 ✅).

**Критерий готовности:** Мастер создаёт практику, публикует, видит в списке. ✅

> **Доступно с бэка (Бэковый Кодекс, эпик E3 серии, июнь 2026):** `CreatePracticeView`
> может создавать СЕРИЮ. При `practice_type="series"` в `POST /practices` шлётся
> `recurrence: RecurrenceSpec` (period daily|weekly|biweekly; days ISO 1=Пн..7=Вс,
> обязательны для weekly/biweekly; end never|until_date|after_count; `count` = ВСЕГО
> сессий ВКЛЮЧАЯ первую, потолок 40; для `until_date` дата должна давать >=1 сессию
> после первой, иначе бэк отдаёт 400 на публикации). Серийная карточка
> (`recurrence_days / total_sessions / completed_sessions` в `PracticeResponse`) уже
> читается структурно в `MasterPracticesView` — без правок. Остаётся вайринг секции
> повтора в форме. Типы — `generated.ts`. Контракт — Бэковый Кодекс §2 / §3.13.

---

### F6.3: Финализация + посещаемость ✅

**Цель:** Мастер завершает практику и видит посещаемость.

**Задачи:**

- [x] Кнопка "Завершить практику" на EditPracticeView (live → completed):
  - POST /api/v1/practices/:id/finalize
  - Подтверждение через inline confirm dialog (`<Teleport to="body">`)
- [x] Кнопка "Отменить практику" с full refund confirm dialog
- [x] src/views/master/AttendanceView.vue:
  - GET /api/v1/practices/:id/attendance
  - Список: имя, статус (attended / no_show / pending)
  - Агрегаты: всего, пришли, не пришли

> **Доступно с бэка (Бэковый Кодекс v1.7, 2026-06-02):** `AttendanceItemResponse`
> теперь также отдаёт `user_display_name`, `user_avatar_url` и PRE-чек-ин участника
> `checkin: { mood, comment } | null`. `AttendanceView` пока показывает только
> имя/статус/агрегаты — отображение аватара и чек-ина (mood+comment) можно добавить
> без правок бэка (поля уже в `generated.ts`). Это и есть «мастер видит запрос/чек-ин
> клиента». «Вопрос мастеру» (TD-ASK-MASTER) — отдельная фича диалогов, заглушка
> остаётся.

> **Доступно с бэка (эпик E3 серии, июнь 2026):** отмена практики приняла
> опциональное тело `CancelPracticeRequest { scope: "this" | "this_and_future" }`.
> Диалог отмены (`CancelPracticeDialog`) может предложить радио «Только эту / Эту и
> будущие»: `"this"` (дефолт, обратная совместимость) отменяет одну оккуренцию,
> `"this_and_future"` — эту плюс все позднейшие оккуренции серии (бэк делает refund по
> каждой). Остаётся вайринг радио. Контракт — Бэковый Кодекс §2 / §3.13.

**Зависимость от бэкенда:** finalize + attendance (Phase 5.4 ✅).

**Критерий готовности:** Мастер финализирует практику, видит кто пришёл. ✅

---

### F6: BUG-role-redirect — исправлено

**Проблема:** После изменения роли `user → master` при следующей навигации мастер мог видеть устаревший интерфейс. Также `roleRedirect` в guards читал `auth.role` до завершения `restoreSession()`.

**Три взаимосвязанных фикса:**

| ID  | Файл                     | Проблема                                                     | Фикс                                                                                                                |
| --- | ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| P-1 | `router/index.ts`        | Global `beforeEach` редиректил мастера с `/user/*` полностью | Только `/user/dashboard` и `/user` заблокированы — все остальные `/user/*` маршруты доступны мастеру (он тоже юзер) |
| P-2 | `router/guards.ts`       | `roleRedirect` читал `auth.role` синхронно до ready          | `roleRedirect` стал async, `await waitUntilReady()` перед чтением role                                              |
| P-3 | `composables/useAuth.ts` | Не было способа дождаться завершения auth инициализации      | Добавлен export `waitUntilReady()` — Promise.race(isReady watcher, 10s timeout)                                     |

**Также исправлены import-ошибки:**

- `VHeader` перенесён из `@/components/ui` в `@/components/layout` в: `AttendanceView`, `CreatePracticeView`, `EditPracticeView`, `MasterApplyView`

---

## PHASE F7: Master — Финансы ✅

### F7.1: Баланс мастера + выводы ✅

**Цель:** Мастер видит финансы и выводит средства.

**Задачи:**

- [x] src/api/types.ts — добавлены типы:
  - `PayoutDetails` (method, account_number / email / revolut_tag)
  - `MasterProfileResponse.payout: PayoutDetails | null`
  - `WithdrawalStatus` ('pending' | 'approved' | 'rejected')
  - `WithdrawalResponse` (id, amount_cents, fee_cents, status, payout_details, created_at)
  - `PaginatedWithdrawalsResponse`
- [x] src/api/masters.ts — добавлены методы:
  - `updatePayoutDetails(body: PayoutDetails)` → PATCH /me/payout
  - `createWithdrawal(amount_cents)` → POST /me/withdraw
  - `getMyWithdrawals(limit, offset)` → GET /me/withdrawals
- [x] src/views/master/MasterFinanceView.vue:
  - **Баланс:** `available_cents` (зелёный) + `frozen_cents` (серый, только если > 0) из `masterStore.profile`
  - **Форма вывода** (`v-show`): если `payout === null` — предупреждение + ссылка на `/master/profile`; иначе: input суммы в EUR, кнопка "Всё" (`fillMaxAmount`), hint с минимумом и комиссией, кнопка "Запросить вывод"
  - Double-submit guard через `submitting` ref
  - После успеха: `toast.success` + `masterStore.fetchMyProfile(true)` + `reloadHistory()`
  - **История выводов:** `getMyWithdrawals` при маунте, пагинация "Показать ещё" (offset += 20)
  - Каждый item: сумма, комиссия, итого мастеру, `VBadge` статуса, метод, дата
- [x] src/views/master/MasterProfileView.vue:
  - **Профиль:** `VAvatar` (xl) + display_name + `VBadge` (verified/pending) + bio + methods chips + стаж
  - **Реквизиты выплат:** если `payout === null` — "Не настроено" + кнопка "Добавить"; если настроено — метод + masked details + кнопка "Изменить"
  - Inline форма (`v-show`): `VSelect` метода + динамические поля (IBAN / email / tag); PATCH /me/payout → обновить `masterStore.profile.payout` in-place + toast.success
  - Валидация: IBAN не пустой, email содержит `@`, tag не пустой
  - Double-submit guard
  - **Finance link:** карточка → `/master/finance`
  - `onMounted`: guard — `if (authStore.role === 'master')` (pending мастера с role='user' не имеют /masters/me endpoint)

**Ключевые паттерны F7:**

- `eurStringToCents()` / `centsToEurString()` из `@/utils/currency` — везде вместо float-арифметики
- `formatMoney(cents, 'EUR', 'ru', true)` для всех денежных значений
- `MIN_WITHDRAWAL_EUROS = 50`, `WITHDRAWAL_FEE_EUROS = 2` — зеркалят backend config.py (см. TD-FE-W6)

**Зависимость от бэкенда:** withdrawals + payout (Phase 6.6 ✅).

**Критерий готовности:** Мастер видит баланс, настраивает выплаты, запрашивает вывод. ✅

---

### F7: Ревью и исправления

**Ревью F7 — выявлено 6 warnings, 7 suggestions.**

**Закрытые warnings (коммит `7141ebe`):**

| ID  | Серьёзность | Проблема                                                           | Фикс                                                        |
| --- | ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| W-1 | MEDIUM      | `parseFloat * 100` в `amountCents` — IEEE-754 float precision trap | `eurStringToCents(amountInput.value)` из `@/utils/currency` |
| W-2 | LOW         | `fillMaxAmount` делил на 100 вместо `centsToEurString()`           | `centsToEurString(availableCents.value)`                    |
| W-3 | LOW         | Хинт "Вы получите" показывал €0,00 при невалидной сумме            | `v-if="amountCents > 0"` на хинте                           |

**Открытые warnings (LOW, tech debt):**

| ID  | Серьёзность | Описание                                                                                           | Файл                          |
| --- | ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| W-4 | LOW         | `v-show` на форме payout — все элементы всегда в DOM                                               | `MasterProfileView.vue`       |
| W-5 | LOW         | Backend `payout_details` типизирован как `dict`, а не `PayoutDetailsResponse`                      | `masters/models.py` (backend) |
| W-6 | LOW         | Хардкод `MIN_WITHDRAWAL_EUROS=50` / `WITHDRAWAL_FEE_EUROS=2` — рассинхрон с бэкендом при изменении | `MasterFinanceView.vue`       |

**Открытые suggestions (7 штук, LOW):** задокументированы в review-отчёте, перенесены в tech debt как TD-FE-F7-SUGGESTIONS.

---

## PHASE F8: Admin ✅

### F8.1: Дашборд + статистика ✅

**Цель:** Админ видит ключевые метрики.

**Задачи:**

- [x] src/views/admin/AdminDashboardView.vue:
  - GET /api/v1/admin/stats
  - Карточки: users_count, masters_count, practices_count, pending_verifications
  - VStatCard с иконками, алертовый баннер если pending_verifications > 0
  - Навигационные ссылки-кнопки в кол-во мастеров → /admin/masters, в жалобы → /admin/reports

**Зависимость от бэкенда:** GET /api/v1/admin/stats (Phase 3.1 ✅).

**Критерий готовности:** Админ видит статистику. ✅

---

### F8.2: Верификация мастеров ✅

**Цель:** Админ верифицирует или отклоняет заявки.

**Задачи:**

- [x] src/views/admin/AdminMastersView.vue:
  - Список мастеров с фильтром по статусу (pending/all) — GET /api/v1/admin/masters/pending + /list
  - Карточки: имя, методы, стаж, дата заявки, VBadge статуса
  - `error` ref + VEmptyState с кнопкой "Повторить" при ошибке загрузки (S-4)
  - Клик → /admin/masters/:id
- [x] src/views/admin/AdminMasterReviewView.vue:
  - GET /api/v1/admin/masters/:id — полная информация о заявке (W-1: новый эндпоинт)
  - Профиль мастера: имя, email, bio, методы, стаж, языки, статус
  - Кнопка "Верифицировать" → POST /api/v1/admin/masters/:id/verify
  - Кнопка "Отклонить" → POST /api/v1/admin/masters/:id/reject (с полем причины)
  - Double-submit guard на обеих кнопках
  - Toast: "Мастер верифицирован" / "Заявка отклонена"
  - После действия: `router.push({ name: 'admin-masters' })` — список перезагружается (S-1/S-2)

**Зависимость от бэкенда:** admin masters endpoints (Phase 2.3 ✅) + GET /admin/masters/{id} (W-1 добавлен в Phase 3.2 ✅).

**Критерий готовности:** Админ верифицирует и отклоняет заявки. ✅

---

### F8.3: Модерация + Семафоры ✅ — Семафоры REMOVED 2026-07-07 `9ca5619`

**Цель (как построено):** Обработка жалоб и мониторинг целостности данных.

**Модерация (жалобы) — ещё живое, не проверялось в этот проход:**

- [x] src/views/admin/AdminReportsView.vue:
  - Список жалоб — GET /api/v1/admin/reports?status=pending
  - Фильтр по статусу и типу (pending/resolved/dismissed × user/master/practice)
  - VBadge для статуса, generation counter (W-3: сколько раз список обновлён)
  - Клик → /admin/reports/:id
- [x] src/views/admin/AdminReportDetailView.vue:
  - GET /api/v1/admin/reports/:id — полная информация о жалобе (W-2: новый эндпоинт)
  - reporter, target_type, target_id, reason, status, timestamps
  - Кнопки: resolve (с полем resolution_note) / dismiss
  - Double-submit guard
  - Toast: "Жалоба обработана" / "Жалоба отклонена"
  - После действия: `router.push({ name: 'admin-reports' })` — список перезагружается (S-1/S-2)

**Семафоры (мониторинг целостности) — построено, затем удалено целиком 2026-07-07 `9ca5619`
("remove data-integrity semaphores feature entirely"). Ниже — историческая запись, не текущее
поведение:**

- [x] ~~src/views/admin/AdminConsistencyView.vue~~ **[DELETED]**:
  - GET /api/v1/admin/consistency **[REMOVED]**
  - Список из 21 семафора: имя, статус (OK/ALERT), категория, criticality
  - Цветовая индикация: зелёный/красный VBadge
  - ok_count / alert_count / total + время запроса
  - Кнопка "↺ Перезапустить" — отдельный `rerunning` ref (S-3): спиннер на кнопке, результаты остаются видимыми
  - `loading` ref — только для первоначальной загрузки

**Зависимость от бэкенда:** reports (Phase 3.3 ✅) + GET /admin/reports/{id} (W-2 добавлен в
Phase 3.3 ✅). Consistency/Phase 6.8 dependency no longer applies — feature removed.

**Критерий готовности:** Админ обрабатывает жалобы. ✅ (Семафоры — критерий более не
применим, экран удалён.)

---

### F8: Code Review — итог

**Выявлено: 0 critical, 6 warnings, 6 suggestions.**

**Warnings (все закрыты, коммиты 30a0e2f, 749c9aa):**

| ID  | Серьёзность | Проблема                                                                               | Фикс                                                                |
| --- | ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| W-1 | MEDIUM      | Нет GET /admin/masters/{id} — `AdminMasterReviewView` делал GET /list и искал локально | Новый эндпоинт на бэке + `getMasterById()` в api/admin.ts           |
| W-2 | MEDIUM      | Нет GET /admin/reports/{id} — детали показывались из router state                      | Новый эндпоинт на бэке + `getReportById()` в api/admin.ts + VLoader |
| W-3 | LOW         | `AdminReportsView` не имел счётчика обновлений — неясно, когда список актуален         | `generation` ref, инкремент при каждом fetch                        |
| W-4 | LOW         | Семантические CSS-переменные отсутствовали — статусы хардкожены                        | Добавлены `--color-status-*` в `variables.css`                      |
| W-5 | LOW         | `adminHelpers.ts` не существовал — хелперы копировались в каждый файл                  | `utils/adminHelpers.ts` с общими функциями форматирования           |
| W-6 | LOW         | Double-submit guard проверялся ПОСЛЕ валидации — одиночный submit мог проскочить       | Guard перенесён ДО валидации                                        |

**Suggestions:**

| ID  | Статус    | Что сделано                                                                                                    |
| --- | --------- | -------------------------------------------------------------------------------------------------------------- |
| S-1 | ✅ CLOSED | `router.back()` → `router.push({ name: 'admin-masters' })` после verify/reject — список всегда перезагружается |
| S-2 | ✅ CLOSED | `router.back()` → `router.push({ name: 'admin-reports' })` после resolve/dismiss                               |
| S-3 | ✅ CLOSED (moot) | Отдельный `rerunning` ref в `AdminConsistencyView` — кнопка крутится, результаты видны (view deleted 2026-07-07 `9ca5619`) |
| S-4 | ✅ CLOSED | `error` ref + `VEmptyState` с кнопкой "Повторить" в `AdminMastersView`                                         |
| S-5 | ✅ CLOSED | Admin-типы перенесены в `api/types.ts`, re-export из `api/admin.ts` для обратной совместимости                 |
| S-6 | ➡️ TD     | Clickable divs без `role="button"`, `tabindex`, keyboard handlers → TD-FE-A11Y                                 |

**Финальный счёт F8:** 0 critical, 0 warnings, 5/6 suggestions closed.

---

## PHASE F9: Diary / Check-in / Feedback

### F9.1: Check-in + Feedback

**Цель:** Юзер отмечает состояние перед практикой и оставляет отзыв после.

**Задачи:**

- [ ] Check-in экран (перед практикой):
  - Выбор настроения: low / mid / high (emoji-кнопки из мокапов)
  - Опциональный комментарий
  - POST /api/v1/practices/:id/checkin
- [ ] Feedback экран (после практики):
  - Оценка: 🔥 Огонь / 👍 Хорошо / ❓ Есть вопросы
  - Опциональный комментарий
  - POST /api/v1/practices/:id/feedback
- [ ] Интеграция в booking flow:
  - Перед практикой (за N часов): баннер "Как вы себя чувствуете?"
  - После практики: баннер "Как прошла практика?"

**Зависимость от бэкенда:** Phase 8 бэкенда (Phase 8.4 ✅ — **разблокировано**).

---

### F9.2: Дневник

> **⚠️ Замещено PHASE F12 (Diary redesign).** Вкладочный `DiaryView` ниже —
> исходный план; он реализован, затем переделан в единую ленту-нить
> `DiaryFeedView` (см. PHASE F12). Раздел сохранён как история.

**Цель (исходная):** Личные записи юзера.

**Задачи (исходные, заменены F12):**

- [x] ~~src/views/user/DiaryView.vue~~ → удалён, заменён `DiaryFeedView`:
  - ~~Вкладки: Все / Check-ins / Feedbacks / Записи~~
  - CRUD записей дневника (сохранён, теперь рефрешит ленту)
  - ~~GET /api/v1/diary~~ → `GET /api/v1/diary/feed` (cursor)

**Зависимость от бэкенда:** Phase 8 бэкенда (Phase 8.4 ✅ — **разблокировано**).

---

### F9.3: Insights для мастера

**Цель:** Мастер видит агрегированную обратную связь.

**Задачи:**

- [ ] src/views/master/AnalyticsView.vue:
  - GET /api/v1/practices/:id/insights
  - Распределение check-ins (high/mid/low) — прогресс-бары
  - Распределение feedbacks (fire/good/confused) — прогресс-бары
  - Количество комментариев

**Зависимость от бэкенда:** Phase 8.4 бэкенда ✅ — **разблокировано**.

---

## PHASE F10: PWA + Standalone + Полировка

### F10.1: Standalone-авторизация

**Цель:** Вход без Telegram (для PWA на Home Screen).

**Задачи:**

- [ ] src/views/auth/LoginView.vue:
  - Email + magic link (или email + пароль — решить с заказчиком)
  - Или: "Войти через Telegram" → deep link в Telegram бот
- [ ] Бэкенд: **новый эндпоинт** — POST /api/v1/auth/email (или /auth/magic-link)
- [ ] platform/standalone.ts — полноценная реализация вместо заглушек

**Зависимость от бэкенда:** **НОВЫЙ ЭНДПОИНТ — нужна реализация на бэкенде.**

---

### F10.2: Push-уведомления

**Цель:** Уведомления через Service Worker.

**Задачи:**

- [ ] Service Worker: обработка push events
- [ ] Запрос разрешения на push
- [ ] Регистрация подписки на бэкенде
- [ ] Бэкенд: Web Push channel в notification formatters

**Зависимость от бэкенда:** Phase 7.3 (Telegram-бот, Web Push channel) — **частично готов.**

---

### F10.3: Полировка

**Цель:** UX-улучшения для production-ready состояния.

**Задачи:**

- [ ] Skeleton-загрузки (вместо спиннеров)
- [ ] Анимации переходов (Vue `<Transition>`)
- [ ] Pull-to-refresh
- [ ] Тёмная тема (CSS-переменные уже позволяют, нужен toggle)
- [ ] Haptic feedback в Telegram (на кнопках, на успешных действиях)
- [ ] Error boundary (глобальная обработка ошибок Vue)
- [ ] Offline-заглушка ("Нет подключения" с кнопкой "Повторить")

**Критерий готовности:** Приложение ощущается как нативное на iPhone.

---

## PHASE F11: TabBar redesign + Welcome + Onboarding ✅

### F11.1: TabBar redesign (Figma) ✅

**Цель:** Привести нижнюю навигацию к макету Figma (node 541:6649).

**Задачи:**

- [x] `components/layout/VTabBar.vue` — круглые стеклянные "пузыри" 63x63, gap 25, прозрачный контейнер. Inactive: `--velo-glass-blue-15` + белая рамка 1.26px + `backdrop-blur(2.52px)`. Active: пузырь растворяется (прозрачный фон/рамка, без blur) + `box-shadow: var(--velo-shadow-glow)`. Различие активной ТОЛЬКО свечением, не размером
- [x] Подписи убраны (aria-label сохранён для a11y). Поле `badge` в `TabItem` оставлено, не рендерится
- [x] 4 иконки 27x27 (`fill="currentColor"`): IconHome, IconCalendar (reservations), IconDiary, IconProfile
- [x] Применён для всех 3 ролей (общий компонент). Master/admin сохраняют свои иконки в новых круглых контейнерах

**Не тронуто:** router/tabs.ts, variables.css, MobileLayout/AdminLayout.

**Критерий готовности:** Таб-бар 1:1 с Figma. ✅

---

### F11.2: Welcome + Onboarding flow ✅

**Цель:** Экран приветствия + онбординг для новых юзеров (Figma node 541:1179).

**Scope (Telegram MVP):** экраны 01 (Welcome) + 05-08 (карусель: 3 интро + таймзона).
Экраны 02_Login / 03_Register / 04_OAuth ПРОПУЩЕНЫ (Telegram авто-авторизует через
initData; они для standalone/F10).

**Задачи:**

- [x] `api/users.ts` (новый) — `getMe()`, `updateMe(body)` обёртки над `/api/v1/users/me`
- [x] `stores/auth.ts` — refactor: `restoreSession`/`fetchMe` через `getMe()`; добавлен `updateProfile(body)` (через `updateMe` + `_setUser`, бросает ошибку наверх)
- [x] `views/auth/WelcomeView.vue` (экран 01) — лого VELΘ + слоган + "Войти" (`@enter`). "Создать аккаунт" скрыта в Telegram (`v-if="isStandalone"`), видна только в браузере (F10)
- [x] `views/auth/OnboardingView.vue` (экраны 05-08) — карусель: 3 интро-слайда + шаг таймзоны (VSelect из TIMEZONE_OPTIONS, дефолт — автодетект `Intl`, фоллбэк `Europe/Moscow`). "Пропустить" -> сразу к таймзоне. "Готово" -> `updateProfile({ timezone, onboarding_completed: true })` -> `@done`
- [x] `App.vue` — машина состояний `stage: welcome|onboarding|app` (вне роутера, как Loading/Stub)
- [x] Иллюстрации: `public/onboarding/onboarding-{practice,diary,masters}.svg` (фон+иконка; текст — живой HTML)

**Бэкенд (онбординг-флаг):** `onboarding_completed` в `credentials` JSONB (schema-on-read,
без миграции). UserResponse отдаёт computed bool, UserUpdate принимает, upsert мерджит
credentials на релогине. См. Технический Кодекс Backend 3.7 + Tech-Spec Phase 1.2/1.4.

**Решения:**

- Welcome показывается ВСЕМ при каждом открытии (продуктовое решение). `stage` в памяти компонента, не в роутере
- Новый юзер (`onboarding_completed === false`) после "Войти" -> карусель; вернувшийся -> сразу app
- Один эмит `@done` (и "Готово", и "Пропустить" сохраняют флаг внутри OnboardingView)
- Защита от двойного клика на "Далее" (флаги `advancing` + `finishArmed`): быстрый второй клик не пропускает шаг таймзоны. `advancing` освобождается в `try/finally`
- Типы `onboarding_completed` приходят из регенерации `generated.ts` (не пишутся руками)

**Code review:** 2 раунда. Исправлено: двойной клик (CRITICAL), null-сброс флага,
COALESCE в merge, +5 бэкенд-тестов на инвариант релогина, try/finally на `advancing`.

**Критерий готовности:** Новый юзер видит Welcome -> онбординг -> подтверждает таймзону ->
попадает в приложение; флаг переживает релогин. ✅

---

## PHASE F12: Diary redesign — единая лента-нить ✅

**Цель:** Заменить вкладочный `DiaryView` (Все / Check-ins / Feedbacks /
Записи) единой лентой активности, отрисованной как «нить» (Figma экран 40):
карточки на центральной оси с альтернированием, дата-узлы, нижний композер.

**Задачи:**

- [x] Слой данных (1b-1): `api/types.ts` (+реэкспорт `DiaryFeedItem`/`DiaryFeedResponse`, UI-типы `DiaryEventKind`/`DiaryFeedCategory`/`DiaryFeedFilters`), `api/diary.ts` (`listDiaryFeed` — cursor+категории+дата+поиск), `composables/useCursorPagination.ts` (NEW), переписан `stores/diary.ts` (курсорная лента + фильтры; сохранены submit/CRUD/insights; удалены 3 offset-списка)
- [x] Компоненты (1b-2): `components/shared/DiaryFeedCard.vue` (3 формы: banner/practice/standard), `DiaryComposer.vue` (нижний pill, создаёт note), `DiaryTimeline.vue` (нить с альтернированием), `views/user/DiaryFeedView.vue` (шапка + нить + infinite scroll + композер); новые иконки (IconPen/IconDreamBook/IconDots/IconMic/IconSend/IconDateLeaf)
- [x] `router/index.ts` — `user-diary` → `DiaryFeedView`
- [x] Удалены старый `DiaryView.vue` + 5 sub-компонентов (DiaryList/DiaryCheckinDetail/DiaryFeedbackDetail/DiaryEntryDetail/DiaryEntryForm)
- [x] `components/layout/MobileLayout.vue` — режим `fill` (чат-раскладка: скроллится только лента, композер фиксирован над таб-баром); `UserShell.vue` включает fill по роуту дневника
- [x] `vite.config.ts` — PWA build fix (runtimeCaching, убран `manifest:false`)

**Ключевые решения:**

- Вид дневника = **только нить** (экран 40); list (41) и переключатель — отложены (TD-DIARY-LIST-VIEW).
- Пагинация = **infinite scroll** (IntersectionObserver), курсорная (отступление от проектной кнопки «Показать ещё» — для чат-ленты читается естественнее).
- Нить = **Уровень 2 упрощённый**: banner/practice по центру оси, standard чередуются L/R сквозным счётчиком со сбросом каждый день; дата-узлы по календарным дням в tz юзера; коннекторы — CSS-штрихи (не Figma-кривые).
- Тап = **Вариант A**: note/dream → toast «Функция временно недоступна», остальное no-op; композер создаёт note (TD-DIARY-TAP-VARIANT-B).
- Аватар мастера в practice-карточке убран (бэк не кладёт в snapshot — TD-DIARY-PRACTICE-AVATAR).

**Зависимость от бэкенда:** Phase 8.5 (журнал + `/diary/feed`) ✅.

**Открытый фронт-техдолг:** TD-DIARY-PRACTICE-AVATAR, TD-DIARY-TAP-VARIANT-B,
TD-DIARY-LIST-VIEW, TD-DIARY-FILTER-SEARCH, TD-DIARY-ORNAMENT (см. Фронтовый
Кодекс).

**Критерий готовности:** Лента-нить рендерится, заметки создаются из
композера, композер зафиксирован над таб-баром, сборка зелёная. ✅

---

## PHASE F13: Мастер-программа (DS онбординг/заявка/вердикт + parked auth + apply-preview) ✅

**Цель:** Достроить путь «стать мастером → онбординг» на дизайн-систему (операторские SVG),
+ припаркованные Phase A web-auth экраны, + TEST-only инструменты прогона на тест-сервере.
DS-first, honest-stub (контрол без бэка = тост «недоступно» + запись для Zod, не фейк).

**Задачи:**

- [x] `views/master/MasterOnboardingView.vue` — пост-апрув карусель (overlay на дашборде через `Teleport`); гейт `utils/masterOnboarding.ts` + per-session `master.onboardingShownThisSession`; флаг `master_onboarding_completed` = Zod **E15** (defensive-read, до E15 не персистится → пере-показ на новой сессии)
- [x] `views/master/MasterApplyView.vue` — рестайл заявки в 3 шага (Профиль/Опыт/Документы); honest-стабы загрузки файлов (**E13**) и языка практик (**E16**)
- [x] `views/master/MasterPendingView.vue` — вердикт-экраны отправлена/одобрено/отказ (generic-причина до **E14**)
- [x] `components/ui/VPaginationDots.vue` — DS-точки (13×13/7×7), ретрофит обеих каруселей; токены `--text-28`/`--text-46`; `VeloLogo` вариант `lockup`
- [x] TEST-only повтор онбординга на role-switch — `ui.forceOnboarding` + хук в `RoleSwitchSection` + `App.vue` watch (user) / dashboard overlay (master)
- [x] Phase A parked web-auth — `views/auth/{LandingView,LoginView,RecoverPasswordRequestView,RecoverPasswordSetView}.vue` + спящие `/auth/*` маршруты (= Zod **E17**)
- [x] TEST-only 5-экранное превью заявки (`ffca7a0`) — `ui.previewApplyFlow`: `RoleSwitchSection` → Landing → MasterApply 1/2/3 → MasterPending «отправлено», без реального POST/маркера; гарды и `MasterPending` пропускают/форсят по сигналу; `beforeEach` чистит сигнал при уходе из флоу
- [x] Фикс клиент-валидации условий окончания серии в `CreatePracticeView` (until_date/after_count/weekday) — аддендум к F6

**Ключевые решения:**

- Все TEST-only инструменты (role-switch, повтор онбординга, превью заявки) — **прод-недостижимы**: единственная точка входа `RoleSwitchSection` рендерится лишь при непустом `allowedRoles` (= `ROLE_SWITCH_ENABLED` на TEST). Сигналы session-only, не персистятся. *(Историческая заметка F13; с v2.4/F16 `allowedRoles` выводится из capability и флага нет; №260 Batch-STRIP удалил replay/превью из кода целиком, свитч остался прод-фичей «Переключение роли».)*
- Phase A экраны — **из DS, не из растра**; недостижимы в Telegram (`App.vue` → StandaloneStubView для браузера, role-redirect не ведёт на `/auth/*`).
- Honest-stub: каждый контрол без бэка — тост «недоступно» + запись для Zod (E13–E17), без фейк-данных.

**Зависимость от бэкенда (Zod):** E7 период-статы мастера (`GET /masters/me/stats`) — доставлено, подключено в дашборде. E8 уведомления — контракт+capability-gate частично (лента/push-воркер открыты → `MasterNotificationsView` = стаб). Открытые: E13 (файлы заявки), E14 (причина отказа), E15 (флаг онбординга), E16 (языки заявки), E17 (web-auth).

**Открытый фронт-техдолг:** TD-FE-E13…E17 (Фронтовый Кодекс §10).

**Критерий готовности:** Мастер-программа построена, DS-first, honest-stub, задеплоена на TEST (`00bb5f2`); TEST-инструменты прод-недостижимы. ✅

---

## PHASE F14: Мастер-зона polish + клавиатура-aware viewport + User «Сообщения» ✅

**Цель:** Полировка мастер-зоны по операторским SVG + системный клавиатура-aware viewport + точка входа в обмен сообщениями для USER (honest-stub). DS-first, honest-stub, батч ahead-22 над `00bb5f2` (push held).

**Задачи:**

- [x] **Клавиатура-aware viewport** (`e95e05a`) — `useBackgroundStabilizer` публикует высоту visual-viewport в `--velo-vvh` + тогглит `html.is-keyboard-open`; гейтнутые правила `global.css` ужимают `.mobile-layout__main` + `.v-modal__*` до видимой области ТОЛЬКО при открытой клавиатуре (at-rest байт-идентично). Плюс прежний «танцующий фон» — `#app::before` translateY(`--velo-bg-shift`).
- [x] **Аналитика рестайл (AN-1…7)** — `AnalyticsView`/`PracticeReviewsView`: бейджи на всю ширину; «Требуют внимания» = крупная иконка-идентификатор + название; «Отзывы» = иконка-рейтинг слева без даты/подписи; **`VRatingBadges` — механизм «?»-подсказки удалён целиком**.
- [x] **Мастер-туман (FOG-1/FOG-2)** — `MasterShell`: `master-edit-profile`+`master-language-timezone` в `FOG_ROUTES`; `master-practice-detail` = собственный `practiceDetailFog` (компактный низ, юзер не тронут).
- [x] **Дашборд паритет (DB-1/DB-2)** — `MasterDashboardView` карточка «Ближайшие практики» = мета как в списке (чек-ины/регулярность/осталось) через НОВЫЙ `utils/practiceCardMeta` (вынесен из `MasterPracticesView`); верхний отступ.
- [x] **Профиль (PR-1/PR-2)** — верхний отступ; `@focus`-скролл textarea «О себе».
- [x] **User «Сообщения»** (`0b8ef14`) — Профиль ▸ «Аккаунт» строка «Сообщения» → `UserMessagesView` (`user-messages`), honest `VEmptyState` (без фейк-тредов; swap-точка под реальный список). Бэк-гэп — **E4**.
- [x] **Косметика батча** — туман 3 форм (promocode/create/edit), редизайн `UseTemplateBlock` + recurrence-UX (NP), рестайл «Практики/Прошедшие» (CP/EP/PD/PP), `todayLocalISO()` UTC-фикс (`utils/format`).

**Honest-stub:** User «Сообщения» = пустое состояние (нет messaging-бэка, E4), без фейк-данных. Мастер-вью messaging (`MasterMessagesView`/`MasterChatView`) сохраняют прежний фейк-стаб как deferred-cleanup (конвертация при появлении API).

**Зависимость от бэкенда (Zod):** E4 messaging (список/тред/отправка/непрочитанные) — открыт; E12 checkin-count индикатор — открыт (числа из insights). AN-8 (период дохода) — отложен до device-дискриминатора, не заведён.

**Критерий готовности:** Батч построен DS-first + honest-stub, vue-tsc+vite+Vitest зелёные, push held над `00bb5f2`; device-verify-pending. ✅

---

## PHASE F15: Клавиатура/туман polish + чат fill-режим + focus-freeze фона ✅

**Цель:** Довести поведение клавиатуры/тумана/фона по операторскому device-фидбэку на живых мастер/юзер-экранах. DS-first, frontend-only (+ бэк-запись E19). ДВЕ задеплоенные мили на TEST (`67b95ef` → `583e765`).

**Задачи — миля `67b95ef`:**

- [x] **Live-aware «Ближайшие практики»** (`utils/nearestBookings.ts`, `6fe0272`) — юзер-дашборд показывает идущую практику (latest-started) + до 2 предстоящих (`[inProgress?, ...upcoming].cap`), не единственный слот; per-card поведение (Zoom/чек-ин/live-badge) сохранено.
- [x] **KB#4-композит «танцующего фона»** (`bb475a2`) — при открытой клавиатуре: freeze `#app::before` (`transform:none`), снятие fog-маски скролла (`убрать туман при вводе`), reset stale keyboard-состояния синхронно на смене роута (`resetKeyboardViewportState` через `router.afterEach`).
- [x] **№233 формы** (`32fbd0e`/`00ad635`) — компактный нижний туман форм мастера (create/edit/promocode) через `--velo-fog-list-z3/z4`; full-width `UseTemplateBlock` + всегда-видимый тонкий скролл-thumb (webview-proof, без резерв-гаттера).
- [x] **Фронт-провязка E18/E14/E1/E10** — Zoom-кнопка открывает реальный `zoom_link` через `platform.openLink` (`f32ef0a`/`e056a60`), причина отказа мастеру (`4ad1b95`), навигация отзыв→профиль ученика на `PracticeReviewsView`+`AnalyticsView` (`576ef3c`/`f7b0794`), промокоды list/deactivate (`25e4cba`). Бэк-схемы = authorized backend-exception, 0-drift `generated.ts`.

**Задачи — миля `583e765`:**

- [x] **Верхний зазор мастер-профиля (PE-1)** — `MasterProfileView` headerless → `masterProfileFog()` в `MasterShell` подаёт отрицательный top-gap (токен `--velo-fog-mp-top-gap`) через существующий per-screen fog-API; `MobileLayout`/`HEADER_FALLBACK` НЕ тронуты (системный no-header-режим — parked).
- [x] **edit-profile (PE-2/PE-4)** — паритет-туман: `user-edit-profile` добавлен в `UserShell` `FOG_ROUTES` (стандартный туман, БЕЗ белой плашки); `scrollFieldIntoView` переведён на visualViewport-resize (координируется с `is-keyboard-open`, не пишет его shared-state); авто-скролл поля «УДАЛИТЬ» в модалке удаления при появлении.
- [x] **«Методы» edit-profile (PE-3)** — честный locked flat-chip показ + «через поддержку». Полная таксономия Направление→Вид + change-request + admin-approval + «Ожидает подтверждения» = бэк **E19**, НЕ построена (no-fake).
- [x] **PC-1 / SP-1 keyboard-scroll** — тот же visualViewport-скролл на поле «Лимит использований» промокода и textarea «Сообщение» поддержки (у поддержки `@focus`-хендлера не было вовсе).
- [x] **SP-2 Support ре-туман** — `master-support` возвращён в `FOG_ROUTES` + `CTA_SAFE_FOG_ROUTES` (как finance); реверс un-fog #8/#9, безопасен: маска снимается при вводе, CTA-safe низ держит «Отправить» чётким.
- [x] **MC-2 чат fill-режим** — `MasterShell` `isFillRoute = route.name==='master-chat'` + `:fill` (per-route opt-in как дневник в `UserShell`, прочие мастер-роуты байт-идентичны); `MasterChatView` пересобран в 3-слойный layout дневника (internal-scroll тред с собственной верх/низ маской + приклеенный композер). Шелл-туман MC-1 снят как мёртвый (fill даёт `mask:none`).
- [x] **SP-3 focus-freeze фона** — `useBackgroundStabilizer` тогглит `html.is-field-focused` на `focusin`/`focusout` текстовых полей; `global.css` морозит `#app::before` на этом классе — ДО того как клавиатура-анимация пересечёт 150px-порог `is-keyboard-open` (иначе фото «сползает» в окне анимации). Только freeze фона; max-height-кап + снятие маски остаются на 150px-пороге (без преждевременного reflow). Действует на ВСЕ экраны с клавиатурой.
- [x] **AN-1** — рейтинг-% центрирован внутри каждой пилюли прошедших практик аналитики (`justify-content:center`, scoped).

**Honest-stub:** «Методы» edit-profile = честный locked-показ (E19); чат — hardcoded стаб-тред, отправка = no-op-toast (E4). Без фейк-данных.

**Зависимость от бэкенда (Zod):** **E19** methods change-request workflow (таксономия + запрос + подтверждение + pending) — НОВЫЙ, открыт (спека = операторский мокап). E4 messaging — открыт.

**Критерий готовности:** Всё DS-first, vue-tsc+vite+Vitest зелёные; обе мили ЗАДЕПЛОЕНЫ на TEST (`67b95ef`→`583e765`), PROD `af30397` цел; device-verify (клавиатура/фон smoothness) — операторская петля. ✅

---

## PHASE F16: Роли и онбординг — capability-свитч, E15, честный вход, инвайт-ссылка ✅ (held)

**Цель:** Закрыть roadmap ролей/онбординга (Batch-USERS + Batch-INVITE, PROMPT №255-258): безопасность роль-свитча без тест-флага, персист мастер-онбординга, честный вход мастера без профиля, одноразовое приглашение мастера по ссылке. База `d01f6f9` (Zod: zoom-гейт Z-7 + `velo setrole`), батч ahead-10 до `77ad43a`, **HELD — не задеплоено** (accumulate-then-deploy).

**Задачи:**

- [x] **Capability-роль-свитч (A1=Б, №256)** — `switch_user_role` + блок `role_switch` в `GET /me` питаются ОДНОЙ функцией `derive_allowed_roles(role, master_capability, admin_home)` (users/schemas.py): `{USER}` всегда · +`MASTER` при верифицированном `MasterProfile` · админ — все три. ADMIN-NEVER-TARGET: не-админ никогда не свитчится в admin (только `velo setrole`). Round-trip админа — server-side маркер `credentials.role_switch.home_role` (ставится при уходе, чистится при возврате; НЕ PATCHable). Матрица покрыта `test_role_switch.py` (17 тестов).
- [x] **`ROLE_SWITCH_ENABLED` удалён (F1=А, `15d5b0d`)** — config-поле, router-404-гейт, W-4 warning + его тест-файл; seeded `allowed_roles` мертвы (регресс-тест). TEST `.env` строка инертна под Docker, но fatal на bare-metal — удаляется при деплое (см. §3 opnote / №264). Роль-лок 2-актёрного стенда теперь обеспечивает сама политика (обычный юзер → `{USER}`).
- [x] **E15 end-to-end (№256/257)** — `master_onboarding_completed` в `_JSONB_CREDENTIAL_FIELDS` + `UserUpdate` + computed в `UserResponse`; typed-фронт (`generated.ts` hand-add до регена), `persistMasterOnboarding` без каста; тесты default/persist/re-login/null в `test_users.py`. Карусель НЕ пере-показывается на новой сессии.
- [x] **Честный вход no-profile мастера (№257, Q4=А)** — `get_current_master`: 403-коды `master_profile_not_found` / `master_profile_not_verified`; стор `master.profileMissing` (только по коду — transient error НЕ роутит); `masterNoProfileGuard` на дашборде + первый чек в `masterStatusGuard` → `/master/apply`; pending/rejected/suspended → `/master/pending` байт-идентично.
- [x] **Batch-INVITE (№258, C1=Б/TTL=В/F2=А)** — `POST /admin/masters/invite` (404 `invite_target_not_found` инлайн / 409 `already_master`; sha256 в `credentials.master_invite`, re-issue перезаписывает, БЕЗ срока) → полная ссылка `<bot_url>?startapp=master_onboarding__<token>`; админ-экран `admin-master-invite` (DS-only, B2-клипборд, подпись «одноразовая · действует до погашения»); диплинк-kind в `parseStartParam` → `/master/invite/:token` (`MasterInviteClaimView`, [applyGuard]) → `POST /masters/invite/claim` (структурная привязка к СВОЕМУ аккаунту, constant-time, consume) → существующий визард + админ-апрув. 9 тестов `test_master_invite.py`.
- [x] **Опер-гейт seed-мегапака (№255)** — bare `velo seed-practices` требует typed-«yes» перед сценарием `default` (~300 практик/12 мастеров); `--scenario`/`--yes`/`--dry-run` обходят; reset+default = один объединённый prompt.

**Ключевые решения:**

- Один источник правды на политику свитча (write-путь и `/me`-блок не могут разъехаться).
- Инвайт = только валидация+consume; верификация мастера ОСТАЁТСЯ за визардом заявки + админ-апрувом (никого не верифицируем по ссылке).
- Плейнтекст-токен живёт только в ссылке; в БД — sha256; аудит без токена.

**Ruling (№260, закрыто):** прод-видимость свитча для верифицированных мастеров/админов = НАМЕРЕННАЯ фича (theme A); секция переименована «Режим тестировщика» → **«Переключение роли»**, тестер-обвязка (повтор онбординга + превью заявки) удалена из кода Batch-STRIP'ом — тест==прод. Остаётся известный узкий эдж (accepted as-is): CLI-демоут админа ПОСЛЕ его свитча оставляет stale `home_role`-маркер (опциональный однострочный фикс в Zod's `set_role.py` — записан ему в inbox).

- [x] **Batch-STRIP (№260)** — весь тестер-скаффолдинг удалён: `ui.forceOnboarding` (сигнал + `App.vue`-watcher + `forced`-параметр `shouldShowMasterOnboarding`) и `ui.previewApplyFlow` (сигнал + `PREVIEW_ROUTE_NAMES` + ветки `applyGuard`/`masterPendingGuard`/`beforeEach`/Landing/Apply/Pending + кнопка «Просмотреть экраны заявки»); `ui`-store ужат до `uiMode`; Vitest-спеки forced-гейта сняты. Гарды №257 (honest entry) и роут №258 (invite) поведенчески байт-идентичны.

**Зависимость от бэкенда (Zod):** нет новых; E15 закрыт своими силами (backend-exception). Открытые прежние: E4, E13, E16, E17, E19.

**Критерий готовности:** py_compile + vue-tsc + vite build + Vitest 83/83 зелёные локально; pytest — на деплое; батч HELD до nav-LEAN + operator push-go; device-verify (диплинк из Telegram, admin-экран, no-profile вход) — операторская петля. ✅ (код), деплой pending.

---

## 5. Сводка зависимостей

| Frontend Phase              | Backend Phase               | Статус бэка  | Блокирует?               |
| --------------------------- | --------------------------- | ------------ | ------------------------ |
| F0: Инфра ✅                | —                           | —            | Нет                      |
| F1: Auth ✅                 | 1.2, 1.4                    | ✅           | Нет                      |
| F2: Компоненты ✅           | 1.4                         | ✅           | Нет                      |
| F3: Каталог ✅              | 4.3                         | ✅           | Нет                      |
| F4: Бронирование ✅         | 5+6                         | ✅           | Нет                      |
| F5: Stripe ✅               | 6.3                         | ✅           | Нет                      |
| F6: Master ✅               | 2+4+5.4                     | ✅           | Нет                      |
| F7: Финансы ✅              | 6.6                         | ✅           | Нет                      |
| F8: Admin ✅                | 3+6.8                       | ✅           | Нет                      |
| F9: Diary                   | 8.4                         | ✅           | **Нет (разблокировано)** |
| F10: PWA                    | 7.3 + новый auth            | **Частично** | **Частично**             |
| F11: TabBar + Onboarding ✅ | 1.2, 1.4 (+onboarding flag) | ✅           | Нет                      |
| F12: Diary redesign ✅      | 8.4 (+/diary/feed)          | ✅           | Нет                      |
| F13: Мастер-программа ✅    | E7 ✅ / E8 частично / E13–E17 | **Частично** | Нет (honest-стабы)       |
| F14: Polish + kbd-viewport + User Сообщения ✅ | E4 messaging (открыт)       | **Частично** | Нет (honest-стабы)       |
| F15: kbd/туман polish + чат fill + focus-freeze ✅ | E19 methods-workflow (нов., открыт) / E4 | **Частично** | Нет (honest-стабы)       |

---

## 6. Реестр технического долга

### Обозначения

- **Среда:** 🧪 Тест / 🚀 Прод
- **Статус:** ⬜ Open / ✅ Done

### Известные решения (НЕ является долгом)

| Решение                                                     | Причина                                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Типы API: codegen из OpenAPI (CR-01) + `types.ts` поверх | Бэкенд-типы автогенерируются в `generated.ts` (единый источник, drift невозможен конструктивно); `types.ts` реэкспортит их и добавляет только фронт-онли типы. Прежняя «ручная типизация» снята с введением CR-01 — см. Фронтовый Кодекс FP-09 |
| sessionStorage вместо localStorage для token                | Telegram WebApp закрывает вкладку — sessionStorage очищается, localStorage нет                                          |
| Свой CSS вместо Tailwind                                    | Дизайн-система уже готова в мокапах, переносить проще 1:1                                                               |
| Внутренний Nginx в Docker фронтенда                         | SPA fallback + кеширование без усложнения хост-конфига                                                                  |
| Telegram SDK через локальную копию script (не npm)          | CDN Telegram заблокирован ТСПУ; локальная копия гарантирует загрузку. Миграция на npm `@telegram-apps/sdk` — см. TD-SDK |
| Auth guard в App.vue, а не в router beforeEach              | В F1 один маршрут, ролевого роутинга нет; router guards добавляются в F2.2                                              |
| Telegram SDK типы в env.d.ts (не отдельный .d.ts)           | Минимальный surface — типизированы только используемые методы; вынести при росте                                        |
| Token decoupled от Pinia (модульная переменная в client.ts) | Исключает circular dependency client → store → client                                                                   |
| `v-show` на форме payout (W-4)                              | Осознанный выбор: форма скрывается анимированно, `v-if` ломал бы переход                                                |

### Инфраструктура — перед публичным запуском 🚀

| ID          | Среда | Описание                                                                                                                                                                          | Решение                                                                                                                                                                                    | Статус |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| TD-RU-PROXY | 🚀    | Hetzner IP (`api.talentir.info`) заблокирован ТСПУ из России. `ERR_CONNECTION_TIMED_OUT` — сервер полностью недоступен без VPN. Не только Telegram WebView, но и обычные браузеры | Российский VPS reverse proxy (Timeweb/Selectel, ~300-500₽/мес) или DDoS-Guard CDN. DNS `api.talentir.info` → российский IP. SSL через Let's Encrypt. Бэкенд и фронтенд остаются на Hetzner | ⬜     |
| TD-SDK      | 🧪    | Telegram WebApp SDK подключается как локальная копия `public/js/telegram-web-app.js` (3331 строка). Ручное обновление при новых версиях SDK                                       | Миграция на npm-пакет `@telegram-apps/sdk` для управления версиями через package.json                                                                                                      | ⬜     |

### F7 Review — открытые предупреждения

| ID                   | Среда | Файл                                             | Описание                                                                                                             | Решение                                                                                                               | Статус                                                    |
| -------------------- | ----- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| TD-FE-W6             | 🧪    | `MasterFinanceView.vue`                          | `MIN_WITHDRAWAL_EUROS=50` и `WITHDRAWAL_FEE_EUROS=2` захардкожены на фронте — рассинхрон с `config.py` при изменении | Получать из нового эндпоинта `GET /api/v1/config` или при необходимости дублировать с явным комментарием об источнике | ⬜                                                        |
| TD-FE-F7-SUGGESTIONS | 🧪    | `MasterFinanceView.vue`, `MasterProfileView.vue` | 7 suggestions из F7 review (LOW) — UX-улучшения, неблокирующие                                                       | Рассмотреть перед F8                                                                                                  | ✅ (закрыто как осознанное решение — не критично для MVP) |

### Переключение режима мастер/юзер

| ID             | Среда | Описание                                                                                                                                                                                            | Решение                                                                                                                                                                                                                                                                                                                    | Статус |
| -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TD-MODE-SWITCH | 🧪    | Мастер является юзером и может участвовать в чужих практиках, но в мастерском интерфейсе нет точки входа в каталог. Маршруты `/user/*` (кроме dashboard) доступны технически, но недосягаемы из UI. | Кнопка "Перейти в интерфейс Юзера" в `MasterProfileView` + кнопка "Перейти в интерфейс Мастера" в `UserProfileView` (только если `role === 'master'`). Текущий режим хранить в `sessionStorage` или Pinia. Глобальный `beforeEach` адаптировать: не редиректить мастера с `/user/dashboard` если он сам выбрал user-режим. | ⬜     |

### Keyboard Accessibility (F8)

| ID         | Среда | Описание                                                                                                                                                                                                                                                           | Решение                                                                                                                                                          | Статус |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TD-FE-A11Y | 🧪    | Clickable `<div>` элементы в admin-вью не имеют `role="button"`, `tabindex="0"`, обработчиков `@keydown.enter`/`@keydown.space`. Затронуто: алертовый баннер, stat cards, action cards, master cards, report cards. Нарушает WCAG 2.1 AA (Success Criterion 2.1.1) | Добавить `role="button"`, `tabindex="0"`, `@keydown.enter.stop="handler"`, `@keydown.space.prevent="handler"` на каждый clickable div. Приоритет: LOW, post-MVP. | ⬜     |

### Deep links — обработка startapp параметра

| ID     | Среда | Файл                                             | Описание                                                                                                                                                                                                                                                                                                                                     | Решение                                                                                                                                                                                                                                                                                         | Статус |
| ------ | ----- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TD-F01 | 🚀    | `platform/telegram.ts`, `composables/useAuth.ts` | `startapp` параметр не обрабатывается при открытии приложения — диплинки (например из Telegram-каналов мастеров) открывают дашборд вместо конкретной практики. Бэкенд уже генерирует правильные ссылки формата `https://t.me/velo_testbot?startapp=open_practice__{uuid}` через `TelegramFormatter.format_deep_link()`. Фронт их игнорирует. | В `initAuth()` после успешной авторизации читать `window.Telegram.WebApp.initDataUnsafe.start_param`, парсить формат `open_practice__{uuid}`, вызывать `router.push('/user/practices/{uuid}')`. Объём: ~10-15 строк в одном файле. Приоритет высокий — влияет на конверсию из каналов мастеров. | ⬜ ⚠ **STALE PREMISE (Navigator-42, 2026-08-12, `PROMPT №679`):** the cited backend mechanism `TelegramFormatter.format_deep_link()` lived in the DELETED `modules/notifications/formatters.py` and occurs ZERO times in `backend/` today; no replacement deep-link generator was found. Whether deep-link generation was dropped with the notifications rewrite or must be rebuilt is UNRESOLVED — re-verify before building this item. |

### Внешнее ревью ветки `test` (E3, июнь 2026) — фронт

| ID | Среда | Файл | Описание | Решение | Статус |
| --- | --- | --- | --- | --- | --- |
| TD-FE-WD-DEEPLINK | 🚀 | `views/admin/AdminWithdrawalDetailView.vue` | W-5: вью читает вывод из `window.history.state` (~стр.118); при deep-link / перезагрузке `w.value=null` -> заглушки `'—'`, кнопки заблокированы, `VBackButton` -> `router.back()` выходит из приложения (тупик) | Минимум: `onMounted` -> `if (!w.value) router.replace('/admin/withdrawals')`. Полнее: грузить вывод по id | ⬜ |
| TD-FE-DASH-STATS | 🧪 | `views/user/UserDashboardView.vue` | W-6: прогресс-статы из пагинированной страницы броней (~20) -> частичны при >20 посещённых. Задокументировано в коде (~стр.16) как осознанный MVP-компромисс | Пост-MVP: `getMyStats()` (`GET /bookings/me/stats`) вместо вывода из страницы. Не блокер | ⬜ |
| TD-FE-BOOK-LOADMORE | 🧪 | `views/user/MyBookingsView.vue` | W-7: список броней — только первая страница (нет «Загрузить ещё»). Задокументировано в коде (~стр.10) как MVP | Пост-MVP: load-more по `{items,total,limit,offset}`. Не блокер | ⬜ |

> E3-вайринг (форма создания серии, диалог отмены с охватом) — см. PHASE F6.2/F6.3
> (блок-цитаты «Доступно с бэка, E3»). Также доступно с бэка (E7): период-сетки
> `GET /masters/me/stats` и `GET /admin/stats/overview` (тоггл Неделя/Месяц
> становится реальным; admin-обзор одним вызовом заменяет фан-аут) — вайринг за
> фронт-девом. Бэк-контракты — Фронтовый Кодекс §10 и Бэковый Кодекс §2 / §3.13.

### Флоу ДАШБОРД (экраны 10–18) — реализация 2026-05-21

Реализован пользовательский флоу по Figma (node `541:6648`) поверх фаз F3/F4/F9.
Подробности и карта вью — в **Фронтовом Кодексе §3.4**. Кратко:

**Сделано:** новые вью `PracticeLiveView` (14), `AiSummaryView` (16, заглушка),
`MyBookingsView` (17), `BookingDetailView` (18); переделаны `UserDashboardView` (10/11),
`CheckinView` (12/13), `PracticeDetailView` (15). Новые роуты `practice-live/:practiceId`,
`ai-summary`, `bookings/:id`. Новые shared-компоненты `PracticeHeroCard`, `MasterCard`,
`FormShell` + dumb-`BookingCard`. Платформа получила метод `openLink`. Store `bookings`
расширен (`fetchBooking`, `joinBooking`/`leaveBooking`, `selectedBooking`). Бэк-разблокировка:
`PracticeSummary.status` (бейдж "В эфире" без отдельного GET).

**Закрыто рефакторингом:** дублирование форм (извлечён `FormShell`); единый
`composables/useApiError.ts` для обработки ошибок store; God-component `PracticeDetailView`
смягчён выносом hero/master.

**Новый техдолг флоу:**

| ID            | Среда | Файл                                            | Описание                                                                                                                                      | Решение                                                                                | Статус |
| ------------- | ----- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| TD-FE-AISUM   | 🧪    | `views/user/AiSummaryView.vue`                  | Экран 16 — заглушка. Персонального AI-саммари юзера на бэке нет (есть только мастерский per-practice, розетка Phase 9)                        | Реализовать при появлении бэк-эндпоинта юзерского AI-саммари                           | ⬜     |
| TD-FE-AVATAR  | ✅    | `shared/MasterCard.vue`, `PracticeHeroCard.vue` | Аватарки мастеров — плейсхолдер `IconMeditation`                                                                                              | ЗАКРЫТО (Calendar flow 4-7): `VAvatar` (фото/инициалы), бэк отдаёт `master_avatar_url` | ✅     |
| TD-FE-ICONSVG | 🧪    | `src/components/icons/`                         | Сырые `.svg` рядом с `.vue`-компонентами иконок (артефакт экспорта)                                                                           | `git rm` сырых `.svg`                                                                  | ⬜     |
| S-4           | 🧪    | `shared/MasterCard.vue`                         | Кнопка "Подробнее" (профиль мастера) кликабельна с toast "скоро", экрана нет. Аудит 2026-05-20 предлагал disabled — оставлено toast-заглушкой | disabled-state либо реальный экран профиля мастера для юзера                           | ⬜     |

---

### Флоу КАЛЕНДАРЬ (кадры 1–3) — реализация 2026-05-22

Реализован экран «Календарь» по Figma (node `541:1553`, кадры 1/2/3) поверх фаз F3/F4.
Подробности и карта вью — в **Фронтовом Кодексе §3.5**. Кратко:

**Сделано:** новый стор `stores/calendar.ts` (загрузка недели одним запросом + буфер ±1 день,
маркеры/список дня по TZ практики); компоненты `WeekStrip`, `CalendarPracticeCard`,
`CalendarFilterModal` (все в `components/shared/`); полностью переработан `CalendarView`
(кадры 1 и 3, контрол «Выбрать практики» — Вариант 1: модалка единственный источник
фильтров, inline-чипы отображают/снимают активные); индикатор сложности ●●○ на
`PracticeDetailView`. Маппинги Календаря добавлены в `displayHelpers.ts`
(DIRECTION/DIFFICULTY/DURATION_BUCKET/TIME_OF_DAY + DIFFICULTY_DOTS) и опции в
`practiceOptions.ts` (DIRECTION/DIFFICULTY_OPTIONS).

**Контракт:** `PracticeFilters` стал мульти-фасетным (массивы `practice_type/direction/difficulty`

- `style/duration_bucket/time_of_day`); `buildQuery` (`api/utils.ts`) сериализует массивы
  повторяемыми ключами, пустой массив/undefined/null пропускает. Единый `getPractices` —
  без дублей API/типов. Дашборд `practice_type` не использует — не затронут.

**Бэк-разблокировка:** `PracticeResponse.is_booked/is_paid` (бейдж «Оплачено»/«Бесплатно»);
фильтры фида direction/difficulty/style/duration_bucket/time_of_day (Бэковый Кодекс §2, §3.8).

**Аудит итерации (2026-05-22):** C-1 (бэк, layer boundary) и W-2 (TZ-граница недели) — ✅ устранены;
W-3 (дефолты таксономии в Edit) — won't fix (БД сносится). См. Технический Кодекс реестр.

**Новый техдолг флоу:**

| ID           | Среда | Файл                                       | Описание                                                                                                              | Решение                                  | Статус |
| ------------ | ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| TD-CAL-STYLE | 🧪    | `shared/CalendarFilterModal.vue`           | «Вид практики» (style) — свободный `VInput`, в Figma дропдаун. Справочника стилей нет, бэк принимает свободную строку | Дропдаун при появлении каталога стилей   | ⬜     |
| TD-CAL-ARROW | 🧪    | `shared/WeekStrip.vue`, `CalendarView.vue` | Стрелки недели / шеврон / воронка — inline SVG (в DS нет `IconChevron`/`IconFilter`/левой стрелки)                    | Завести иконки в DS, заменить inline SVG | ⬜     |

---

### Флоу КАЛЕНДАРЬ (кадры 4–7 + профиль мастера) — реализация 2026-05-24

Завершение флоу по Figma (node `541:1553`) поверх кадров 1-3. Детали реализации и
паттерны — **Фронтовый Кодекс §3.6**. Кратко по экранам:

| Кадр               | Экран                                                                                                                                                          | Маршрут                                                          | Статус                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| 4 + master profile | `MasterPublicView.vue` — публичный профиль мастера для юзера (hero `VAvatar`, статы practices/reviews, методы, ближайшие практики, «Задать вопрос» = заглушка) | `user-master-public` (`/user/masters/:id`)                       | ✅                         |
| 5                  | `BookingConfirmedView.vue` — «Практика забронирована!» (success `IconSuccess`, блок «запрос мастеру» = заглушка, «В календарь» / «На главную»)                 | `user-booking-confirmed` (`/user/booking-confirmed/:practiceId`) | ✅                         |
| 6                  | «Вопрос мастеру»                                                                                                                                               | —                                                                | ⬜ отложен (TD-ASK-MASTER) |
| 7                  | `FeedbackView.vue` — рейтинг (векторные иконки вместо emoji) + success-сердце `IconHeart`                                                                      | `user-feedback` (существующий)                                   | ✅                         |

**Новые маршруты** (`router/index.ts`, под `/user`): `user-master-public` (`masters/:id`)
и `user-booking-confirmed` (`booking-confirmed/:practiceId`). Оба без roleGuard (мастер
тоже бронирует как юзер). `PracticeDetailView.onPurchased` редиректит на booking-confirmed.

**Бэк-разблокировка:** публичный профиль `GET /api/v1/masters/{user_id}`
(`MasterPublicResponse`, только публичные поля) + `master_avatar_url` в деталях практики
(Бэковый Кодекс §3.9).

**Аудит итерации (2026-05-24):** 0 critical / 0 warning, 3 suggestion.
S-1 (лишний `fetchPractice` в `onPurchased`) — ✅ устранён; S-3 (trailing newline в
`masters/schemas.py`) — ✅ устранён; S-2 (статичный Zoom-текст) — осознанно отложен
(TD-ZOOM-TEXT). Оценка 9/10.

**Новый техдолг флоу:**

| ID                       | Среда | Файл                                                                       | Описание                                                                                                                                                                                                                                                                                                                                                                                                                                   | Решение                                                                                       | Статус |
| ------------------------ | ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------ |
| TD-ASK-MASTER            | 🧪    | `MasterPublicView.vue`, `BookingConfirmedView.vue`, везде «вопрос мастеру» | Вопросы мастеру — сквозная фича (из профиля «в общем» / до брони / после), маршрутизация в Telegram-бот мастера + ответ юзеру в бот. Требует бэка. Сейчас все точки входа — toast-заглушки. Кадр 6 отложен. **Решение (2026-06-02):** это диалог юзер↔мастер = отдельная сущность+флоу на бэке, НЕ строка `master_request` на брони; вне MVP. Чек-ин клиента мастеру УЖЕ отдаётся через attendance (новые поля в `AttendanceItemResponse`) | Спроектировать+реализовать бэк диалогов (треды, бот), подключить точки входа                  |
| TD-CAL-ICON-YOGA         | 🧪    | `components/icons/IconYoga.vue`                                            | `IconYoga` — Claude-плейсхолдер                                                                                                                                                                                                                                                                                                                                                                                                            | Заменить ассетом дизайнера (тот же filename/viewBox/`currentColor`)                           |
| TD-CAL-DIRECTIONS-EXPAND | 🧪    | `utils/displayHelpers.ts`                                                  | Бэк добавит направления (somatic/womens_circle/mens_circle/tantra/kundalini)                                                                                                                                                                                                                                                                                                                                                               | `DIRECTION_ICON` уже Partial+fallback; добавлять иконки по мере появления                     |
| TD-ZOOM-TEXT             | 🧪    | `BookingConfirmedView.vue`                                                 | Статичный Zoom-текст (аудит S-2)                                                                                                                                                                                                                                                                                                                                                                                                           | Нейтральная формулировка или условие по `practice.zoom_link`, когда появятся не-Zoom практики |

---

### Раздел ПРОФИЛЬ — реализация 2026-05-29

Реализован раздел «Профиль пользователя» по Figma (`F7PD5isLfLdyc0q1Bd5n5c`,
node `4715-3463`). Детали и паттерны — **Фронтовый Кодекс §3.7**. Карта экранов:

| Экран (node)               | View / маршрут                                                                                                                        | Статус                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A — главный (70/71)        | `UserProfileView.vue` (`user-profile`) — переработан: две стат-карточки (`GET /bookings/me/stats`), пункты-переходы, векторные иконки | ✅                    |
| F — Язык/Часовой пояс (75) | `LanguageTimezoneView.vue` (`user-language-timezone`) — таймзона (переисп. picker, автосейв), язык-заглушка                           | ✅                    |
| C — Редактирование (72)    | `EditProfileView.vue` (`user-edit-profile`) — имя/email-заглушка/телефон/о-себе                                                       | ✅                    |
| D — Удаление (73)          | модалка в `EditProfileView` — `DELETE /users/me`, MVP = сброс онбординга                                                              | ✅                    |
| E — Уведомления (74)       | `NotificationsView.vue` (`user-notifications`) — 4 свича, автосейв                                                                    | ✅                    |
| G — Поддержка (76)         | —                                                                                                                                     | ⬜ отложен (заказчик) |

**Новый примитив** `components/ui/VSwitch.vue` (on/off boolean). **Новые маршруты**
(`router/index.ts`, под `/user`): `user-language-timezone`, `user-edit-profile`,
`user-notifications`.

**Бэк-разблокировка:** `GET /api/v1/bookings/me/stats` (`UserStatsResponse`),
`DELETE /api/v1/users/me` (сброс онбординга), `phone`/`bio`/`notifications` в
`User.credentials` JSONB (Бэковый Кодекс §3.11).

**Аудит итерации (2026-05-29):** W-2 (честный текст модала удаления), S-1
(`bio.trimEnd()`), S-2 (язык-строка неинтерактивна при одном языке) — ✅. W-1/W-4/S-5
— на бэке. W-3/S-3 — осознанно не код.

**Новый техдолг раздела:**

| ID                       | Среда | Файл                       | Описание                                                                    | Решение                                                       | Статус |
| ------------------------ | ----- | -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| TD-PROFILE-SUPPORT       | 🧪    | экран G (node 76)          | «Поддержка» не реализована (отложена заказчиком); пункт на экране A — toast | Форма (Тема+Сообщение+Отправить) + тост, без бэка             | ⬜     |
| TD-PROFILE-LANG-I18N     | 🧪    | `LanguageTimezoneView.vue` | Язык — заглушка из одного пункта (i18n нет), не сохраняется                 | vue-i18n, снять `isLanguageStatic`, сохранять `user.language` | ⬜     |
| TD-PROFILE-AVATAR-UPLOAD | 🧪    | `EditProfileView.vue`      | «Изменить фото» — toast (нет загрузки; аватар из Telegram)                  | Загрузка при появлении файлового бэка                         | ⬜     |

---

### Мастер-программа — honest-стабы (F13, Zod E13–E17)

| ID | Среда | Описание | Статус |
| --- | --- | --- | --- |
| TD-FE-E13-APPLY-DOCS | 🧪 | Загрузка файлов заявки — стаб (тост, без POST) | ⬜ |
| TD-FE-E14-REJECT-REASON | 🧪 | Причина отказа — generic до E14 | ⬜ |
| TD-FE-E15-ONBOARDING-FLAG | ✅ | ЗАКРЫТ (v2.4/F16): `master_onboarding_completed` персистится + типизирован | ✅ |
| TD-FE-E16-APPLY-LANGS | ✅ | ЗАКРЫТ (v2.5): языки уходят с заявкой (`experience.languages`) + свободно редактируемы на профиле (`PATCH /masters/me/languages`) | ✅ |
| TD-FE-E17-WEB-AUTH | 🧪 | Phase A `/auth/*` — спящие, ждут web-auth-бэк | ⬜ |

TEST-only инструменты (повтор онбординга / превью заявки) — УДАЛЕНЫ из кода (№260
Batch-STRIP, «тест==прод»); роль-свитч — прод-фича «Переключение роли» с capability-политикой
(F16). Полные файл-привязки — Фронтовый Кодекс §10.

## 7. LLM Code Review Guide (Frontend)

### FP-01: Не хардкодить API URL

```typescript
// ❌ ЗАПРЕЩЕНО:
fetch("https://api.talentir.info/api/v1/users/me");

// ✅ ПРАВИЛЬНО:
const BASE_URL = import.meta.env.VITE_API_BASE_URL;
fetch(`${BASE_URL}/api/v1/users/me`);
```

### FP-02: Не мутировать Pinia store напрямую из компонентов

```typescript
// ❌ ЗАПРЕЩЕНО:
authStore.user = response.data;

// ✅ ПРАВИЛЬНО — через action:
authStore.setUser(response.data);
```

### FP-03: Не забывать обработку ошибок API

```typescript
// ❌ ЗАПРЕЩЕНО:
const data = await api.get("/practices");
practices.value = data.items;

// ✅ ПРАВИЛЬНО:
try {
  const data = await api.get<PaginatedPracticesResponse>("/practices");
  practices.value = data.items;
} catch (error) {
  toast.error("Не удалось загрузить практики");
}
```

### FP-04: Не забывать loading-состояния

```typescript
// ❌ Кнопка без блокировки — двойной клик:
async function book() {
  await api.post(`/practices/${id}/purchase`);
}

// ✅ С loading:
const loading = ref(false);
async function book() {
  if (loading.value) return;
  loading.value = true;
  try {
    await api.post(`/practices/${id}/purchase`);
  } finally {
    loading.value = false;
  }
}
```

### FP-05: Не использовать `any`

```typescript
// ❌ ЗАПРЕЩЕНО:
function handleResponse(data: any) { ... }

// ✅ ПРАВИЛЬНО:
function handleResponse(data: PracticeResponse) { ... }
```

### FP-06: Cents → отображение (всегда через format)

```typescript
// ❌ ЗАПРЕЩЕНО:
<span>{{ user.balance_cents / 100 }}€</span>

// ✅ ПРАВИЛЬНО:
<span>{{ formatMoney(user.balance_cents, 'EUR', 'ru', true) }}</span>
```

### FP-07: Не привязываться к Telegram SDK напрямую

```typescript
// ❌ ЗАПРЕЩЕНО в компонентах:
window.Telegram.WebApp.HapticFeedback.impactOccurred("medium");

// ✅ ПРАВИЛЬНО — через абстракцию:
platform.hapticFeedback("medium");
```

### FP-08: Не мутировать token/sessionStorage напрямую из API client

```typescript
// ❌ ЗАПРЕЩЕНО в client.ts:
if (response.status === 401) {
  sessionStorage.removeItem("velo_token");
  window.location.href = "/";
}

// ✅ ПРАВИЛЬНО — через callback:
if (response.status === 401) {
  _onUnauthorized?.(); // auth store handles cleanup
  throw new ApiResponseError(401, "Session expired");
}
```

### FP-09: Cents input/output — всегда через currency utils

```typescript
// ❌ ЗАПРЕЩЕНО — float precision trap:
const cents = Math.round(parseFloat(input) * 100);
const display = (cents / 100).toFixed(2);

// ✅ ПРАВИЛЬНО:
import { eurStringToCents, centsToEurString } from "@/utils/currency";
const cents = eurStringToCents(input); // '14.57' → 1457, safe integer math
const display = centsToEurString(cents); // 1457 → '14.57'
```

---

**Конец документа**
