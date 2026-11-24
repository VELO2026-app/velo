# e2e: детектор крашей и обход всех экранов (FE-161)

Короткая инструкция для агентов и людей: когда запускать, как читать отчёт, что делать с падением.

## Что это

В `frontend/e2e/` два контура, оба под **детектором крашей**:

| Контур | Что делает | Бэк | Команда |
| --- | --- | --- | --- |
| `smoke` | сценарии + самопроверки детектора; сборка с синтетическим пакетом скина (`make-test-skin.mjs`, FE-230) | моки API | `pnpm -C frontend e2e:smoke` |
| `sweep` | каждый роут роутера под каждой ролью из таблицы, только открывает | настоящий, сид `e2e` | `pnpm -C frontend e2e:sweep` |

Детектор (`e2e/support/crashes.ts`) делает тест красным, если за время теста было:

- `exception` — необработанное исключение;
- `reported` — ошибка, дошедшая до `reportError` (рендер, setup, роутер, unhandled rejection);
- `console` — `console.error`;
- `api` — ответ `/api/` 5xx или 4xx, который тест не разрешил;
- `asset` — не загрузился чанк, стиль или шрифт;
- `screen` — на экране видно состояние ошибки (`data-testid="screen-error"` / `"not-found"`). У `VEmptyState` по умолчанию это иконки `warning` и `notfound`; если `warning` — штатный исход, а не сбой (практика отменена), ставь ему `:error="false"`;
- `blank` — в `#app` ничего не отрисовано.

Sweep дополнительно проверяет, что вместо экрана не нарисован вход (`splash` / `welcome` / `login`), что URL — тот, что у роута, и что видна `<main>` шелла или заголовок.

## Когда запускать

- **После изменений в `src/views/`, `src/router/`, `src/api/`, `src/stores/` — обязательно `e2e:sweep`** (и `pnpm verify`, как всегда).
- После изменений бэка, которые меняют ответы API, — тоже `e2e:sweep`: переименованное поле ломает экран, не трогая фронт.
- В CI: job `e2e-stack` на каждый PR (фронт или бэк), ночной прогон на `deploy-machine` в Chromium и WebKit (`.github/workflows/e2e-stack.yml`). С FE-222 job блокирует мерж: красный sweep — красный `CI — gate`. Если экран падает по известной причине, он уходит в карантин строкой `skip: 'FE-123 <почему>'` в `e2e/sweep/routes.ts` (правило 22 в `docs/testing.md`).

## Как запустить локально

Нужен поднятый стек: Postgres, Redis, бэк на `:8000`, comms-заглушка на `:8899`, сид `e2e`.

**Стенд velo-dev** (`~/work/velo-dev`):

```sh
sh ~/work/velo-dev/velo-dev-up.sh
python frontend/e2e/stack/seed_e2e.py && python backend/scripts/set_role.py 607031 A --yes   # один раз; сид -- обёртка: профиль не в seed_profiles/
node frontend/scripts/make-test-skin.mjs frontend/public/skin   # синтетический пакет скина, как в CI (FE-230)
pnpm -C frontend build                                     # сборка для vite preview
pnpm -C frontend e2e:sweep
node frontend/scripts/apply-skin.mjs --remove                    # убрать пакет: следующие сборки и `pnpm dev` идут без него
```

Пакет в `frontend/public/skin` видят все сборки, пока его не убрать; повторный `make-test-skin.mjs` в существующий каталог откажет. Дев-сервер (`vite`) пакет скина не раскладывает: токены скина он применит, а логотипы, онбординг и фон останутся нейтральными файлами ядра (фон пакета — 404). Вид инстанса проверяй сборкой, не дев-сервером.

Чтобы гнать sweep по дев-серверу вместо сборки: `E2E_BASE_URL=http://localhost:5173 pnpm -C frontend e2e:sweep`.

