# Ревью по уровню риска

Ruling владельца 2026-11-27 (FE-279). Каждый PR несёт уровень ревью R1, R2 или R3. От уровня зависит, сколько читает ревьюер: от «проверено тем, что работает» до каждой строки. Минимальный уровень по диффу считает CI (`.github/scripts/risk-floor.mjs`, задание `review risk floor`), и понизить его нельзя.

## Уровни

### R1 · проверено тем, что работает

Входит, если **все** файлы диффа из этого списка:
- проза и картинки в `docs/**`, `diagrams/**`, `Design_prototype/**`, `*.md` в корне — кроме документов-правил (ниже);
- `*.css`, тексты `frontend/src/locales/**/*.json`, `frontend/tokens.json`, картинки и шрифты `frontend/public/**`;
- тесты (`*.test.ts`, `*.test.mjs`, `frontend/e2e/**/*.spec.ts`), кроме тестов гейтов в `.github/scripts`, `frontend/scripts`, `frontend/eslint-rules`;
- правки `.vue` на 150 изменённых строк или меньше в сумме по PR;
- сокращение allowlist e2e.

Ревью-треда нет. Перед мержем проверить:
1. CI зелёный, `visual — verdict` зелёный.
2. В PR есть доказательство: картинки gold и goodo для UI, вывод теста для логики.
3. Нет признаков ослабленных проверок: удалённых `expect`, `skip`, поднятых бюджетов.

Каждый 5-й влитый PR уровня R1 получает полное ревью уровня R2. Это выборочный контроль: он показывает, не занижают ли уровень.

### R2 · одно независимое ревью поведения

Уровень по умолчанию: всё, что не R1 и не R3. Сюда входят экраны, composables, сторы, кит `velo-ui` и скрипты сборки без секретов. Сюда же входят **документы-правила**, которые агенты исполняют как код: `docs/delivery.md`, `docs/testing.md`, `docs/figma-protocol.md`, `docs/frontend-comments.md`, этот файл, `docs/agents/**`, `docs/ci/**`, шаблон PR и `tz-*.md`.

Ревью делает отдельный тред-ревьюер, а не автор и не оркестратор: собственное ревью оркестратора пропустило major-находки в #141–#143. Ревьюер прослеживает изменённые асинхронные ходы и переходы состояния. Он проверяет, что тесты покраснеют при регрессии. Шаблоны и тесты он читает выборочно. Правки после ревью сверяет через `git range-diff`.

### R3 · построчно

Входит, если дифф трогает чувствительную зону (таблица ниже) или изменение необратимо: строка `**Дверь:** односторонняя` в PR сама поднимает минимум до R3. Понизить уровень нельзя.

1. Ревьюер читает **каждую изменённую строку** в чувствительных файлах. В итоге ревью он перечисляет эти файлы. Остальной дифф он ревьюит как R2.
2. Ревьюер сам запускает тесты и разбирает сценарий отказа: ошибка сети, повтор, чужая роль, пустой ответ.
3. Обратимое изменение (откат ревертом) вливает оркестратор после чистого построчного ревью. Необратимое — только по слову владельца. Необратимое — это смена формата кэша, хранилища или service worker на устройстве, удаление данных, внешний контракт, публикация. Поле «Дверь» в шаблоне PR называет его «односторонняя».

Совет исполнителю: выносите чувствительную часть в отдельный маленький PR. Тогда построчно читать придётся десятки строк, а не тысячи.

## Чувствительные зоны

Источник правды — `SENSITIVE` в `risk-floor.mjs`. Таблица — его пересказ. Тест зоны (`*.test.ts`, `*.test.mjs`, `e2e/**/*.spec.ts`) уровень не поднимает. Исключение — тесты гейтов (`.github/scripts`, `frontend/scripts`, `frontend/eslint-rules`). Маски вида `*payout*` действуют внутри `frontend/src/**` для `.vue` и `.ts`.

