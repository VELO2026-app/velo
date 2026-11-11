# e2e: детектор крашей и обход всех экранов (FE-161)

Короткая инструкция для агентов и людей: когда запускать, как читать отчёт, что делать с падением.

## Что это

В `frontend/e2e/` два контура, оба под **детектором крашей**:

| Контур | Что делает | Бэк | Команда |
| --- | --- | --- | --- |
| `smoke` | 5 сценариев + самопроверки детектора | моки API | `pnpm -C frontend e2e:smoke` |
| `sweep` | каждый роут роутера под каждой ролью из таблицы, только открывает | настоящий, сид `e2e` | `pnpm -C frontend e2e:sweep` |

Детектор (`e2e/support/crashes.ts`) делает тест красным, если за время теста было:

- `exception` — необработанное исключение;
- `reported` — ошибка, дошедшая до `reportError` (рендер, setup, роутер, unhandled rejection);
- `console` — `console.error`;
- `api` — ответ `/api/` 5xx или 4xx, который тест не разрешил;
- `asset` — не загрузился чанк, стиль или шрифт;
- `screen` — на экране видно состояние ошибки (`data-testid="screen-error"` / `"not-found"`);
- `blank` — в `#app` ничего не отрисовано.

Sweep дополнительно проверяет, что вместо экрана не нарисован вход (`splash` / `welcome` / `login`), что URL — тот, что у роута, и что видна `<main>` шелла или заголовок.

## Когда запускать

- **После изменений в `src/views/`, `src/router/`, `src/api/`, `src/stores/` — обязательно `e2e:sweep`** (и `pnpm verify`, как всегда).
- После изменений бэка, которые меняют ответы API, — тоже `e2e:sweep`: переименованное поле ломает экран, не трогая фронт.
- В CI: job `e2e-stack` на каждый PR (фронт или бэк), ночной прогон на `test` в Chromium и WebKit (`.github/workflows/e2e-stack.yml`). Первые две недели job не блокирует мерж.

## Как запустить локально

Нужен поднятый стек: Postgres, Redis, бэк на `:8000`, comms-заглушка на `:8899`, сид `e2e`.

**Стенд velo-dev** (`~/work/velo-dev`):

```sh
sh ~/work/velo-dev/velo-dev-up.sh
python frontend/e2e/stack/seed_e2e.py && velo setrole 607031 A --yes   # один раз; сид — обёртка, `velo seed` профиль не видит
pnpm -C frontend build                                     # golden-сборка для vite preview
pnpm -C frontend e2e:sweep
```

Чтобы гнать sweep по дев-серверу вместо сборки: `E2E_BASE_URL=http://localhost:5173 pnpm -C frontend e2e:sweep`.

**Отдельный стек** (как в CI) — своя база, свои env (`DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_URL`, `COMMS_API_URL`, `COMMS_SERVICE_TOKEN`, `APP_ENV=development`, `ALLOW_ZOOM_STUB=true`, `ALLOW_STRIPE_STUB=true`, `VELO_ROLE=test`; список — в `env:` job'а):

```sh
PYTHON=backend/.venv/bin/python sh frontend/e2e/stack/up.sh   # миграции, сид, админ, заглушка, uvicorn
pnpm -C frontend build && pnpm -C frontend e2e:sweep
```

Логин настоящий: `e2e/stack/auth.ts` подписывает initData тем же `TELEGRAM_BOT_TOKEN`, с которым запущен бэк (в CI — фейковый `e2e:fake`; локально берётся из окружения или `backend/.env`, не печатается). Сессии кэшируются в `frontend/e2e/.state/tokens.json`: у бэка лимит 5 логинов на id в минуту.

WebKit: `pnpm -C frontend exec playwright test --project=sweep-webkit`.

## Как читать отчёт

В конце прогона — по строке на упавший тест:

```
[student] /user/bookings -- reported: [vue/...] TypeError: Cannot read properties of undefined (reading 'map') (trace: test-results/.../trace.zip)
[student] /user/dashboard -- api: GET /api/v1/bookings/me/stats -> 500 (x3) (trace: ...)
```

Формат: `[роль] /шаблон-роута -- сигнал: сообщение (xN — сколько раз) (trace: путь)`. Сигнал `failure` — тест упал не от детектора (не тот URL, пустой экран, таймаут).

То же в `frontend/test-results/crashes.json` (массив `{ project, test, signals[], trace }`) и, в CI, в summary шага; trace и скриншоты — в артефакте `e2e-sweep-*`.

Открыть trace: `pnpm -C frontend exec playwright show-trace <путь из отчёта>` — там сеть, консоль, DOM на каждом шаге.

Один экран под одной ролью: `pnpm -C frontend exec playwright test --project=sweep -g "@user-bookings"` (тег — имя роута).

## Что делать с падением

**Падение — это баг.** Исправить в своей задаче или, если не по теме, завести задачу FE/BE (поискать дубль) и связать.

- Не глушить: `crashes.allow(...)` и `e2e/support/allowlist.ts` пополняются **только со строкой-причиной** (`reason` обязателен): известный дефект с номером задачи или ответ, который для этого экрана — норма (например, тест самого экрана ошибки).
- Не добавлять ретраи: краш, который воспроизводится через раз, — гонка. Флак чинится в `e2e/support/settle.ts` или в данных сида.
- Экран упал только на моках (smoke) — сначала проверить мок: `api.on(method, path, {status, body})` с объектом отдаёт его как **тело со статусом 200**; статус задаётся функцией `() => ({ status: 500, body })`.

## Как добавить роут в обход

Новый именованный роут без строки в `frontend/e2e/sweep/routes.ts` роняет unit-тест `src/router/sweep-coverage.test.ts` (быстрый гейт, `pnpm test`). Строка:

```ts
'my-route': { path: '/user/things/:id', roles: ['student'], params: { id: 'thingId' } },
```

- `path` — ровно как в роутере (тест сверяет);
- `roles` — `student` (ada), `master` (mira), `admin` (root), `cara`, `ben` — люди сида `frontend/e2e/stack/seed/e2e.json` (подключается обёрткой `seed_e2e.py`, `backend/**` не трогаем);
- `params` — ключ из `e2e/.state/params.json` или литерал `'=value'`; новый ключ — добавить сбор в `frontend/e2e/stack/stack.setup.ts` (из API; если объекта нет — создать через API, идемпотентно, по имени);
- `lands` — URL, где экран оказывается по задумке (редирект);
- `allow` — сигналы, которые экран даёт по задумке, с причиной;
- или `{ path, skip: '<причина>' }`, если экран открыть нельзя.

Sweep только читает. Два экрана пишут при открытии — по задумке и идемпотентно: `master-invite` (гасит одноразовый токен; setup выпускает новый на каждый прогон) и `group-join` (ada уже в группе).
