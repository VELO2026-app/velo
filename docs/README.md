# docs/ — индекс

Правило папки: сюда попадает reference с явным происхождением и freshness-заголовком; документ удаляется, когда его находки закрыты или описанный код исчез (культура одного текста — `ai-dev-factory-tz.md` п. 8.1). Живые ТЗ продуктовых фич — в корне репо (`tz-curator-groups.md`), кодексы и спецификации — корень (`VELO-*.md`).

## Где живёт документация

**Документ живёт там, где умирает его предмет.** Если факт теряет смысл вместе с компонентом — он в коде (шапки и комментарии файла: инварианты, семантика состояний, «здесь так, потому что»). Если факт должен пережить переписывание компонента — он здесь: rulings владельца, эталоны-спеки, кросс-модульные контракты, процесс. Текст не дублируется: одна строка-указатель в коде (образец — `binding`-ссылки на `support-sections-integration.md` в `backend/app/modules/support/`), рассуждение — в единственном доме. Задачный контекст (план, AC, отчёты приёмки) живёт в Linear, не в коде и не здесь.

## Фабрика разработки
- `ai-dev-factory-tz.md` — ТЗ фабрики v0.11: конвейер, инфраструктурный слой, фазы 0–6, tgqa, Figma → код.
- `agents/` — реестр managed agents: карточки, TTM-базлайн, трекер фаз (см. `agents/README.md`).
- `frontend/design/` — дизайн-контур фабрики: карта компонентов DS (37 + 81 иконок) и правила дизайн→код (ТЗ п. 11.2).

## Контракты и механика (код ссылается или опирается)
- `support-sections-integration.md` — контракт секций поддержки с comms; **binding**-ссылки в `backend/app/modules/support/*` и в миграции.

## Удалено 2026-09-17 (история в git)
`seed-context.md` (описывал seed-систему до пересоздания репо; истина теперь — `velo seed --profile` + `backend/scripts/seed.py`), `probekit-sweep-2026-08.md` (снапшот-отчёт из git-ignored `.tmp`), `comms-handover-corrections.md` (опровержения к передаче comms; передача состоялась), `support-operator-model.md` (предстроительный рекон; рабочий контракт — `support-sections-integration.md`). Обоснования — в коммите.

## Удалено 2026-09-29 по решению владельца (история в git)
`attendance-accounting.md`, `device-verification-findings.md`, `diary-behaviour-map.md` + `diary-behaviour-spec.md`, `external-activity-frontend-task.md`, `t26-notification-prefs-recon.md`, `deliberately-not-fixed.md`, `owner-parked-roadmap.md`, `owner-decisions-2026-07-25.md`, `number-key.md`, `primer-b35-doctor-gate.md` — массовая чистка не-фабричных доков (ruling владельца 2026-09-29); обоснование — в коммите. `voice-input-frontend-task.md` снят с индекса: файла в репо уже не было на момент чистки — висячие ссылки из `useVoiceRecorder.ts`/`constants.ts` восстановить или снять при FE-75 Шаге 2. Намеренно остался: `support-sections-integration.md` — живой контракт с binding-ссылками из бэкенда (`support/service.py:8`, `models.py:23`, миграция `ab1c2d3e4f5a`); файлы бэка вне зоны FE-агента — перенос контракта в шапку `service.py` и удаление документа делегированы бэкенду (BE-91).
