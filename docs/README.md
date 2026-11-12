# docs/ — индекс

Правило папки: сюда попадает reference с явным происхождением и freshness-заголовком; документ удаляется, когда его находки закрыты или описанный код исчез (культура одного текста — `ai-dev-factory-tz.md` п. 8.1). Живые ТЗ продуктовых фич — в корне репо (`tz-*.md`, список ниже), кодексы и спецификации — корень (`VELO-*.md`).

## Где живёт документация

**Документ живёт там, где умирает его предмет.** Если факт теряет смысл вместе с компонентом — он в коде (шапки и комментарии файла: инварианты, семантика состояний, «здесь так, потому что»). Если факт должен пережить переписывание компонента — он здесь: rulings владельца, эталоны-спеки, кросс-модульные контракты, процесс. Текст не дублируется: одна строка-указатель в коде (образец — `binding`-ссылки на `support-sections-integration.md` в `backend/app/modules/support/`), рассуждение — в единственном доме. Задачный контекст (план, AC, отчёты приёмки) живёт в Linear, не в коде и не здесь.

## Фабрика разработки
- `ai-dev-factory-tz.md` — ТЗ фабрики v0.11: конвейер, инфраструктурный слой, фазы 0–6, tgqa, Figma → код.
- `agents/` — реестр managed agents: карточки, TTM-базлайн, трекер фаз (см. `agents/README.md`).
- `frontend/design/` — дизайн-контур фабрики: `component-map.md` (DS-компоненты Vue ↔ узлы Figma-зеркала), `GAPS.md` (что зеркало не выражает), `design.rules.md` (правила дизайн→код, ТЗ п. 11.2).

## Живые ТЗ (корень репо, статус на 2026-11-09)
- `tz-ui-package.md` — кит `@velo/ui`: запись решений (миграция P1–P8 завершена); открыто — P7 (свод витрины FE-122; стандарт Figma FE-154 закрыт 10.11).
- `tz-whitelabel.md` — **единственный живой план** whitelabel, токенов (трек T, §3.3) и контура деплой-машины Праймера; статус и остаток — §9: FE-131, FE-151, FE-133, FE-149 §5/§7, FE-150.
- `tz-i18n.md` — i18n: выполнено (ru/en/uk); остаток — FE-133.
- `tz-curator.md` — школы и кураторы: фронт выполнен, открытое ждёт решений владельца.
- `tz-practice-analytics.md` — аналитика по практике: выполнено (FE-96).

## Конвенции фронта
- `frontend-comments.md` — стандарт комментариев фронта (TSDoc, `i18n:<key>`), проверяется гейтами `pnpm lint`.
- `frontend/docs/en-glossary.md` — единственный источник терминологии для `src/locales/en/**`.
- `packages/velo-ui/README.md` — контракт кита: токены, граница, i18n-шов, Storybook.
- `oauth-consent/` — эталонная вёрстка страницы согласия OAuth «Подключение к VELO» (FE-99; сниппет для бэка, BE-181).

## Контракты и механика (код ссылается или опирается)
- `attendance-accounting.md` — как устроены три оси учёта посещаемости (reference; открытые находки — на доске).
- `support-sections-integration.md` — контракт секций поддержки с comms; **binding**-ссылки в `backend/app/modules/support/*` и в миграции.

## Удалено 2026-09-17 (история в git)
`seed-context.md` (описывал seed-систему до пересоздания репо; истина теперь — `velo seed --profile` + `backend/scripts/seed.py`), `probekit-sweep-2026-08.md` (снапшот-отчёт из git-ignored `.tmp`), `comms-handover-corrections.md` (опровержения к передаче comms; передача состоялась), `support-operator-model.md` (предстроительный рекон; рабочий контракт — `support-sections-integration.md`). Обоснования — в коммите.

## Удалено 2026-09-29 по решению владельца (история в git)
`attendance-accounting.md`, `device-verification-findings.md`, `diary-behaviour-map.md` + `diary-behaviour-spec.md`, `external-activity-frontend-task.md`, `t26-notification-prefs-recon.md`, `deliberately-not-fixed.md`, `owner-parked-roadmap.md`, `owner-decisions-2026-07-25.md`, `number-key.md`, `primer-b35-doctor-gate.md` — массовая чистка не-фабричных доков (ruling владельца 2026-09-29); обоснование — в коммите. `voice-input-frontend-task.md` снят с индекса: файла в репо уже не было на момент чистки — висячие ссылки из `useVoiceRecorder.ts`/`constants.ts` восстановить или снять при FE-75 Шаге 2. Намеренно остался: `support-sections-integration.md` — живой контракт с binding-ссылками из бэкенда (`support/service.py:8`, `models.py:23`, миграция `ab1c2d3e4f5a`); файлы бэка вне зоны FE-агента — перенос контракта в шапку `service.py` и удаление документа делегированы бэкенду (BE-91).
