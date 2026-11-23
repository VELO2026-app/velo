# Поставка velo: ветки, PR, стенды, CI

Версия 1.1, 22.11.2026, FE-227 (версия 1 — 21.11.2026, FE-189).

> Правила поставки. Документ меняют вместе с предметом: той же поставкой, что меняет ветки, задания CI или контракт с машиной. Блок «Состояние» в конце датирован и устаревает первым. Версии соседей здесь не повторяются: источник — `primer.lock`, закрепление самой машины — `.github/workflows/primer-check.yml`. Выкат, `primer.yaml` и паспорт — канон в Linear-документах (PRIMER-PROTOCOL, контракт 3); этот файл — пересказ: при расхождении прав протокол, правится этот файл.

## Ветки

- **deploy-machine** — единственная рабочая ветка и ветка по умолчанию в репозитории (`origin/HEAD`): весь продукт, бэк и фронт. `test` слит в неё 12.11.2026 (`1f65faca`, BE-208). Ночной обход e2e (`e2e-stack.yml`: schedule на ветке по умолчанию) и Dependabot смотрят на неё же.
- **test** — заморожен на `44083fba`; в него больше ничего не вливается.
- **main** — прод на шелле; меняется только переносом прода на машину.

## PR и коммиты

- Фронт доезжает PR'ом в `deploy-machine`, слияние — кнопкой «Create a merge commit» (не squash). Бэк пока пушит в ветку напрямую — защиты ветки нет до ruleset из FE-222.
- В каждом коммите после пустой строки — трейлер `Task: <код задачи>` (например `Task: FE-189`), одним блоком с `Co-Authored-By`. Это практика проекта.
- Ветки после мержа не удаляются: PR ставятся друг на друга стопками.
- Перед мержем — `gh pr update-branch <номер>`, чтобы база вливалась в ветку и CI перегонял её ещё раз (практика оркестратора, не защита репозитория).

## Стенды и серверы

- **Серверы машины** -- velo с comms ставит машина Праймера (DM-23, письмо Праймера 22.11): velo-dev (`zxcvbnm.beer` -- сервер `dev` из `loadtest/README.md`) и goodo-test (`velotony.com`). Шелл-деплоя в `deploy-machine` нет (BE-238): сервер трогают только `pridem` и глаголы `primer.yaml`.
- **Прод** — `main`, на шелле. Перенос прода на машину — после зелёного velo-test: репетиция на копии дампа, паспорт прода, релизный тег `vX.Y.Z` (прод машина ставит только по тегу).

## CI на deploy-machine

Полные правила — в шапках самих workflow; здесь карта.

- **«CI»** (`.github/workflows/ci.yml`) — гейт поставки; состав джобов и правила — в шапке файла. Неочевидное: docs-only PR зелёный за секунды (`scope`), coverage-рейтчет — `frontend/coverage-budget.json`, бюджет бандла — `docs/agents/bundle.md`, smoke образа проверяет `/config.json` и закрытые `/health`, `/ready` (404), sweep пока advisory.
- **«Bundle budget»** (`bundle-budget.yml`) — метки бюджета: поднятый бюджет — `bundle-growth`, поднятый потолок — `bundle-ceiling`. После FE-222 guard становится обязательной проверкой.
- **«Backend tests»** (`backend-tests.yml`) — сьюта бэка на живых Postgres, Redis и RustFS (BE-197). Временный: удаляется, когда velo-test сам гоняет тесты перед каждой миграцией.
- **«Primer check»** (`primer-check.yml`) — `pridem check`: репо глазами машины (`primer.yaml`, `primer.lock`, compose стеков). Идёт на каждый PR, без paths-фильтра.
- **«e2e sweep»** (`e2e-stack.yml`) — ночной обход в 02:30 UTC на ветке по умолчанию, Chromium + WebKit; руками — «Run workflow». Инструкция — `docs/agents/e2e.md`.
- **«Visual»** (`visual.yml`) — пиксельная сверка base vs head, информационная: красная только с меткой `no-visual-change`.
- **«Codec vector»** (`codec-vector.yml`) — сверка двух таблиц кодека (бэк и фронт), по paths-фильтру.
- **«token-sync»** (`token-sync.yml`) — спит с 2026-11-09 (решение владельца): истина токенов — код, Figma — зеркало.

## Фронт под машиной Праймера