| Зона | Что поднимает до R3 |
|---|---|
| Авторизация и сессия | `platform/{session,session-token,session-memo,browser-login,telegram,telegram-sdk,launch,standalone}.ts`, `stores/auth.ts`, `composables/{useAuth,useRoleFreshness}.ts`, `router/{guards,deepLinks}.ts`, `views/auth/TelegramLoginView.vue`, `api/{client,idempotent,mcpTokens}.ts` |
| Деньги | `api/{payments,promos}.ts`, `stores/balance.ts`, `utils/{commission,currency}.ts`, `components/console/finance/**`, файлы `*payout*`, `*withdraw*`, `*payment*`, `*balance*`, `*promo*`, `*finance*`, `*revenue*`, `*wallet*` |
| Данные пользователя | `platform/{error-reporter,sw-caches}.ts`, `composables/{persistedCache,useFormDraft}.ts`, `composables/queries/persist.ts`, `pwa/precache-shell.ts` |
| Безопасность | `frontend/index.html` (CSP), `frontend/nginx*`, `utils/textHighlight.ts`, добавленный `v-html` или `innerHTML` в `.vue` и `.ts` (кроме тестов) |
| Секреты | добавленная строка с `*_TOKEN`, `*_PAT`, `*_KEY`, `*_SECRET` или `secrets.` вне исходников приложения (`frontend/src`, `packages/*/src`) и вне тестов |
| Внешние пакеты скина и текстов | пин `.github/brand-skins.json`, `platform/{skin,skin-virtual,texts}.ts`, `locales/overlayShape.ts`, `scripts/{validate-skin,validate-texts}.mjs`, `scripts/lib/{skin-package,texts-package,brand-packages,brand-git}.mjs` |
| Сами проверки | рост или удаление allowlist e2e; логика allowance e2e; любая правка `e2e/sweep/routes.ts` (в строках маршрутов живут разрешения сбоев `allow:`, в `fillPath` — логика, которая выбрасывает маршрут); `{vitest,playwright}.config.ts`, `eslint.config.js`, `eslint-rules/**`, `frontend/.husky/**`; скрипты гейтов в `frontend/scripts` (бюджеты, `brand-grep`, `token-audit`, `build-log-gate`, `verify-quick`, `spec-coverage` и его baseline и др.), их логика в `frontend/scripts/lib/{token-audit,build-log-gate,bundle-budget,duration-shard}.mjs` и тесты `frontend/scripts/lib/*.test.mjs`; рост `lint-budget.json` и `bundle-budget.json`, снижение `coverage-budget.json`, удалённое число, удалённый файл или битый JSON бюджета |
| CI, сборка, деплой | `.github/workflows/**`, `.github/scripts/**` (включая сам `risk-floor.mjs` и `review-risk.yml`), `frontend/Dockerfile`, `docker-compose*`, `primer.{yaml,lock}`, `editions.json`, `{frontend,packages/velo-ui}/vite.config.ts`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| Бэкенд | `backend/**` |

Если ревьюер видит риск, которого таблица не ловит, он поднимает уровень вручную. Пример — экран, который сохраняет весь объект по PUT или PATCH (#191).

## Кто ставит уровень и как он виден

- **Исполнитель** пишет строку в разделе «Риск мержа» описания PR: `**Ревью:** R2 — почему`. Для R3 он называет зону.
- **CI** (`review risk floor`) пересчитывает уровень на каждый push, правку описания и смену меток. Правила он берёт из базовой ветки: PR, который правит `risk-floor.mjs`, оценивается прежними правилами. Он ставит метку `review:R1`, `review:R2` или `review:R3` — наибольший из заявленного и минимума; метку ставит CI, вручную её не меняют (ручная правка сразу перевыставляется). Он краснеет, если заявлено ниже минимума, и называет файлы, которые подняли уровень. Без строки PR считается R2.
- **Мерж-гейт оркестратора** не верит метке на слово: он сам пересчитывает уровень правилами из `deploy-machine`, а красная `review risk floor` его останавливает.
- **Поднять** уровень может исполнитель, ревьюер или оркестратор: правкой строки, с причиной комментарием в PR.
- **Понизить** ниже минимума не может никто. Если путь попал в зону зря, зону правят отдельным PR в `risk-floor.mjs` и в этой таблице; такой PR сам уровня R3.

## Если уровень занизили

- **До мержа.** Уровень поднимают, ревью начинается заново на новой глубине. В PR пишут строку «уровень поднят: причина».
- **После мержа.** Баг из PR уровня R1 или R2 поймало бы ревью уровня выше. PR с исправлением добавляет путь или признак в `SENSITIVE` и в таблицу выше. Список зон учится на пропусках.
