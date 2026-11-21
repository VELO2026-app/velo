# Поставка velo: ветки, PR, стенды, CI

> Правила поставки. Документ меняют вместе с предметом: той же поставкой, что меняет ветки, задания CI или контракт с машиной. Блок «Состояние» в конце датирован и устаревает первым. Версии соседей здесь не повторяются: источник — `primer.lock`, закрепление самой машины — `.github/workflows/primer-check.yml`. Выкат, `primer.yaml` и паспорт — канон в Linear-документах (PRIMER-PROTOCOL, контракт 3); этот файл — пересказ, при расхождении правится протокол, не он.

## Ветки

- **deploy-machine** — единственная рабочая ветка и ветка по умолчанию в репозитории (`origin/HEAD`): весь продукт, бэк и фронт. `test` слит в неё 12.11.2026 (`1f65faca`, BE-208). Ночной обход e2e (`e2e-stack.yml`: schedule на ветке по умолчанию) и Dependabot смотрят на неё же.
- **test** — заморожен на `44083fba`; в него больше ничего не вливается. Его продолжает выкатывать шелл-стенд, пока не встанет velo-test.
- **main** — прод на шелле до переноса прода на машину. Его не трогаем.

## PR и коммиты

- Изменение доезжает PR'ом в `deploy-machine`; слияние — на GitHub кнопкой «Create a merge commit» (история — сплошь `Merge pull request #…`), не squash.
- В каждом коммите после пустой строки — трейлер `Task: <код задачи>` (например `Task: FE-189`), одним блоком с `Co-Authored-By`. Машина берёт из него задачу коммита: красный выкат блокирует стенд задачей своего коммита.
- Ветки после мержа не удаляются: PR ставятся друг на друга стопками.
- Перед мержем — `gh pr update-branch <номер>`: база вливается в ветку, CI перегоняет её ещё раз.

## Стенды и серверы

- **Шелл-стенд** (`velotony.com`, `api.velotony.com`) — замороженный `test` под `velo update` (`scripts/velo-manage.sh`; стенд выкатывает только `test` — шапка `backend-tests.yml`). Живой, но стареющий: эталон, пока не встанет velo-test.
- **velo-test** — первая установка velo машиной Праймера: роль test, dev-сервер (`zxcvbnm.beer`, `loadtest/README.md`), ставится по ветке `deploy-machine`.
- **Прод** — `main`, на шелле. Перенос прода на машину — после зелёного velo-test: репетиция на копии дампа, паспорт прода, релизный тег `vX.Y.Z` (прод машина ставит только по тегу).

## CI на deploy-machine

Полные правила — в шапках самих workflow; здесь карта.

- **«CI»** (`.github/workflows/ci.yml`) — гейт поставки. Джоб `scope` классифицирует диф: docs-only PR зелёный за секунды, бэкенд-диф не гоняет frontend-джобы, push классифицируется как PR (FE-187). Дальше: lint (нулевой бюджет предупреждений), format, typecheck, test (3 шарда) + `test-report` (coverage-рейтчет `frontend/coverage-budget.json` — полы только растут), test-other (`@velo/ui`), build (+ бюджет бандла, правила — `docs/agents/bundle.md`), e2e (Playwright smoke, моки API), e2e-stack (обход всех роутов на живом бэке, пока advisory), matrix (сборочная матрица whitelabel, по ячейке на раннер), image (docker build + smoke `/config.json`, `/health`), drift-check (`generated.ts` регенерируется, дрейф красный).
- **«Backend tests»** (`backend-tests.yml`) — сьюта бэка на живых Postgres, Redis и RustFS (BE-197). Временный: удаляется, когда velo-test сам гоняет тесты перед каждой миграцией.
- **«Primer check»** (`primer-check.yml`) — `pridem check`: репо глазами машины (`primer.yaml`, `primer.lock`, compose стеков). Идёт на каждый PR, без paths-фильтра.
- **«e2e sweep»** (`e2e-stack.yml`) — ночной обход в 02:30 UTC на ветке по умолчанию, Chromium + WebKit; руками — «Run workflow». Инструкция — `docs/agents/e2e.md`.
- **«Visual»** (`visual.yml`) — пиксельная сверка base vs head, информационная: красная только с меткой `no-visual-change`.
- **«Codec vector»** (`codec-vector.yml`) — сверка двух таблиц кодека (бэк и фронт), по paths-фильтру.
- **«token-sync»** (`token-sync.yml`) — спит с 2026-11-09 (решение владельца): истина токенов — код, Figma — зеркало.

## Фронт под машиной Праймера

- Образ фронта собирает машина при установке из репозитория (`frontend/Dockerfile`). Значения инстанса приходят при старте контейнера в `/config.json`: домены, языки, шесть флагов опций `OPTION_*` (`primer.yaml: options`; `telegram` обязателен).
- Типы API генерирует и машина: секция `types` в `primer.yaml`, на роли test она коммитит их ключом `velo-types`. Пока в CI жив drift-check, изменение API приносит перегенерированный `frontend/src/api/generated.ts` в той же поставке.
- Редакция одна — `ai` (`editions.json`): что видно на экране, решают флаги опций, а не редакции.
- Скин — слот `packages.skin`, контракт `>=2,<3` (`SKIN_CONTRACT_MAJOR = 2`), необязательный: без пакета в паспорте собирается золотая VELO.
- Тексты инстанса — слот `packages.texts`, `apply: runtime`: пакет монтируется в `/srv/texts`, nginx отдаёт `/texts/ui/`, валидация — `validate-texts`. Оверлей писем comms не принимается.
- Вход: Mini App — токен бота (шов от comms, `TELEGRAM_BOT_TOKEN`); браузер — OIDC (`TELEGRAM_LOGIN_CLIENT_*` — ключи клиента из паспорта).

## Состояние на 2026-11-21

- `deploy-machine` — ветка по умолчанию; все открытые PR (сейчас 6) в неё. `test` заморожен (`44083fba`) и слит 12.11 (`1f65faca`).
- Sweep в CI ещё advisory (`ci.yml` → `e2e-stack`). После FE-222 (PR #162, открыт): сводный джоб `CI — gate` станет единственной обязательной проверкой `ci.yml`, sweep — блокирующим; рядом готовится ruleset ветки (в том PR; применяет админ).
- Соседи: comms закреплён в `primer.lock`; машина — тегом и sha256 в `primer-check.yml` (письмо Праймера 17.11). velo-test ждёт выката на dev-сервер; его прогресс — в Linear, не в репо.