Контракт рантайма — [`tz-whitelabel.md`](../tz-whitelabel.md) и `primer.yaml`; здесь — карта поставки.

- Образ фронта собирает машина при установке из репозитория (`frontend/Dockerfile`). Значения инстанса приходят при старте контейнера в `/config.json`: адрес API и бота, языки, опции (шесть флагов `OPTION_*`, `telegram` обязателен — `primer.yaml: options`).
- Типы API генерирует и машина: секция `types` в `primer.yaml`, на роли test она коммитит их ключом `velo-types`. Пока в CI жив drift-check, изменение API приносит перегенерированный `frontend/src/api/generated.ts` в той же поставке.
- Редакция одна — `ai` (`editions.json`): что видно на экране, решают флаги опций, а не редакции.
- Пакеты инстанса — слоты `primer.yaml: packages`: скин (контракт `>=2,<3`, необязательный: без пакета в паспорте — золотая VELO) и texts (`apply: runtime`, `/srv/texts`, `/texts/ui/`). Пакет texts может нести `comms/**`, но машина его пока не монтирует (`primer.yaml`).
- Место скина в сборке — `frontend/public/skin` от корня репозитория (контекст сборки фронта). Пакет из приватного репозитория машина читает своим ключом развёртывания (deploy key только на чтение, DM-127): публичность репозитория пакета ей не нужна.

### Проверка пакета скина до выката

Так же, как машина при `apply: build`: пакет целиком в место сборки, затем сборка образа фронта. Команды — из корня репозитория; `<пакет>` — **абсолютный** путь к каталогу пакета на нужном теге (у `goodo-brand` — его `skin/`): `apply-skin.mjs` ищет его от текущего каталога, а первая команда — `cd frontend`.

```sh
cd frontend
node scripts/apply-skin.mjs <пакет>          # = pnpm skin: копия целиком + validate-skin
PRIMER_EDITION=ai pnpm build                 # validate-skin --build первым шагом
grep -o '"name":"[^"]*"' dist/manifest.webmanifest   # имя бренда, не VELO
cd ..
docker build -f frontend/Dockerfile --target runtime --build-arg PRIMER_EDITION=ai \
  --build-arg PRIMER_RELEASE=skin-check --build-arg PRIMER_COMMIT=$(git rev-parse HEAD) -t velo-frontend:skin-check .
docker run --rm -d --name skin-check --add-host app:127.0.0.1 -p 18080:3000 \
  -e API_BASE_URL= -e TELEGRAM_BOT_URL=https://t.me/example_bot -e LANGUAGES=en,ru,uk -e DEFAULT_LANGUAGE=en \
  -e OPTION_PAYMENTS=true -e OPTION_SCHOOLS=true -e OPTION_MCP=true -e OPTION_ZOOM=true -e OPTION_TELEGRAM=true -e OPTION_LLM=true \
  velo-frontend:skin-check
curl -s localhost:18080/manifest.webmanifest       # name, theme_color пакета
docker rm -f skin-check
node frontend/scripts/apply-skin.mjs --remove      # назад к золотой сборке
```

`--add-host app:127.0.0.1` нужен только для проверки: nginx фронта при старте ищет upstream `app`. Пакет в `frontend/public/skin` игнорируется git (`frontend/.gitignore`).

## Состояние на 2026-11-22

- `deploy-machine` — ветка по умолчанию; все PR идут в неё. `test` заморожен (`44083fba`) и слит 12.11 (`1f65faca`).
- С FE-222 sweep блокирующий (`ci.yml` → `e2e-stack`), сводный джоб — `CI — gate`. Ruleset ветки на 22.11 не применён (`deploy-machine` не защищена): его применяет админ по `docs/ci/deploy-machine-ruleset.md`.
- Соседи: comms закреплён в `primer.lock`; машина — тегом и sha256 в `primer-check.yml` (`v0.1.8`, письмо Праймера 23.11). Серверы на машине (velo-test, инстанс Goodo) и их прогресс — в Linear (DM-23, DM-114), не в репо.
- 22.11, FE-227: `deploy-machine` на `f3fa1471` собирается со скином `goodo-brand` `v0.2.0` по проверке выше (validate-skin — 0 отказов; образ фронта отдаёт манифест и `<title>` Goodo, `theme_color` `#120054`, иконки пакета — заглушки v0.2.0, перекрашенные знаки VELO). Серверный инстанс Goodo — в Linear (DM-114).