**Отдельный стек** (как в CI) — своя база, свои env (`DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_URL`, `COMMS_API_URL`, `COMMS_SERVICE_TOKEN`, `STORAGE_ENDPOINT`, `STORAGE_SECRET_KEY`, `PRIMER_RELEASE`, `PRIMER_COMMIT`, `ZOOM_RETRY_ENABLED=false`, `ZOOM_REPORT_ENABLED=false` поверх `backend/ci.env` (`SERVER_ROLE=test` и остальные обязательные ключи, BE-192); список — в `env:` job'а):

```sh
# ci.env первым, токен после него: у ci.env свой, и тогда логин в sweep получит 401
set -a; . backend/ci.env; set +a
export TELEGRAM_BOT_TOKEN='e2e:fake'
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

## Визуальное сравнение с базовой веткой (FE-162)

Отвечает на вопрос «что поменялось на экране — и задумано ли это?». Собирает базу PR (`deploy-machine`) и ветку PR, снимает 19 ключевых экранов (390×844, светлая тема; тёмной в приложении пока нет) на одних и тех же данных и выдаёт отчёт только по изменившимся экранам. Эталонов в git нет.

### Строгий режим и метка `visual-change` (FE-234)

Сравнение строгое по умолчанию: любое расхождение хотя бы одного из 19 экранов хотя бы на одном скине (`velo-brand`, `goodo-brand`) валит job `visual — base vs head (<скин>)`, а с ним и `visual — verdict`.

- **Когда запускается.** Само, если PR трогает `frontend/src/styles/`, `variables.css`, `packages/velo-ui/`, `frontend/public/`, любые шаблоны `frontend/src/**/*.vue` (компоненты, экраны, `App.vue`), `pnpm-lock.yaml`, `.github/brand-skins.json` или само сравнение (`.github/workflows/visual.yml`, `frontend/e2e/visual/`, `frontend/playwright.config.ts`, `frontend/e2e/support/settle.ts`). Полный список — `VISUAL` в `.github/scripts/ci-scope.mjs`. PR без этих путей получает зелёный `visual — verdict` без сборки.
- **`visual-change`** — вид меняется намеренно (новый экран, правка вёрстки, подъём тега скина). Метку ставит человек, сверив отчёт с целью задачи; агент её не ставит, как `bundle-growth`. Метка действует, только если поставлена после последнего коммита PR (`.github/scripts/visual-decide.mjs`): после нового пуша сравнение снова строгое, метку ставят заново. С меткой сравнение всё равно идёт, отчёт — доказательство, job зелёный. Снять метку — перезапуск: красный, если расхождение осталось. Между снятием метки и новым `visual — verdict` (около трёх минут) последним остаётся прошлый статус: с мержем в эти минуты не спешить.
- Рефактор, который вид менять не должен (чистка токенов, SVGO, декомпозиция, перенос в кит), метки не ставит: расхождение — найти причину, а не ставить метку.
- Любая метка, поставленная или снятая на открытом PR, перезапускает весь workflow (не только `visual-change`): прогон с неизменным результатом нужен, чтобы статус `visual — verdict` не перекрыл настоящий (FE-206). Основной `CI` метки не слушает (`.github/workflows/visual.yml`).
- **Что требовать.** Только `visual — verdict`: он запускается всегда под одним именем. `visual — base vs head (<скин>)` обязательным делать нельзя: на PR без визуальных путей job пропускается под другим именем, и мерж ждал бы проверку вечно. Админ вносит `visual — verdict` в ruleset по `docs/ci/deploy-machine-ruleset.md`.

### Как читать отчёт

Artifact `visual-out-<скин>` у job `visual — base vs head (<скин>)` (в step summary — список изменившихся экранов). `report.html`: для каждого изменившегося экрана base, head и diff, число отличающихся пикселей. Пустой отчёт — визуально ничего не изменилось. Экран, снятый только с одной стороны, или с другим размером, считается изменившимся.

Локально (из `frontend/`): `node scripts/apply-skin.mjs <пакет> && pnpm build` (с FE-234 CI собирает обе стороны с настоящим пакетом скина — `velo-brand` и `goodo-brand`, по job на скин: вместо `make-test-skin.mjs` — `node scripts/apply-skin.mjs <пакет>`), затем `sh e2e/visual/run.sh <dist-базы> dist`. Базу собрать из `test` отдельным worktree. `VISUAL_STRICT=1` — выходной код 1 при любом отличии (в CI так по умолчанию, без метки `visual-change`).

### Если job упал не на отчёте

Падение со строкой `api: ... net::ERR_FAILED` значит, что приложение запросило то, чего нет в записи: HAR устарел. Перезаписать.

### Как перезаписать HAR

На поднятом стеке с сидом `e2e` (см. «Как запустить локально»): `pnpm -C frontend visual:record`. Скрипт открывает экраны из `e2e/visual/screens.ts` под их ролями и пишет `e2e/visual/har/<роль>.har` и `meta.json` (время записи и пути экранов). Токены и `Authorization` из HAR вычищаются, проверь `git diff` на посторонние данные. Закоммитить все три файла вместе: часы браузера при съёмке стоят на времени записи.

Добавить экран: строка в `e2e/visual/screens.ts` (имя из таблицы sweep) и перезапись HAR.

## Доступность: axe-core на обоих скинах (FE-241)

Проект `a11y` (`frontend/e2e/a11y/`) гоняет axe-core по тем же роутам и ролям, что и sweep, на **одном скине за прогон**: `A11Y_SKIN=gold` (пакет `velo-brand`) или `goodo` (`goodo-brand`). В CI это job `e2e-a11y` (`.github/workflows/e2e-a11y.yml`): отдельный workflow, по ячейке на скин, у каждой свой стек; идёт параллельно с `e2e-stack` и не удлиняет его. Пакеты берутся по закреплённым тегам из `.github/brand-skins.json` (`.github/scripts/fetch-brand-skins.mjs`, общий клон `frontend/scripts/lib/brand-git.mjs`); `BRAND_REPO_TOKEN` передаётся явно.

Правила: WCAG 2.1 A и AA (теги `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) плюс `heading-order` и `label-content-name-mismatch`.

Что не считается нарушением:

- **Пара, объявленная пакетом в `contrastExceptions`** (контракт 2.1): вторичный текст на белой карточке, не ниже 3:1. Пара читается из бренд-записи пакета, не копируется в тест. Любая другая пара и ниже 3:1 остаются нарушением.
- **Строка в `frontend/e2e/a11y/allowlist.ts`**: причина (`reason`) и задача (`task`) обязательны. Контраст держится на паре цветов (`detail`), любое другое правило — на селекторе элемента (`target`, без `nth-child` и хэша `data-v-`); запись без них тест `src/router/a11y-allowlist.test.ts` не пропускает. Правило на роуте целиком не глушится. Исправил — убери строку в том же PR.
- **Запись, которая ничего не покрыла за весь прогон, валит прогон** (`A11Y_STRICT=1` в CI): нарушение ушло, запись должна уйти вместе с ним. Локальный прогон одного теста (`-g`) эту проверку не включает.

Отчёт (`e2e/a11y/report.ts`): в консоль, в `test-results/a11y-report.json` и в summary шага. В нём число проверенных экранов, открытые нарушения, сколько покрыл allowlist (по задачам), сколько снял `contrastExceptions` пакета, неиспользованные записи.

Запуск локально (нужен стек, как для sweep; пакеты — `node .github/scripts/fetch-brand-skins.mjs <каталог>`):

```sh
cd frontend
node scripts/apply-skin.mjs <каталог>/velo-brand/skin && pnpm exec vite build --outDir dist-gold
A11Y_SKIN=gold A11Y_SKIN_DIR=<каталог>/velo-brand/skin VISUAL_DIST=dist-gold \
  pnpm exec playwright test --project=a11y --reporter=list,./e2e/a11y/report.ts
```

Спека сверяет **каждый** цветовой токен пакета (hex и rgba) с тем, что рисует страница: сборка не того скина (или устаревшая) падает с `the build is not the <skin> package`, а не проходит за чужой скин. Без `A11Y_SKIN` проект падает одним тестом, а не пропускается.
