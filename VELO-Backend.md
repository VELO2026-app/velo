# VELO — Бэковый Кодекс

**Версия:** 2.0
**Дата:** 20 июня 2026
**Статус:** Active
**Тесты:** 615 passed, 12 skipped  

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> STALE-BUT-HARMLESS overall — NOT rewritten this round; the test count in the header above
> is UNVERIFIED against current `test` (live TEST box is 802 collected / 790 passed / 12
> skipped, but that number belongs to the whole suite at a later date, not a re-run of this
> doc's claim). Four spots were checked and corrected this pass: §1.1 module map (was 14,
> missing `library`; now 15), the `/admin/consistency` endpoint listing, the payout-seed
> semaphore note, and §6 (data-consistency semaphores — removed 2026-07-07). Everything else
> is UNVERIFIED as of this pass.

> **v2.0 (E3 серии + E7 период-статы + аудит F8, 20 июня 2026):** Бэковый Кодекс
> синхронизирован — тело уже отражало E3/E7/F8, шапка отставала (была v1.9/564).
> **E3** — recurrence/серии (§3.13): `recurrence: RecurrenceSpec` на `POST /practices`,
> `recurrence_days`/`total_sessions`/`completed_sessions` на карточке,
> `CancelPracticeRequest.scope`; без миграций (всё в `data.recurrence` +
> существующий `parent_practice_id`). **E7** — период-сетки `GET /masters/me/stats`
> + `GET /admin/stats/overview`; `core/periods.py` стал единым источником границ
> периода и `delta_pct`/`delta_pp` (finance/revenue/metrics перерефакторены на него,
> числа не изменены). **Аудит F8 (по `test`)** — закрыт: W-1 (вырожденный `until_date`
> -> 400 на ПУБЛИКАЦИИ), W-3 (один diary-timestamp при bulk-отмене), W-2 (тест
> completed-root), S-1/S-1c (публичные diary-хелперы + единый `users.display_name`).
> Тесты 564 -> 615. Детали — §2, §3.13, §9.

> **v1.9 (P0 frontend-backlog эпики + внешний код-ревью + #3, 20 июня 2026):**
> закрыт весь P0 фронт-бэклога и пройдено внешнее код-ревью ветки `test`.
> **Эпики (LIVE на `test`):** E1 — именованные отзывы `GET /practices/{id}/reviews`
> (+ фильтр `attention`); E2 — доход/лента мастера `GET /masters/me/income?period`
> + `GET /masters/me/transactions` (миграция `9f1e2d3c4b5a`: `title` +
> `counterparty_id` в `master_ledger`); E5 — CRM `GET /masters/me/students` (+`/{id}`);
> E9 — admin-оверсайт `GET /admin/metrics/check-in|feedback|return`,
> `GET /admin/revenue`, `GET /admin/practices` (+`/{id}` + roster) + seed-выводы
> для населения payout. **#3** — cross-practice лента отзывов мастера
> `GET /masters/me/reviews?attention=` (новое поле `practice_title`).
> **Внешний код-ревью (0 critical, 7/10):** W-1 — явка теперь засчитывается и по
> PRE-чек-ину (не только Zoom-join) в общем ядре `_finalize_practice_core` (оба
> пути; разблокировало feedback/E1 при выключенном Zoom); W-3 — feedback-метрика
> ≤100% (числитель привязан к тем же attended-броням); W-2 — докстринги income
> переписаны под реальную семантику «gross booked turnover» (числа не тронуты);
> W-4 — громкий security-WARNING при `role_switch_enabled=True` (env-гейт
> невозможен: `app_env` бинарный, TEST сам prod-grade); S-1 — `delta_pct` только
> при `prev_income > 0`; S-3 — фоллбэк имени мастера в admin revenue → «Мастер».
> **Авто-финализация** в проде давно работает по `end + buffer` (15 мин), а не по
> 24ч-потолку (см. обновлённый блок-итерацию в §9). Тесты 481 -> 564. Детали — §2,
> §9.

> **v1.8 (Check-in / feedback неизменяемы, 3 июня 2026):** чек-ин и фидбэк —
> зафиксированные точки данных для анализа; создаются один раз и не меняются.
> Ранее повторный `POST /practices/{id}/checkin` (и `/feedback`) шёл в
> update-ветку `upsert_checkin` / `upsert_feedback` и **перезаписывал**
> `mood`/`comment` (`rating`/`comment`) — это уничтожало исходную запись.
> Update-ветка удалена: при уже существующей записи сервис возвращает
> **`409 Conflict`**, перезаписи нет. Гонка двух одновременных первых POST
> закрыта паттерном **P-05** (`try/except IntegrityError` снаружи
> `begin_nested`, ERR-05) — проигравший unique-constraint получает тот же
> `409`, а не `500`. Первый POST в окне по-прежнему создаёт запись (`200`).
> Записи дневника (`note`/`dream`, `PATCH /diary/{id}`) остаются
> редактируемыми. Изменены `diary/{service,router,models}.py`; тесты
> `test_checkin_upsert_update` / `test_feedback_upsert_update` заменены на
> `test_*_resubmission_rejected`. Детали — §2 (Diary).

> **v1.7 (Attendance enrichment для master prep, 2 июня 2026):** `GET
> /api/v1/practices/{id}/attendance` (master-only) обогащён под экран
> подготовки мастера: каждый item теперь несёт `user_display_name` /
> `user_avatar_url` участника и его PRE-чек-ин `checkin { mood, comment }`
> (если оставлен), иначе `null`. Новая схема `AttendanceCheckinResponse`.
> `get_attendance` батч-грузит участников (`User.id IN`) и PRE-чек-ины через
> новую `diary/service.py::get_pre_checkins_for_bookings` (`booking_id IN`) —
> два запроса, без N+1. **Приватность:** PRE-чек-ин участника осознанно открыт
> владельцу практики и ТОЛЬКО внутри attendance этой практики (ownership →
> P-08 → 404 чужому); глобальная приватность `/users/me/checkins` не тронута.
> Поле `master_request`/эндпоинт сохранения запроса НЕ добавлялись: диалог
> юзер ↔ мастер — отдельная фича (TD-ASK-MASTER), вне MVP. +6 тестов
> (`test_attendance.py`, 63xxx). Детали — §2 (Bookings), §3.12.

> **v1.6 (Профиль пользователя + аудит-фиксы, 29 мая 2026):** реализован раздел
> «Профиль» (Figma `F7PD5isLfLdyc0q1Bd5n5c`, node `4715-3463`). Бэк-часть:
> новые поля профиля `phone` / `bio` и настройки `notifications` живут в
> `User.credentials` JSONB (schema-on-read, тот же паттерн, что
> `onboarding_completed` — см. §3.7 и новый §3.11); новый эндпоинт статистики
> `GET /api/v1/bookings/me/stats` (`UserStatsResponse`, ORM-агрегат COUNT+SUM по
> attended-броням) и `DELETE /api/v1/users/me` (MVP-семантика — сброс онбординга,
> не удаление, см. §3.11). Аудит ветки (W-1): `update_practice` теперь ре-валидирует
> `style` против СОХРАНЁННОГО `direction` при PATCH без direction (переиспользует
> `_validate_style_for_direction` — закрыто и S-5; +3 теста W-4). W-3 (replay-окно
> initData) и S-3 (banker's rounding в `hours_attended`) — осознанно не код
> (см. §9). Тесты 446 -> 480. Детали — §2, §3.8, §3.11.

> **v1.5 (Calendar flow 4-7 + master public, 24 мая 2026):** добавлен публичный
> профиль мастера `GET /api/v1/masters/{user_id}` (схема `MasterPublicResponse` —
> только публичные поля, без финансов/контактов; verified-only или 404 по P-08;
> два live-COUNT practices/reviews) + `master_avatar_url` в детали практики;
> найден и устранён root-cause флака теста доставки уведомлений — фоновый
> процессор гонялся с ручными `_stage_*` в тестах; введён флаг
> `notification_processor_enabled` (§5.2). +11 тестов master_public (диапазон
> `telegram_id` 56xxx). Детали — §3.9 (master public), §5.2 (processor toggle), §8.
> Аудит итерации (24 мая): 0 critical / 0 warning, 3 suggestion (все обработаны).

> **v1.4 (Calendar iteration, 22 мая 2026):** Practice получил JSONB-колонку `data`
> с taxonomy-песочницей (direction / difficulty / style); публичный фид расширен
> фильтрами по таксономии, длительности и времени суток + per-user флагами
> `is_booked` / `is_paid`; 13 новых тестов. Детали — §2 (Practices), §3.1, §3.8.
> Аудит итерации: C-1 ✅, W-2 ✅ устранены; W-1 (Stripe startup-валидатор) — в техдолге (§9).

---

## 1. Модули

### 1.1. Карта модулей  

| Модуль | Путь | Назначение |
|--------|------|------------|
| `auth` | `app/modules/auth/` | Telegram WebApp auth, сессии Redis |
| `users` | `app/modules/users/` | Профили юзеров, роли |
| `masters` | `app/modules/masters/` | Профили мастеров, верификация, балансы, выводы |
| `practices` | `app/modules/practices/` | CRUD практик, state machine |
| `bookings` | `app/modules/bookings/` | Бронирования, посещаемость |
| `waitlist` | `app/modules/waitlist/` | Очередь ожидания |
| `payments` | `app/modules/payments/` | Stripe, пополнение баланса |
| `promos` | `app/modules/promos/` | Промокоды (Company + Master) |
| `withdrawals` | `app/modules/withdrawals/` | Запросы на вывод средств |
| `reports` | `app/modules/reports/` | Жалобы пользователей |
| ~~`notifications`~~ | ~~`app/modules/notifications/`~~ | **REPLACED `PROMPT №679`, 2026-08-12 — module deleted, tables dropped.** See the three rows below. |
| `core/events` | `app/core/events/` | Transactional outbox: emit + relay to an external comms microservice via Redis Stream |
| `comms_proxy` | `app/modules/comms_proxy/` | In-app notification bell (unread feed, read/read-all) |
| `chats` | `app/modules/chats/` | Real one-to-one messaging (threads, messages, unread-count) |
| `diary` | `app/modules/diary/` | Check-ins, feedbacks, diary entries, insights; append-only `DiaryEvent` journal (`models.py`) + `projections.py` (единственный писатель журнала) + единая лента `GET /diary/feed` (cursor) |
| `curator_groups` | `app/modules/curator_groups/` | Школы (кураторские группы). Куратор — НЕ участник: связь выводится из `curator_group.curator_user_id` (I-2), строки участия нет. Пять своих таблиц: `curator_group`, `_member`, `_invite`, `_transfer`, `_event`; шестая, `practice_audience_curator_group`, принадлежит `practices`. Append-only журнал `CuratorGroupEvent` + единственный писатель `_record_group_event` (`service.py`) + чтение `GET /masters/me/curator-groups/{id}/journal` (limit/offset, `ORDER BY seq DESC`). Право заводить школу — флаг в `MasterProfile.data.account`, гейт в одной точке (см. 3.17) |
| `admin` | `app/modules/admin/` | Верификация мастеров, модерация (data-integrity semaphores built Phase 6.8, removed 2026-07-07 `9ca5619` — see §6) |
| `ai` | `app/modules/ai/` | Розетка AI-саммари (Phase 9) |
| `library` | `app/modules/library/` | Розетка: будущая библиотека записей практик (Phase 9.2, вне MVP — `models.py` целиком закомментирован, кода нет) |

### 1.2. Core

| Файл | Содержимое |
|------|------------|
| `app/core/config.py` | `Settings` (pydantic-settings, `.env`) |
| `app/core/database.py` | `get_db_session()`, `get_db_reader()`, `get_session_factory()` |
| `app/core/exceptions.py` | `VeloError` → `NotFoundError`, `ForbiddenError`, `ConflictError`, `BadRequestError`, `UnauthorizedError` |
| `app/core/mixins.py` | `UUIDMixin`, `TimestampMixin`, `JSONBMixin` |
| `app/core/logging.py` | structlog setup (`setup_logging()`) |
| `app/core/audit.py` | `record_audit()`, `AuditLog` model |
| `app/core/periods.py` | Период-математика (единый источник, E7): `calendar_period_bounds()`, `period_delta_pct()`, `rate_delta_pp()` |

---

## 2. API Endpoints

### Auth

```
POST /api/v1/auth/telegram          -- Вход через Telegram initData
POST /api/v1/auth/logout            -- Выход (текущая сессия)
POST /api/v1/auth/logout-all        -- Выход со всех устройств
```

### Users

```
GET   /api/v1/users/me              -- Мой профиль (+ onboarding_completed, phone, bio, notifications)
PATCH /api/v1/users/me              -- Обновить профиль (вкл. onboarding_completed, phone, bio, notifications)
DELETE /api/v1/users/me             -- "Удалить аккаунт" (MVP: сброс онбординга, см. 3.11)
GET   /api/v1/users/me/checkins     -- Мои check-ins (пагинация)
GET   /api/v1/users/me/feedbacks    -- Мои feedbacks (пагинация)
```

`UserResponse.onboarding_completed: bool` — вычисляется из `credentials` JSONB (см. 3.7), не колонка.
`UserUpdate.onboarding_completed: bool | None` — флаг завершения онбординга пишется в `credentials`.
`UserResponse.phone/bio: str | None` и `UserResponse.notifications: NotificationSettings` —
также вычисляются из `credentials` JSONB (schema-on-read, см. 3.11). `UserUpdate` принимает
`phone`/`bio` (пустая строка = очистить) и `notifications` (частичный объект, мёржится).

### Masters

```
POST  /api/v1/masters/apply                         -- Подать заявку на мастера
GET   /api/v1/masters/me                            -- Мой профиль мастера
PATCH /api/v1/masters/me/payout                     -- Обновить реквизиты для выплат
GET   /api/v1/masters/me/practices                  -- Мои практики (пагинация)
POST  /api/v1/masters/me/promos                     -- Создать мастерский промокод
GET   /api/v1/masters/me/promos                     -- Мои промокоды (пагинация)
PATCH /api/v1/masters/me/promos/{id}/deactivate     -- Деактивировать промокод
POST  /api/v1/masters/me/withdraw                   -- Запрос на вывод средств
GET   /api/v1/masters/me/withdrawals                -- История выводов (пагинация)
GET   /api/v1/masters/me/income?period=week|month   -- Доход за период + delta_pct (E2)
GET   /api/v1/masters/me/stats?period=week|month     -- Стат-сетка дашборда: практики/участники/доход + дельты (E7)
GET   /api/v1/masters/me/transactions               -- Лента транзакций (signed, пагинация, E2)
GET   /api/v1/masters/me/students                    -- Мои ученики (поиск, пагинация, E5)
GET   /api/v1/masters/me/students/{id}               -- Профиль ученика (E5)
GET   /api/v1/masters/me/reviews?attention=          -- Cross-practice лента отзывов (+practice_title, #3)
```

> **E2 (доход/лента).** `income` = знаковая сумма title-помеченных DONE-движений
> `master_ledger` за календарный период (week=Пн..Пн, month=1..1, UTC) — это
> **валовой забронированный оборот** (frozen-продажи включены, чтобы совпадать с
> лентой), НЕ реализованный заработок. `delta_pct` — только при `prev_income > 0`,
> иначе `null` (S-1). `transactions` отдаёт `{ title, created_at, counterparty_name,
> amount_cents (signed) }` где `title IS NOT NULL`. Маппинг тегов (`main.py`):
> sale→«Оплата за практику»+покупатель, commission→«Комиссия», refund→«Возврат».
> Миграция `9f1e2d3c4b5a` (поля `title`, `counterparty_id` в `master_ledger`).

> **E5 (CRM).** Ученик = юзер с ≥1 ATTENDED-броней на практике мастера. Список:
> поиск ILIKE, most-attended-first, `{ id, name, avatar_url, practices_count,
> needs_attention }` (needs_attention = последний отзыв в confused-бакете). Деталь:
> `{ practices_count, hours, satisfaction_pct, recent_checkins, feedbacks }`, 404
> если нет attended-брони (P-08).

> **#3 (cross-practice отзывы).** `GET /masters/me/reviews?attention=true|false` —
> именованные отзывы по всем COMPLETED-практикам мастера, `{ reviewer_name,
> avatar_url, rating: fire|good|confused, comment, practice_title, created_at }` +
> пагинация. `attention=true` → confused-бакет (rating ≤ 3) для блока «Требуют
> внимания». Бакет/имя-хелперы переиспользованы из `diary.service` (S-2). Имя схемы
> `MasterReviewItem` уникально (без OpenAPI-коллизии с diary `ReviewItem`).

> **E7 (стат-сетка мастера).** `GET /masters/me/stats?period=week|month` ->
> `MasterStatsResponse { practices_count, participants_count, income_cents }` плюс
> `*_delta_pct` на каждый показатель. `practices_count` — практики мастера с
> `scheduled_at` в периоде (исключая draft/deleted/cancelled); `participants_count`
> — DISTINCT юзеры с ATTENDED-бронью на них; `income_cents` — тот же валовой оборот,
> что в E2 (одно определение дохода для дашборда и финансов). Дельты — знаковый %
> к прошлому периоду, `null` при непозитивном базовом (S-1). Границы периода —
> `core.periods.calendar_period_bounds` (единый источник, §1.2). Read-only
> (`get_db_reader`), имя схемы с `Master*`-префиксом (без OpenAPI-коллизий).

### Practices

```
GET    /api/v1/practices                        -- Публичный фид (фильтры ниже)
POST   /api/v1/practices                        -- Создать практику (мастер; +recurrence для series, E3)
GET    /api/v1/practices/{id}                   -- Детали практики
PATCH  /api/v1/practices/{id}                   -- Обновить практику (владелец)
DELETE /api/v1/practices/{id}                   -- Удалить черновик (владелец)
POST   /api/v1/practices/{id}/cancel            -- Отменить практику + возврат всем (+scope для серий, E3)
POST   /api/v1/practices/{id}/finalize          -- Завершить практику (мастер)
GET    /api/v1/practices/{id}/attendance        -- Список посещаемости (мастер)
POST   /api/v1/practices/{id}/checkin           -- Создать check-in (юзер; один раз, неизменяемо)
POST   /api/v1/practices/{id}/feedback          -- Создать feedback (юзер; один раз, неизменяемо)
GET    /api/v1/practices/{id}/insights          -- Агрегированные insights (мастер)
GET    /api/v1/practices/{id}/reviews           -- Именованные отзывы практики (мастер; +attention, E1)
GET    /api/v1/practices/{id}/ai-summary        -- AI-саммари (розетка, Phase 9)
```

> **E1 (именованные отзывы).** `GET /practices/{id}/reviews?attention=&limit=&offset=`
> (master-only, 404 не-владельцу по P-08, 400 если практика не completed) — де-
> анонимизированный аналог `insights`: `{ reviewer_name, avatar_url, rating:
> fire|good|confused, comment, created_at }` + пагинация. `attention=true` сужает до
> негативного бакета (rating ≤ 3) для дашборд-блока «Требуют внимания». Это
> per-practice эндпоинт; cross-practice лента мастера — #3 (`/masters/me/reviews`).

**Фильтры `GET /practices` (Calendar iteration):** все опциональны.
Мульти-фасеты передаются повторяемыми query-параметрами (`?direction=yoga&direction=breathwork`);
внутри одного фасета значения OR-ятся, между фасетами — AND.

| Параметр | Тип | Значения / семантика |
|----------|-----|----------------------|
| `practice_type` | мульти | `live\|series\|one_on_one\|replay` |
| `direction` | мульти | `meditation\|yoga\|breathwork` (из `data.taxonomy`) |
| `difficulty` | мульти | `beginner\|medium\|high` (из `data.taxonomy`) |
| `style` | строка | свободное точное совпадение по `data.taxonomy.style` |
| `duration_bucket` | один | `short` (< 60 мин) / `long` (>= 60 мин) |
| `time_of_day` | один | `night\|morning\|day\|evening` — по ЛОКАЛЬНОМУ часу практики |
| `status` | один | `scheduled\|live` (alias `status`) |
| `master_id`, `date_from`, `date_to`, `sort_by`, `sort_order` | — | как раньше |

`time_of_day` считается в таймзоне практики через `func.timezone(Practice.timezone, scheduled_at)`
+ `extract('hour', ...)` (ORM, без сырого SQL). Границы корзин — в `config.py` (см. §7).

**Per-user флаги в `PracticeResponse`** (фид и детали, для текущего юзера):
- `is_booked: bool` — у юзера есть бронь в статусах `pending|confirmed|attended`.
- `is_paid: bool` — `is_booked` И практика платная (`price_cents > 0`). ВАРИАНТ 1:
  определяется по цене практики, НЕ по наличию `purchase_id` (бесплатные брони тоже
  создают Purchase, поэтому purchase_id для «оплачено» не годится).
- На master-facing list-эндпоинтах флаги остаются `False` (мастер не бронирует свои практики).
- Детальный эндпоинт собирает ответ через публичную `get_practice_detail()` в сервисе
  (роутер не импортирует приватные хелперы — C-1 аудита Calendar, §9).

> **`PracticeSummary.status`:** облегчённая схема `PracticeSummary` (отдаётся в list-views:
> `GET /bookings/me`, waitlist, purchases) получила поле `status: PracticeStatus`.
> Подхватывается автоматически через `model_validate(practice)` + `from_attributes`
> во всех 3 потребителях (Booking/Waitlist/Purchase-WithPractice) — как ранее `timezone` (CR-01).
> Миграций не требует (колонка `status` в таблице уже есть). Поля `PracticeSummary`:
> `id, title, practice_type, status, scheduled_at, duration_minutes, timezone, master_id, master_name`.
> Это позволяет фронту (дашборд, список броней) отличать live от scheduled без отдельного GET деталей.

> **E3 (серии / повторяющиеся практики).** Подробная механика — §3.13.
> - **Создание:** `POST /practices` с `practice_type="series"` принимает
>   `recurrence: RecurrenceSpec { period: daily|weekly|biweekly, days: list[int]
>   (ISO 1=Пн..7=Вс), end: never|until_date|after_count, count: int|None,
>   until_date: date|None }`. Поле `recurrence` отклоняется (422), если тип не
>   `series`. `weekly|biweekly` требуют `days`; `after_count` требует `count`
>   (`count <= practice_series_max_occurrences`, дефолт 40, иначе 422). Оккуренции
>   материализуются при ПУБЛИКАЦИИ (draft->scheduled) корня (см. W-1 ниже).
> - **Карточка:** `PracticeResponse` получил `recurrence_days: list[int] | None`,
>   `total_sessions: int | None`, `completed_sessions: int | None` (None у не-серий).
>   Считаются 2 ограниченными запросами на список (без N+1); `completed` исключает
>   cancelled. Публичный фид эти поля НЕ отдаёт (только master-list и деталь).
> - **Отмена с охватом:** тело `CancelPracticeRequest { scope: "this" |
>   "this_and_future" }` (опционально, дефолт `"this"` — обратная совместимость).
>   `"this"` — только эта оккуренция; `"this_and_future"` — эта плюс все позднейшие
>   оккуренции серии (каждая под `with_for_update`, общий timestamp журнала, W-3).

### Bookings

```
POST   /api/v1/bookings             -- Забронировать (+ опциональный promo_code)
GET    /api/v1/bookings/me          -- Мои бронирования
GET    /api/v1/bookings/me/stats    -- Моя статистика практик (объявлен ДО /{id})
GET    /api/v1/bookings/{id}        -- Детали бронирования
DELETE /api/v1/bookings/{id}        -- Отменить бронирование
POST   /api/v1/bookings/{id}/join   -- Отметить приход (владелец брони)
POST   /api/v1/bookings/{id}/leave  -- Отметить уход (владелец брони)
```

`GET /bookings/me/stats` -> `UserStatsResponse { practices_attended: int, hours_attended: float }`.
Один ORM-запрос: `func.count(Booking.id)` + `func.coalesce(func.sum(Practice.duration_minutes), 0)`
с join `Practice` по `practice_id` и фильтром `user_id == me AND status == attended`;
`hours_attended = round(minutes/60, 1)`. Роут объявлен ДО динамического `/{booking_id}`,
иначе `me/stats` перехватился бы как booking_id (Профиль, экран A).

> **Доступ к join/leave:** доступны **владельцу брони** (юзеру), non-owner → 404
> (`test_join_booking_success` — owner 200; `test_join_booking_not_owner` — 404).
> Фронт использует их на экране 14 (Practice-Live): юзер сам отмечает приход/уход.

**Attendance для мастера (обогащён, v1.7).** `GET /api/v1/practices/{id}/attendance`
(master-only, в разделе Practices) отдаёт `AttendanceResponse` = агрегаты
(`total/attended/no_show/pending`) + `items: list[AttendanceItemResponse]`. С
v1.7 каждый item, помимо `booking_id/user_id/status/joined_at/left_at`, несёт:
- `user_display_name: str | None` — `first_name` + `last_name` участника
  (иначе `None`; фоллбэка «Master» нет — это участник, не мастер);
- `user_avatar_url: str | None` — аватар участника (`User.avatar_url`);
- `checkin: AttendanceCheckinResponse | None` — PRE-чек-ин участника
  (`{ mood: int, comment: str | None }`) на эту практику, либо `null`.

`get_attendance` (`bookings/service.py`) после owner-проверки (P-08) батч-грузит
участников (`User.id IN`) и их PRE-чек-ины одним запросом через
`diary/service.py::get_pre_checkins_for_bookings` (`Checkin.booking_id IN`,
`check_type == PRE`) — **без N+1** независимо от числа участников. Роутер только
маппит результат в схему (хелпер `_participant_display_name`).

> **Приватность чек-ина (осознанное решение, v1.7):** чек-ины приватны
> (`GET /users/me/checkins` — только свои). Здесь PRE-чек-ин участника
> открывается мастеру-**владельцу именно этой практики** и **только** в рамках
> её attendance (booking_ids принадлежат этой практике, авторизацию проверяет
> вызывающий — тот же trust-boundary, что у `get_practice_insights`). Глобальная
> приватность не меняется. `master_request`/эндпоинт «вопрос мастеру» НЕ
> добавлялись — это диалог юзер↔мастер, отдельная фича (TD-ASK-MASTER, §9 / §2
> Diary), вне MVP. См. §3.12.

### Waitlist

```
POST   /api/v1/practices/{id}/waitlist      -- Встать в очередь
DELETE /api/v1/practices/{id}/waitlist      -- Выйти из очереди
GET    /api/v1/practices/{id}/waitlist      -- Список очереди (мастер)
```

### Payments

```
POST /api/v1/payments/topup                 -- Создать сессию пополнения (Stripe Checkout)
GET  /api/v1/payments/topup/success         -- Страница успеха (redirect)
GET  /api/v1/payments/topup/cancel          -- Страница отмены (redirect)
POST /webhooks/stripe                       -- Stripe webhook (checkout.session.completed / expired)
```

### Reports

```
POST  /api/v1/reports               -- Создать жалобу (или получить существующую — 200 если дубль)
PATCH /api/v1/reports/{id}          -- Редактировать свою pending-жалобу
GET   /api/v1/reports/me            -- Мои жалобы (пагинация)
```

### Diary

```
POST   /api/v1/diary                -- Создать запись дневника (note/dream)
GET    /api/v1/diary                -- Мои записи дневника (пагинация, legacy)
GET    /api/v1/diary/{id}           -- Запись дневника
PATCH  /api/v1/diary/{id}           -- Обновить запись
DELETE /api/v1/diary/{id}           -- Удалить запись (soft-delete)
GET    /api/v1/diary/feed           -- Единая лента дневника (cursor pagination)
```

**Check-in / feedback неизменяемы (one-and-only-once).** Чек-ин и фидбэк — это
зафиксированные точки данных для анализа: создаются **один раз и не меняются
никогда**. `upsert_checkin` / `upsert_feedback` (`diary/service.py`) при уже
существующей записи (`Checkin` по `booking_id`+`check_type='pre'`; `Feedback` по
`practice_id`+`user_id`) возвращают **`409 Conflict`** — перезаписи нет. Гонка
двух одновременных первых POST закрыта паттерном **P-05** (`try/except
IntegrityError` СНАРУЖИ `begin_nested`, ERR-05): проигравший unique-constraint
(`uq_checkin_booking_type` / `uq_feedback_practice_user`) получает тот же `409`,
а не `500`. Первый POST в окне создаёт запись (`200`). NB: записи **дневника**
(`note`/`dream`, `PATCH /diary/{id}`) остаются редактируемыми — неизменяемость
касается только чек-ина и фидбэка. История правки контракта: ранее повторный
POST перезаписывал `mood`/`comment` (`rating`/`comment`) — это уничтожало
исходную точку данных и устранено.

**Diary redesign (журнал событий + единая лента).** Поверх неизменных
таблиц-источников (Booking, Practice, Checkin, Feedback, DiaryEntry) работает
тонкий append-only журнал `DiaryEvent`, который наполняется ТОЛЬКО через
`projections.py` в момент мутации источника (в той же транзакции). Лента
`GET /api/v1/diary/feed` отдаёт события из журнала, отсортированные
newest-first, с курсорной пагинацией (`{ items, next_cursor }`,
`next_cursor === null` = конец).

9 видов событий (`DiaryEventKind`): `booking_confirmed`,
`booking_cancelled_by_user`, `practice_rescheduled`,
`practice_cancelled_by_master`, `practice_outcome`, `checkin`, `feedback`,
`note`, `dream`. Каждое событие несёт `snapshot` (денормализованный слепок
источника на момент события) — лента самодостаточна и не делает JOIN к
источникам при чтении.

**Snapshot-контракт** (что кладёт `projections.py`):
- `_practice_snapshot` (базовый): `practice_id, practice_title, master_id,
  master_name, scheduled_at, duration_minutes, direction`. NB: аватар мастера
  и verified-флаг в snapshot НЕ входят (TD-DIARY-PRACTICE-AVATAR).
- `practice_outcome` += `outcome_status` (`attended` / `no_show`).
- `practice_rescheduled` += `old_scheduled_at`, `new_scheduled_at`.
- `checkin` += `mood`, `comment_preview`.
- `feedback` += `rating`, `comment_preview`.
- `note` / `dream` (entry): `entry_type, title, content_preview, mood,
  practice_id, practice_phase`.

Миграция журнала: `c4d5e6f7a8b9`.

Открытый техдолг бэка дневника: TD-DIARY-FEED-CURSOR-TIEBREAK (стабильный
тай-брейк курсора при равных `occurred_at`), TD-DIARY-SNAPSHOT-TYPED
(типизировать snapshot вместо открытого dict), TD-DIARY-CANCEL-COMMENT
(причина отмены в snapshot), TD-ASK-MASTER (диалог юзер↔мастер как отдельная
фича — не строка на брони; вне MVP, см. §9; чек-ин клиента мастеру уже
отдаётся через attendance, см. §3.12).

### Curator Groups

Школы. **24 операции на 21 пути** — пересчитать: `app.openapi()`, фильтр
`'curator-groups' in path`.

```
-- Куратор (за get_current_master + владение; чужая школа -> 404, не 403) --
POST   /api/v1/masters/me/curator-groups                                  -- Завести школу (гейт права, см. 3.17)
GET    /api/v1/masters/me/curator-groups                                  -- Мои школы (+ can_create_groups на СПИСКЕ)
PATCH  /api/v1/masters/me/curator-groups/{id}                             -- Имя / описание / аватар (partial, name обязателен)
DELETE /api/v1/masters/me/curator-groups/{id}                             -- Удалить школу (каскадом уходит и журнал)
GET    /api/v1/masters/me/curator-groups/{id}/delete-preview              -- Что будет удалено
GET    /api/v1/masters/me/curator-groups/{id}/members                     -- Ростер (limit/offset, фильтр kind, поиск)
DELETE /api/v1/masters/me/curator-groups/{id}/members/{user_id}           -- Удалить участника (идемпотентно, 204 на промах)
GET    /api/v1/masters/me/curator-groups/{id}/members/{user_id}/remove-preview
POST   /api/v1/masters/me/curator-groups/{id}/invites                     -- Выпустить/вернуть ссылку (create-or-return)
DELETE /api/v1/masters/me/curator-groups/{id}/invites/{kind}              -- Отозвать ссылку одного вида
POST   /api/v1/masters/me/curator-groups/{id}/transfer                    -- Предложить передачу (UNIQUE на группу -> 409)
DELETE /api/v1/masters/me/curator-groups/{id}/transfer                    -- Отменить своё предложение
GET    /api/v1/masters/me/curator-groups/{id}/journal                     -- Журнал школы (см. 3.14-3.16)

-- Участник и приглашённый (за get_current_user) --
GET    /api/v1/curator-groups/mine                                        -- Школы, где я куратор ИЛИ участник
GET    /api/v1/curator-groups/{id}                                        -- Страница школы (только для своих; иначе 404)
GET    /api/v1/curator-groups/{id}/masters                                -- Мастера школы (публично для своих)
GET    /api/v1/curator-groups/{id}/practices                              -- Практики, нацеленные на школу
DELETE /api/v1/curator-groups/{id}/membership                             -- Выйти (куратору -> 409 curator_cannot_leave)
GET    /api/v1/curator-groups/{id}/leave-preview                          -- Чем обернётся выход
GET    /api/v1/curator-groups/invites/{token}                             -- Карточка по ссылке + причина отказа
POST   /api/v1/curator-groups/join                                        -- Вступить по токену
POST   /api/v1/curator-groups/{id}/transfer/accept                        -- Принять школу
POST   /api/v1/curator-groups/{id}/transfer/decline                       -- Отклонить (204, даже если предложения не было)

-- Админ --
GET    /api/v1/admin/curator-groups                                       -- Все школы (+ is_active)
```

**Школьный админский путь стоит здесь, а не в `### Admin`.** Конвенции «все
`/admin/*` в один блок» нет — блок `### Admin` называет 25 путей из 43 живых
(см. «Наблюдения» отчёта GT-18). Школы в одном месте читаются лучше, чем
размазанные по неполному списку.

**Что вычисляется, а не хранится.**

`is_active` (админский список) — **производная**, не колонка. Школа активна
ровно тогда, когда её куратор верифицирован ПРЯМО СЕЙЧАС:
`_active_group_clause()` = `_verified_profile_exists(CuratorGroup.curator_user_id)`,
то есть тот же JSONB-путь к статусу, что у ростера и счётчиков, написанный в
дереве один раз. Для самих участников неактивная школа неотличима от удалённой
(404, I-6) — и это правильно для них и бесполезно для админа, которого как раз
спрашивают «почему моя школа замолчала». Оба вида в одном списке ровно поэтому.
Кураторские эндпоинты этот clause **не вызывают**: `get_current_master` уже
гарантирует, что вызывающий верифицирован.

`masters_count` — только **видимые** мастера: участники с `kind='master'`, чей
профиль верифицирован сейчас. Приостановленный мастер остаётся строкой с
`is_visible=false` в ростере (I-4) — куратор видит, что человек в школе, но «в
тени», и ре-верификация возвращает его без правки строк.

`relation` (`curator` | `master` | `student`) — производная от
`curator_user_id` и строк участия. Значение `curator` — литерал в `CASE`, его
нет среди `curator_group_member.kind`, потому что у куратора нет строки участия.

`can_create_groups` — на **списке**, не на элементе: это свойство мастера, а не
школы, и экран берёт его из вызова, который уже делает.

`transfer` в ответе видят **двое** — куратор, сделавший предложение, и адресат.
Остальные получают `null`, а не урезанный объект: участник, не участвующий в
сделке, не узнаёт, что она идёт.

**Аудитория практик — чужая таблица.** `practice_audience_curator_group` живёт
в `practices/models.py`; школы её не владеют. `GET /curator-groups/{id}/practices`
читает её, но пишет — `practices`.

**Коды ошибок: 11, и все 11 уже во фронтовой таблице.** Пересчитать: греп
`code="..."` по `curator_groups/` даёт **9**, плюс **2** через константы
(`_NAME_TAKEN_CODE` = `curator_group_name_taken`, `_NO_CREATE_RIGHT_CODE` =
`group_creation_not_allowed`). **Греп только по литералам их не увидит** — ту же
слепоту имеет команда сверки в шапке `frontend/src/api/errorMessages.ts`, и там
про это написано.

**Инвайт-ссылка едет на живой хост даром.** Строится в `service.py:1498` из
`settings.telegram_bot_url`, а он нормализуется на старте
(`config.py:635`, `core/telegram_links.py`) — `t.me` мёртв с 2026-07-13 на уровне
регистратора. Диплинк `curator_group_invite__` бэком генерируется, **фронтовым
парсером не разбирается** — добавляется вместе с экраном вступления.

### Admin

```
GET  /api/v1/admin/stats                            -- Метрики платформы
GET  /api/v1/admin/stats/overview?period=week|month -- Период-обзор платформы одним вызовом (E7)

GET  /api/v1/admin/users                            -- Все юзеры (фильтры: role, is_active)
GET  /api/v1/admin/masters/pending                  -- Мастера на верификации
GET  /api/v1/admin/masters/list                     -- Все мастера (фильтр: status)
GET  /api/v1/admin/masters/{id}                     -- Профиль мастера для ревью
POST /api/v1/admin/masters/{id}/verify              -- Верифицировать мастера
POST /api/v1/admin/masters/{id}/reject              -- Отклонить заявку

GET  /api/v1/admin/reports                          -- Список жалоб (фильтры: status, target_type)
GET  /api/v1/admin/reports/{id}                     -- Детали жалобы
POST /api/v1/admin/reports/{id}/resolve             -- Обработать жалобу
POST /api/v1/admin/reports/{id}/dismiss             -- Отклонить жалобу

GET  /api/v1/admin/withdrawals                      -- Список выводов (фильтр: status)
POST /api/v1/admin/withdrawals/{id}/approve         -- Одобрить вывод
POST /api/v1/admin/withdrawals/{id}/reject          -- Отклонить вывод

POST /api/v1/admin/promos                           -- Создать company-промокод
GET  /api/v1/admin/promos                           -- Список company-промокодов
PATCH /api/v1/admin/promos/{id}/deactivate          -- Деактивировать промокод

[REMOVED 2026-07-07 `9ca5619`] GET /api/v1/admin/consistency -- Data consistency семафоры (см. §6)

GET  /api/v1/admin/metrics/check-in?period=week|month   -- Метрика чек-инов (E9/4a)
GET  /api/v1/admin/metrics/feedback?period=week|month   -- Метрика фидбэка (E9/4a)
GET  /api/v1/admin/metrics/return?period=week|month     -- Метрика возвращаемости (E9/4a)
GET  /api/v1/admin/revenue?period=week|month            -- Выручка платформы (E9/4b)
GET  /api/v1/admin/practices?scope=all|upcoming|past    -- Глобальный список практик (E9/4c)
GET  /api/v1/admin/practices/{id}                       -- Деталь практики + roster (E9/4c)

POST /api/v1/admin/templates/reload                 -- Перезагрузить шаблоны уведомлений
```

> **E9 (admin-оверсайт).** Все эндпоинты — `get_current_admin` (403 не-админу) +
> `get_db_reader` (read-only), как саб-роутеры под `/api/v1/admin`. Метрики
> **платформенные** (включают seed); якорь периода — `Practice.scheduled_at`
> (week=Пн..Пн, month=1..1, UTC). check-in→`{rate_pct, total_records, checked_in,
> series, low_practices}`; feedback→`{rate_pct, visited, left_review,
> distribution{fire,good,confused}}` (W-3: числитель привязан к тем же
> attended-броням → rate ≤ 100%); return→`{rate_pct, total_users, returning,
> top_users}`. `revenue` → `{ revenue_cents (=GMV, SUM `paid_cents` completed),
> commission_cents, payout_cents (NET, approved за период), per_master }` — тот же
> ledger-слой, что E2. `practices` — пагинированный список (исключает draft/deleted,
> `scheduled_at desc`) + деталь с roster; `status` временной (upcoming/past). Имена
> схем — `Admin*`/уникальные (урок: `RatingDistribution` коллизился с diary →
> `FeedbackRatingDistribution`). Seed (4d) населяет `payout` реальными
> approved-выводами через production-flow (semaphore-safe — semaphores существовали на
> момент написания этой заметки, удалены 2026-07-07 `9ca5619`, см. §6).

> **E7 (период-обзор админа).** `GET /admin/stats/overview?period=week|month` ->
> `AdminStatsOverviewResponse`: рост (`new_users`, `new_masters`, `practices_count`
> + `*_delta_pct`), выручка (`revenue_cents` + delta, `commission_cents`),
> вовлечённость (`checkin_rate_pct`/`feedback_rate_pct`/`return_rate_pct` +
> `*_rate_delta` в процентных ПУНКТАХ через `rate_delta_pp`) и `pending_reports`
> (period-independent). Один вызов заменяет прежний фан-аут дашборда по
> `/admin/stats` + `/admin/revenue` + три `/admin/metrics`. Определения выручки и
> ставок — те же, что E9 (не переизобретены); границы периода — `core.periods`.
> `new_masters` считается по дате регистрации аккаунта (симметрично `new_users` —
> согласованная конвенция, чистого «стал мастером» timestamp нет; S-3,
> задокументировано в `overview_service.py`). Сиблинг существующего `/admin/stats`
> (тот не тронут), оба — статические пути.

### System

```
GET /           -- {"name": "VELO API", "version": "..."}
GET /health     -- {"status": "ok", "db": "ok", "redis": "ok"} (всегда 200)
GET /ready      -- То же, но 503 при деградации
```

---

## 3. Архитектурные правила

### 3.1. JSONBMixin — мутации JSONB

SQLAlchemy не детектит изменения JSONB при прямом присвоении dict.
Это silent bug: данные не сохраняются в БД.

```python
# ЗАПРЕЩЕНО:
profile.data = new_dict
profile.data["account"]["status"] = "verified"

# ПРАВИЛЬНО:
profile.set_jsonb("data", new_dict)
```

`JSONBMixin` в `app/core/mixins.py` выполняет `setattr()` + `flag_modified()`.
Все модели с JSONB-колонками обязаны наследовать `JSONBMixin`.

Текущие JSONB-колонки:

| Модель | Колонка | JSONBMixin |
|--------|---------|------------|
| `MasterProfile` | `data` | ✅ |
| `User` | `credentials` | ✅ (TD-024 закрыт — onboarding flow + phone/bio/notifications, set_jsonb в users/service.py, см. §3.7, §3.11) |
| `Practice` | `data` | ✅ (Calendar iteration — taxonomy sandbox, set_jsonb в practices/service.py, см. §3.8) |

### 3.2. Session Commit Rule

`get_db_session()` делает `commit()` автоматически после `yield`.
Явный `commit()` в роутере = двойной коммит = `InvalidRequestError`.

```python
# ЗАПРЕЩЕНО в роутерах:
await session.commit()

# ПРАВИЛЬНО — flush для DB-generated значений:
await session.flush()
await session.refresh(obj)
# get_db_session() сделает единственный commit сам
```

Два вида сессий:

| Зависимость | Поведение | Когда использовать |
|-------------|-----------|-------------------|
| `get_db_session()` | auto-commit после yield, rollback при исключении | Write-операции |
| `get_db_reader()` | всегда rollback | Read-only запросы |

В service-слое допустим `session.rollback()` только внутри `try/except IntegrityError`.

### 3.3. State Machine — практики

Переходы статусов практики — только через явные функции в `practices/service.py`.
Прямой `setattr(practice, "status", x)` без валидации запрещён.

Допустимые переходы:

```
draft      -> scheduled   (мастер публикует)
scheduled  -> live        (практика началась)
scheduled  -> cancelled   (отмена)
live       -> completed   (finalize)
live       -> cancelled   (отмена)
completed  -> (финал, нет переходов)
cancelled  -> (финал, нет переходов)
```

### 3.4. Pydantic PATCH — NOT NULL поля

Для каждого NOT NULL поля в Update-схеме нужен валидатор, отклоняющий `null`:

```python
@field_validator("title", "timezone", mode="before")
@classmethod
def _reject_null(cls, v):
    if v is None:
        raise ValueError("This field cannot be set to null")
    return v
```

Без валидатора `{"timezone": null}` проходит Pydantic, но падает с 500 IntegrityError.

### 3.5. Логирование

Только `structlog`. `import logging` запрещён.

```python
import structlog
logger = structlog.get_logger()

# В сервисах:
logger.info("booking.created", booking_id=str(booking.id), user_id=str(user.id))
```

Уровни: DEBUG (разработка) / INFO (бизнес-события) / WARNING (потенциальные проблемы) / ERROR (recoverable) / CRITICAL (система сломана).

### 3.6. Генерация TypeScript-типов из OpenAPI (CR-01)

Бэкенд — единственный источник правды для API-контракта. TypeScript-типы фронтенда генерируются автоматически из OpenAPI-схемы FastAPI.

**Скрипт:** `backend/scripts/generate_ts_types.py`
**Вход:** `openapi.json` (снимается с живого бэкенда через `curl`)
**Выход:** `frontend/src/api/generated.ts` (коммитится в git, перегенерируется при каждом `velo update`)

**Как работает при `velo update`:**

```
build app -> down -> up app -> migrate -> pytest ->
curl openapi.json -> generate_ts_types.py -> generated.ts ->
[drift? -> velo-bot commit + push origin $BRANCH] ->
build frontend -> up frontend -> health check
```

**Авто-коммит типов (важно):** после регенерации `velo update` проверяет дрейф
(`git status --porcelain generated.ts`). Если файл изменился — коммитит от имени
`velo-bot <bot@velo.local>` и пушит в `origin/$BRANCH`. Push идёт через SSH-config
alias `github.com-velo` (deploy-key уже привязан, `GIT_SSH_COMMAND` не нужен).
Провал push -> `exit 1` (фатально: рассинхрон типов делает сборку фронта
бессмысленной). Это разрывает порочный круг "регенерил -> не закоммитил ->
discard на следующем update". Перенесено из рабочей модели проекта CBS Home.

**Как работает при `bash install_velo.sh`:**

```
build app -> up app -> wait health ->
curl openapi.json -> generate_ts_types.py -> generated.ts ->
build frontend -> up frontend
```

**Ручной запуск:** `velo gen-types` — только регенерирует + предупреждает о дрейфе,
НЕ коммитит и НЕ пушит (это работа `velo update`). Для итерации над схемой на VPS
без полного деплоя.

**Правила для response-схем:**

- Статусные поля (`status`, `practice_type`) — использовать `StrEnum`, не `str`. OpenAPI отдаёт `enum: [...]`, генератор создаёт union-тип.
- Поля с `default=X` в response-only схемах — убирать default, делать required. Иначе OpenAPI помечает как optional, генератор пишет `field?: type`, фронт вынужден использовать `?.`.
- `dict` в response-полях — типизировать через Pydantic-модель (например, `payout_details: PayoutDetails` вместо `dict`). Иначе генератор пишет `Record<string, unknown>`.
- Вычисляемые поля из JSONB — через `@computed_field` (см. 3.7). Если геттер возвращает не-Optional тип, OpenAPI помечает поле `required` -> генератор пишет без `?`.

---

### 3.7. Onboarding flag — schema-on-read в credentials

`onboarding_completed` — НЕ колонка. Хранится внутри существующего `User.credentials`
(JSONB) под ключом `"onboarding_completed"`. Паттерн schema-on-read: без миграции,
в зоне роста credentials. Закрывает TD-024 (первая ORM-мутация credentials).

**Чтение (`UserResponse`):**
- Приватное входное поле `credentials_in: dict` (Field с `validation_alias="credentials"`,
  `exclude=True`) — заполняется из ORM-объекта через `from_attributes`, наружу НЕ отдаётся.
- `@computed_field onboarding_completed -> bool` читает `credentials_in.get("onboarding_completed", False)`.
- Сырой `credentials` в API-ответ не попадает никогда — только булев флаг.

**Запись (`update_user`, users/service.py):**
- `UserUpdate.onboarding_completed: bool | None`. JSONB-поля развилкой отделяются
  от колоночных: колоночные -> `setattr`, `onboarding_completed` -> копия credentials +
  `user.set_jsonb("credentials", new)` (JSONBMixin -> flag_modified -> реальный UPDATE).
- `None` фильтруется (`value is not None`): прислать `null` = no-op, не сбрасывает флаг.
  Семантики "сбросить" нет — осмыслен только `true`.

**Инвариант при логине (`upsert_user_on_login`, auth/service.py):**
- На UPDATE credentials МЕРДЖИТСЯ, не перезаписывается:
  `coalesce(User.credentials, '{}'::jsonb) || fresh`. Свежие Telegram-поля
  накладываются поверх, `onboarding_completed` (которого нет в `fresh`) переживает
  релогин. COALESCE защищает edge-case `NULL || x = NULL`.
- На INSERT (новый юзер) credentials = fresh, флага нет -> читается как `false` ->
  онбординг показывается автоматически.

Тесты: `tests/test_users.py` — дефолт false, set true, **survives relogin** (ключевой),
merge + refresh telegram-полей, null игнорируется.

---

### 3.8. Practice taxonomy — schema-on-read в data (Calendar iteration)

Practice получил JSONB-колонку `data` (миграция `b2c3d4e5f6a8`, down_revision
`a1b2c3d4e5f7`). Таксономия Календаря живёт под ключом `data.taxonomy`:

```json
{ "taxonomy": { "direction": "meditation", "difficulty": "beginner", "style": "MBSR" } }
```

- `direction` ∈ `meditation|yoga|breathwork`, `difficulty` ∈ `beginner|medium|high`
  (StrEnum `PracticeDirection` / `PracticeDifficulty` в `practices/models.py`).
  `style` — свободная строка (≤ `practice_style_max_length`).
- **Create:** `direction` и `difficulty` ОБЯЗАТЕЛЬНЫ, `style` опционален. Пишутся в
  `data.taxonomy` через `set_jsonb("data", ...)` + deepcopy (JSONBMixin, §3.1).
- **Update (PATCH):** все три опциональны. «Не прислано» — значение не трогается;
  присланное — валидируется и мёржится в `data.taxonomy` (pop из `_TAXONOMY_FIELDS`
  до общего setattr-цикла, затем deepcopy-merge).
- **Response:** `practice_to_response()` читает из `data.taxonomy` и поднимает в
  top-level optional поля `direction|style|difficulty` (None, если песочница пуста).
  Поля опциональны, т.к. практики, созданные до итерации, имеют пустой `data`.
- **Допустимые значения** (`practice_allowed_directions/difficulties`) и
  `practice_style_max_length` — в `config.py` (NO-LITERALS), валидируются `@field_validator`.

Тесты: `tests/test_practices.py` (раздел Calendar) — хранение таксономии (create/update-merge),
фильтры фида (каждый + комбинированный AND), флаги is_booked/is_paid.

### 3.9. Публичный профиль мастера (Calendar flow)

`GET /api/v1/masters/{user_id}` — публичная карточка мастера для юзера (Figma
кадр 4 + master profile). Схема ответа `MasterPublicResponse` (`masters/schemas.py`).

- **Изоляция по схеме (граница безопасности):** `MasterPublicResponse` содержит
  ТОЛЬКО публичные поля — `user_id`, `status`, `display_name`, `bio`, `methods`,
  `experience_years`, `avatar_url`, `practices_count`, `reviews_count`. Финансовые
  и контактные поля (баланс, payout-реквизиты, и т.п.) в схему не входят и с бэка
  не приходят в принципе. `PayoutDetails` (та же `schemas.py`) к этому ответу
  отношения не имеет и импортируется `admin/withdrawals` — не удалять.
- **Доступ:** только verified-мастер, иначе 404 (P-08: не раскрываем существование
  неверифицированного/чужого профиля).
- **Счётчики — два live ORM-COUNT** (не denormalized, считаются на каждый запрос):
  `practices_count` исключает draft/deleted; `reviews_count` = `count(Feedback.id)`
  через join на Practice по `master_id` (вариант A — все отзывы мастера, не
  фильтруются по статусу практики; задокументировано в коде, ответ на S-2 аудита).
  Два COUNT идут последовательно (нельзя `asyncio.gather` на одной `AsyncSession` —
  тоже зафиксировано комментарием, ответ на S-1).
- **`display_name`** падает в `first_name`, если профильное имя пустое.
- **Роут объявлен ПОСЛЕДНИМ** в `masters/router.py` (после всех `/me*`), чтобы
  динамический `/{user_id}` не перехватывал статические пути.
- **`master_avatar_url` в деталях практики:** `get_practice()` дополнительно
  SELECT-ит `User.avatar_url` (4-колоночный tuple); `practice_to_response()`
  получил keyword-only параметр `master_avatar_url` (в списочных вызовах — None,
  у фида аватары не нужны).

Тесты: `tests/test_master_public.py` — 11 тестов (verified/404, счётчики,
изоляция полей), диапазон `telegram_id` 56xxx.

---

### 3.10. Diary projections — единственный писатель журнала (Diary redesign)

`DiaryEvent` — append-only журнал поверх неизменных источников. Инвариант:
**журнал наполняется ТОЛЬКО через `projections.py`, и только в момент мутации
источника, в той же транзакции.** Никакой код не пишет `DiaryEvent` напрямую
через ORM в обход проекций, и журнал НЕ наполняется задним числом (backfill
отсутствует by design).

- Функции-проекции (`project_*` / `upsert_*_event` в `projections.py`)
  вызываются из сервисов источников (bookings/practices/diary) сразу после
  успешной мутации, до коммита, через ленивый импорт (избегаем циклов).
- Каждое событие несёт денормализованный `snapshot` (см. snapshot-контракт в
  разделе «Diary» выше). Лента читается без JOIN к источникам.
- Следствие для сидов и фикстур: чтобы события появились в ленте, seed ДОЛЖЕН
  вызывать проекции (или идти через те же сервисные функции, что и прод), а не
  создавать Booking/Practice/Checkin напрямую — иначе журнал останется пустым
  при наполненных источниках.
- Чтение: `GET /diary/feed`, курсорная пагинация newest-first. Открытый
  тай-брейк при равных `occurred_at` — TD-DIARY-FEED-CURSOR-TIEBREAK.

---

### 3.11. Профиль в credentials + "удаление" аккаунта (Профиль, 29 мая)

Раздел «Профиль» (Figma node `4715-3463`) расширил schema-on-read в
`User.credentials` тремя сущностями — тем же паттерном, что `onboarding_completed`
(§3.7), без миграций.

**phone / bio (экран C — Edit Profile):**
- `UserResponse` отдаёт их через `@computed_field` (`credentials_in.get("phone")` /
  `("bio")`), `None` если ключа нет.
- `UserUpdate`: `phone` (max_length=20, мягкий валидатор: только цифры/пробел/`+()-`,
  >=5 цифр), `bio` (max_length=2000). **БЕЗ `min_length`** — в отличие от имён,
  пустая строка `""` допустима и означает «очистить» (вариант (б)). `null` для них
  = «не трогать» (как и для onboarding-флага: `update_user` отбрасывает `None`).
  Очистка делается пустой строкой, не null.
- `service.py`: `_JSONB_CREDENTIAL_FIELDS = {onboarding_completed, phone, bio}` —
  тот же единый write-путь (`""` проходит `is not None`, `null` отсекается).

**notifications (экран E — Notifications):**
- ВЛОЖЕННЫЙ объект `credentials["notifications"]` = `{push, practice_reminders,
  master_messages, support_messages}`, все дефолты **True** (`_NOTIFICATION_DEFAULTS`).
  Схемы `NotificationSettings` (Response) и `NotificationSettingsUpdate` (все поля
  опциональны) в `users/schemas.py`.
- `UserResponse.notifications` всегда отдаёт полный объект: дефолты накладываются
  на сохранённые ключи (частично сохранённый блоб дополняется до полного).
- **Частичный апдейт МЕРЖИТСЯ** ключ-за-ключом ОТДЕЛЬНОЙ веткой в `update_user`
  (`notifications` извлекается `updates.pop(...)` ДО плоской JSONB-развилки; читаем
  текущий объект, накладываем не-None ключи, `set_jsonb`). НЕЛЬЗЯ класть в плоский
  `_JSONB_CREDENTIAL_FIELDS` — `dict.update` затёр бы весь объект и сбросил
  неприсланные тоглы. Push-движок НЕ подключён — флаги это задел, переживают
  релогин (merge credentials, §3.7).

**DELETE /api/v1/users/me — "удаление" = сброс онбординга (экран D, MVP):**
- `reset_user_to_onboarding` (service.py) ставит `onboarding_completed=False` через
  `set_jsonb`. **is_active НЕ трогается, данные НЕ стираются.** При следующем входе
  юзер проходит онбординг заново, старые данные «всплывают» (merge при логине).
- Эндпоинт возвращает 204. Фронт после вызова делает logout (закрытие Mini App в
  Telegram). Контракт `DELETE` намеренно оставлен под будущее РЕАЛЬНОЕ удаление —
  менять только тело сервиса, не контракт (докстринг это фиксирует; specification
  drift осознан — Frontend Codex W-2 привёл текст модала в соответствие).

Тесты: `tests/test_users.py` — phone/bio set/clear(""), мягкая валидация телефона,
relogin-persist; notifications дефолты-all-true, частичный merge, накопление,
сосуществование с onboarding/phone; delete сбрасывает онбординг и сохраняет данные.

---

### 3.12. Attendance enrichment + «вопрос мастеру» (2 июня)

**Что (v1.7).** `GET /api/v1/practices/{id}/attendance` (master-only) обогащён под
экран подготовки мастера: по каждому участнику отдаются `user_display_name`,
`user_avatar_url` и его PRE-чек-ин `checkin { mood, comment } | null`. Новая
schema `AttendanceCheckinResponse` (`bookings/schemas.py`).

**Откуда данные, без N+1.** `get_attendance` (`bookings/service.py`) после
owner-проверки (P-08) делает ровно два батч-запроса поверх списка броней:
- участники — `select(User).where(User.id.in_(user_ids))` → `dict[user_id, User]`;
- PRE-чек-ины — `diary/service.py::get_pre_checkins_for_bookings(booking_ids)`
  (`Checkin.booking_id.in_(...)`, `check_type == PRE`) → `dict[booking_id, Checkin]`.
Сигнатура расширена до `tuple[Practice, list[Booking], dict[UUID, User],
dict[UUID, Checkin]]`; роутер — тонкий маппер (хелпер `_participant_display_name`:
`first_name`+`last_name`, иначе `None`; без «Master»-фоллбэка). Зависимость
`bookings -> diary` односторонняя — `Checkin` под `TYPE_CHECKING` для аннотации +
локальный рантайм-импорт внутри функции (тот же приём, что в `list_user_bookings`).

**Приватность.** PRE-чек-ин участника приватен (`/users/me/checkins` — свой), но
владельцу этой практики он открыт **только** внутри её attendance: `booking_ids`
принадлежат одной практике, авторизацию гарантирует вызывающий. Тот же
trust-boundary, что у `get_practice_insights` (мастер видит чек-ины участников
своей практики). Только PRE (что человек написал ДО практики — для подготовки).

**Почему НЕ `master_request`.** Исходный тикет просил поле `master_request` на
`Booking` + эндпоинт сохранения. Не сделано осознанно: «вопрос к мастеру» — это
**диалог** юзер↔мастер (мастер должен не только получить сообщение, но и
ответить; точки входа — из профиля «в общем» / до брони / после; роутинг в
Telegram-бот мастера с ответом юзеру). Строковое поле на брони такой флоу не
выносит (нет автора per-сообщение, порядка, статусов, ответов) и в V2 было бы
выброшено. Это отдельная сущность + флоу — фича диалогов, **вне MVP**
(TD-ASK-MASTER, §9). Фронт оставляет заглушку `TD-ASK-MASTER` как есть.

Тесты: `tests/test_attendance.py` (63xxx) — +6: имя+аватар; чек-ин виден мастеру;
`checkin=null` без чек-ина; `comment=None` при пустом; не-владелец → 404 (чек-ины
не утекают); корректный маппинг чек-инов на нужного участника при нескольких
участниках.

---

### 3.13. Recurrence / series — schema-on-read в data + parent_practice_id (E3)

Повторяющиеся практики — без отдельных таблиц и без миграции. Спецификация повтора
живёт под ключом `data.recurrence` (JSONB, тот же `set_jsonb` + deepcopy, §3.1) на
КОРНЕ серии; оккуренции связаны самоссылочным `parent_practice_id`
(`ondelete=SET NULL`, колонка существует с Phase 4.1).

- **Идентичность серии** = `coalesce(parent_practice_id, id)`. Корень — это
  оккуренция №1 (его `parent_practice_id IS NULL`).
- **Спека** (`RecurrenceSpec`, `practices/schemas.py`): `period ∈
  daily|weekly|biweekly`, `days: list[int]` (ISO 1=Пн..7=Вс), `end ∈
  never|until_date|after_count`, `count`/`until_date`. Model-валидатор: weekly/
  biweekly требуют `days`; after_count требует `count` и
  `count <= practice_series_max_occurrences` (дефолт 40, §7), иначе 422. Будущность
  `until_date` в схеме НЕ проверяется (см. W-1).
- **Генерация — при ПУБЛИКАЦИИ** (draft->scheduled корня-серии): сервис строит
  оккуренции №2..N (`_series_occurrence_starts`), DST-safe (локальный wall-clock
  каждой оккуренции -> UTC, сохраняя время суток), 5-летний потолок безопасности;
  идемпотентно (COUNT-guard). Корень-оккуренция №1 уже существует.
- **W-1 (вырожденная спека):** если спека не даёт НИ ОДНОЙ оккуренции после первой
  (прошлый/слишком ранний `until_date` и т.п.) — публикация отклоняется
  `BadRequestError` (400). Гард намеренно на слое генерации, НЕ в схеме: ловит и
  прошлые, и same-day, и too-early-weekday кейсы независимо от периода/TZ (полнее
  схемной date-проверки, которая поймала бы только прошлое).
- **Карточка:** `recurrence_days/total_sessions/completed_sessions` собираются
  батчем на список (2 запроса: спеки корней по `id IN`; COUNT GROUP BY
  `coalesce(parent,id)` с `func.count().filter(status=completed)`) — без N+1.
  Публичный фид эти поля не отдаёт (master-list + деталь).
- **Отмена с охватом:** `cancel_practice` расщеплён на ядро `_cancel_one` (refund +
  статус->cancelled + audit + diary-проекция для ОДНОЙ залоченной оккуренции) и
  обёртку по `scope`. `this_and_future` отменяет корень + позднейшие сиблинги
  (`coalesce(parent,id)==root AND scheduled_at>=primary AND статус отменяем`, каждая
  `with_for_update`). Все diary-события батч-отмены получают ОДИН timestamp (W-3).

Тесты: `test_series_generation.py` (61xxx), `test_series_card.py` (62xxx,
+N+1-guard), `test_series_cancel_scope.py` (64xxx). Одиночная отмена (refund/audit/diary)
по-прежнему покрыта `test_cancellation.py` через `_cancel_one`.

---

### 3.14. Журнал школы — НЕ аудит, и объединять их нельзя (GT-16)

В дереве две похожие таблицы: `audit_logs` (`core/audit.py`) и
`curator_group_event` (`curator_groups/models.py`). Увидев их рядом,
естественно решить, что это одно и то же дважды. Это не так.

| | `audit_logs` | журнал школы |
|---|---|---|
| Кто читает | админ и юристы | куратор |
| Зачем | доказательство для разбирательства | «что у меня происходит» |
| Хранение | 5 лет по закону | живёт со школой, уходит с ней |
| Удаление | запрещено кодом | каскад от `curator_group.id` |
| Кто пишет | финансы и админские действия | действия участников |

**Решающее — каскад.** Удалили школу — журнал уходит вместе с ней.
`audit_logs` этого не допускает по определению: там нет `ON DELETE`, и не
должно быть.

**И `audit_logs` никто не читает.** Пересчитать:
`grep -rnE "select\(AuditLog|AuditLog\.__table__" backend/app/ --include=*.py`
→ **0**, при **36** вызовах `record_audit(`. Пишущий-только стол.

> **Грепать `select(AuditLog`, а не `AuditLog` — второе ловит докстринги.**
> Не теория: первая попытка проверить это утверждение дала два вхождения в
> `app/modules` — и оба оказались **прозой из докстринга
> `CuratorGroupEvent`**, где `AuditLog` упомянут как образец формы. Проверка
> поймала собственный текст автора. Тот же класс, что «AST с вырезанными
> докстрингами» в правилах исполнителя.

Что у аудита **взято** — форма: индексированная строка `event`, `actor_id` без
ForeignKey, JSONB `data` под контекст. Что не взято — всё остальное.

---

### 3.15. `seq` есть порядок и не есть счёт (GT-16)

`curator_group_event` имеет UUID-первичный ключ **и** отдельную монотонную
колонку `seq` (`BigInteger, Identity(always=False), unique=True`). Сортировка и
пагинация — `ORDER BY seq DESC` и ничего больше. Три «почему»:

**Почему порядок не выведен из времени.** `created_at` — `server_default=func.now()`,
а `now()` в Postgres это **время транзакции**. Два события одного запроса
(переименование и правка описания в одном `PATCH`; см. 3.16) получают
байт-в-байт одинаковый `created_at`, и тай-брейк по случайному `uuid4` поставил
бы их в произвольном взаимном порядке. `clock_timestamp()` тоже отвергнут:
порядок, выведенный из часов, верен только пока никто не поменял способ
хранения времени. Монотонное целое **есть** порядок.
`created_at` отвечает на «когда», `seq` — на «в каком порядке»; это разные
вопросы, и таблица отвечает на них разными колонками.

**Почему `seq` не уходит наружу.** Прецедент монотонности — `OutboxEvent`
(`core/events/models.py`), но там целое **заменило** ключ, потому что `id`
аутбокса не покидает бэкенд: его читает реле. Здесь `id` возвращается человеку,
а глобально монотонное целое в ленте одного куратора — счётчик активности всей
платформы: прочитал ленту дважды с интервалом, разница показала, сколько событий
было у всех остальных школ. Поэтому идентичность осталась UUID и уходит в ответ,
а порядок живёт в `seq`, который не уходит.

**Почему дыры нормальны и разность ничего не считает.** Последовательность общая
для всех школ и не откатывается: неуспешное действие (409 на дублирующем имени
школы) съедает значение и оставляет разрыв. Разрывы — норма. Разность двух `seq`
**не считает ничего** — ни событий этой школы, ни событий вообще; кто построит
на ней «сколько всего было», прочитает гарантию, которой не давали.

**`seq` — порядок ВСТАВКИ, не порядок коммита.** Две параллельные транзакции
могут взять 5 и 6 и закоммититься наоборот. Для ленты одной школы безразлично
(действия одного куратора последовательны), но записано, потому что иначе
следующий выведет из колонки то, чего она не обещает. Аутбокс живёт с тем же
свойством.

---

### 3.16. Актор и объект заморожены в `data` — это денормализация, а не небрежность (GT-16)

`curator_group_event.actor_id` — **без ForeignKey**, как `AuditLog.actor_id`
(пересчитать: у обоих `len(column.foreign_keys) == 0`). Строка должна пережить
человека, а FK с `ON DELETE SET NULL` пришёл бы к тому же ценой констрейнта,
единственная работа которого — стирать историю.

Два следствия, оба неочевидные:

- **Удаление пользователя `actor_id` НЕ обнуляет** — обнулять нечему. Значит
  `actor` в ответе **не nullable**, и ветку под `null` заводить нельзя: это
  колонка под состояние, которого writer не производит. `actor_id` объявлен
  `nullable=False`.
- **Живой join к `users` превратил бы историю в пересказ настоящим временем.**
  «Мария удалила Петра» должно остаться про Марию после того, как Мария сменила
  имя или ушла. Поэтому имя актора **копируется в `data` в момент записи**, и
  чтение журнала не делает ни одного join'а к `users`.

**Заморожены ОБЕ стороны фразы.** У четырёх событий из четырнадцати актор и
объект — разные люди (`member_removed`, `transfer_offered`, `transfer_accepted`,
`transfer_declined`/`_cancelled`), и `data` несёт пару
`target_user_id` + `target_name`. Замороженный актор рядом с живым объектом дал
бы «Мария удалила `9f3c…`» — ровно ту бесполезность, против которой заморожен
актор. Имя актора бесплатно (объект `User` на руках у всех точек записи), имя
объекта стоит одного `SELECT` по первичному ключу, и он куплен сознательно.

У `transfer_accepted` объект — **прежний** куратор, и он берётся из локальной
переменной, захваченной ДО присваивания `group.curator_user_id`. После
присваивания прежнего владельца в функции нет, и «текущий куратор школы» на
момент записи — это уже актор: получилась бы запись «Пётр принял школу от
Петра».

**Единственный писатель — `_record_group_event`.** Пересчитать:
`grep -c "CuratorGroupEvent(" app/modules/curator_groups/service.py` → **1**,
внутри хелпера; ORM-строку журнала не создаёт больше никто.
`grep -c "_record_group_event(" …` → **16**, то есть **одно определение и 15
вызовов** при **14** видах событий. Оба расхождения ожидаемы, и вот почему:
15 вызовов на 14 видов — потому что `member_promoted` пишется из двух мест
(обычное повышение и ветка проигранной гонки в `join_curator_group_by_token`).

**Токен инвайта и URL аватара в `data` не попадают ни при каких условиях.**
Токен — сырой секрет (`secrets.token_urlsafe(32)`), а журнал — читаемая лента с
пагинацией; события инвайтов пишут ВИД ссылки, не значение. URL умрёт, а журнал
живёт вечно, поэтому `group_avatar_changed` несёт `had_avatar_before: bool`, а не
ссылку. Контракт `data` по каждому виду — таблица в докстринге
`CuratorGroupEvent`, и она **сверяется машинно** (скрипт по AST против ключей,
которые кладут писатели); копия здесь была бы вторым реестром.

---

### 3.17. Право заводить школы — флаг в JSONB, гейт в одной точке (GT-15)

`MasterProfile.data.account.can_create_groups: bool` — право, выданное админом,
а не настройка мастера. Тот же класс schema-on-read, что **3.7** (onboarding в
`credentials`) и **3.8** (taxonomy в `data`); лежит в `account`, потому что рядом
уже `status`, `verification`, `rejections` — всё решения админа об аккаунте.

**Ключ написан один раз.** `CAN_CREATE_GROUPS_KEY` объявлен в
`curator_groups/service.py` и импортируется всеми писателями (`admin/masters`
verify и тоггл, `scripts/seed.py`) и читателями. Причина — та, что названа в
докстринге `masters/models.py`: `data` — словарь без модели, опечатка в ключе не
падает, а тихо возвращает `None`, и мастеру сообщили бы о праве, которого у него
нет.

**Гейт — одна точка.** `create_curator_group`, и только она: пересчитать —
`_can_create_groups_exists` используется в `service.py:530` и больше нигде.
Остальные кураторские эндпоинты флаг **не проверяют**, они про уже
существующую школу.

**Флаг означает «может завести НОВУЮ школу», а не «может владеть».** Принятие
передачи флага не спрашивает — намеренно: куратор, решивший отдать школу, должен
иметь кому, а у мастеров-участников флага обычно нет, и гейт на передаче запер
бы школы на владельцах, которые хотят уйти, оставив удаление единственным
выходом.

**Отзыв флага ничего не морозит.** Он закрывает создание и больше ничего:
уже созданные школы работают полностью. Рычаг «заморозить всё, что человек
собрал», — `revoke_master`, и он остаётся единственным. Второй способ сделать то
же самое означал бы два механизма, обязанных согласовываться.

Отказ — свой код `group_creation_not_allowed` (403), **не**
`master_profile_not_verified`: мастер верифицирован, и «профиль не подтверждён»
отправило бы его чинить то, что не сломано.

---

### 3.18. URL от пользователя: `max_length` меряет НЕ то, что ляжет в колонку

Правило шире школ и адресовано тому, кто заведёт следующее URL-поле.
`curator_group.avatar_url` — первый в этом бэкенде URL, приходящий **от
пользователя**: все остальные `avatar_url` копируются из Telegram, все
zoom-ссылки строит Zoom API.

**`UrlConstraints(max_length=N)` проверяет длину ТОГО, ЧТО ПРИШЛО.** Pydantic
нормализует URL **после** — punycode для хоста, percent-encoding для пути, — и
результат может быть в разы длиннее. Измерено, не предположено:

```python
"https://пример.рф/" + "я" * 200 + ".png"   # 222 символа на входе
# проходит max_length=500 и становится 1234 символа в str(value)
```

Для русскоязычного продукта кириллический путь — норма, а не экзотика. Без
второй проверки валидный по схеме URL доезжает до `VARCHAR(500)` и возвращается
ошибкой базы вместо 422.

**Проверять надо длину сохраняемой строки** — `AfterValidator`, сравнивающий
`len(str(value))` с шириной колонки. Тогда «строка не влезла» перестаёт быть
состоянием, которое сервис должен обрабатывать: его не существует.

Побочно из этого следует форма колонки: `avatar_url` — `String(500)`, а не
`Text` со схемной шапкой (как `curator_group.description`). Число должно быть в
колонке, потому что схеме нужно с чем сравнивать.

**Схема URL — allow-list из одного `https`,** а не запрет трёх плохих:
`javascript:`, `data:`, `file:` закрываются тем же пунктом, что и любая схема, о
которой никто не подумал. `http` исключён не для красоты — это mixed content на
https-странице, картинка всё равно не отобразится. Белого списка **хостов** нет
намеренно: куратор кладёт картинку со своего сайта, и список превратился бы в
поддержку, которую никто не ведёт.

**Проверки доступности URL нет и не должно быть.** Фолбэк уже есть на фронте
(`VAvatar.vue` падает на инициалы по `@error`, Фронтовый Кодекс §3). Запрос к
произвольному пользовательскому URL с бэкенда — это SSRF-поверхность, заведённая
ради задачи, которую клиент уже решил.

---

## 4. Платёжная архитектура

### 4.1. Double-Entry принцип

Каждая операция — две записи. Сумма всех записей в системе = 0 всегда.

Три журнала:

| Журнал | Таблица | Содержимое |
|--------|---------|------------|
| User Ledger | `user_ledger` | Пополнения, списания, возвраты юзера |
| Master Ledger | `master_ledger` | Продажи (frozen -> available), комиссии, выводы |
| Company Ledger | `company_ledger` | Комиссии, маркетинг, возвраты |

В `master_ledger` есть флаг `is_frozen`: деньги locked до завершения практики.
В `MasterProfile` — кэшированные поля `frozen_cents` и `available_cents`, обновляемые listeners при каждой записи в ledger.

**Прямое изменение балансов запрещено.** Только через ledger-записи + listeners.

### 4.2. Stripe интеграция

Топап-флоу: `POST /payments/topup` → Stripe Checkout Session → webhook `checkout.session.completed` → `UserLedger(+N)` + `CompanyLedger(-N)`.

Stub-режим (`STRIPE_SECRET_KEY="TEST"`): обходит Stripe, мгновенно подтверждает оплату. Только для разработки.

### 4.3. Вывод средств

Флоу: `POST /masters/me/withdraw` (freeze) → admin approve/reject → `MasterLedger(-N frozen)` + `CompanyLedger(+fee)` + `Payment(OUT)`.
Минимальная сумма: `MIN_WITHDRAWAL_CENTS` (дефолт 5000 = €50).
Комиссия за вывод: `WITHDRAWAL_FEE_CENTS` (дефолт 200 = €2).

CR-01: `MasterProfileResponse` возвращает `min_withdrawal_cents` и `withdrawal_fee_cents` из settings. Фронтенд берёт лимиты из API, не хардкодит.

---

## 5. Уведомления

### 5.1. Архитектура

Два уровня:
- `Notification` — что отправить, кому (channel-agnostic).
- `NotificationDelivery` — конкретная доставка: юзер + канал + статус.

### 5.2. Процессор

Фоновая задача (`notifications/processor.py`). Забирает pending Notification, резолвит target → список юзеров, создаёт `NotificationDelivery` per-user, отправляет через channel-formatter.

**Запуск процессора управляется флагом** `notification_processor_enabled: bool = True`
(`core/config.py`). В `main.py` lifespan читает флаг ДО `create_task(run_processor())`:
при `False` фоновая задача не стартует (лог `notification_processor_disabled`).
Safe default — в production флаг включён.

> **Почему флаг (root-cause флака теста доставки, 24 мая 2026):** тесты гоняются
> через `ASGITransport(app=app)`, что активирует lifespan → фоновый `run_processor()`
> крутится в том же event loop, что и тело теста. Процессор забирает delivery-строки
> через `FOR UPDATE SKIP LOCKED`; когда тест вручную вызывал `_stage_deliver()`,
> фоновый цикл успевал залочить ту же строку → ручной вызов её пропускал → `attempts`
> оставался 0 (тест ждал 1). Гонка таймингова (не зависела от порядка тестов —
> `pytest-randomly` не стоит). Лечится на уровне конфига, а не патчингом теста:
> `conftest.py` в session-autouse `setup_infrastructure` (ДО миграций и lifespan)
> ставит `settings.notification_processor_enabled = False`. Тесты, которым нужен
> процессор, вызывают его шаги вручную и детерминированно.

### 5.3. Шаблоны

Языки: `ru`, `en`, `de`, `es`. Файлы: `notifications/templates/{lang}.yaml`.
Язык выбирается по `User.language`. По умолчанию: `en`.
Перезагрузка без рестарта: `POST /api/v1/admin/templates/reload`.

### 5.4. Напоминания

Создаются с `scheduled_at = practice.scheduled_at - N` при бронировании.
Отменяются при отмене бронирования или практики.
Пересоздаются при изменении времени практики.
5-минутный буфер: напоминания за < 5 минут не создаются.

---

## 6. Data Consistency Семафоры — [УДАЛЕНО 2026-07-07, `9ca5619`]

**Built in Phase 6.8, removed whole in `9ca5619` (operator call, "chore(admin): remove
data-integrity semaphores feature entirely (A3)").** Deleted: `admin/consistency/` package
(models/service/router, 21 semaphores across 5 categories), `AdminConsistencyView.vue`,
`test_admin_consistency.py`, `repair_semaphore_2x.py`, and the doc referenced below
(`VELO-Data-Consistency-Semaphores.md` — no longer exists). `GET /api/v1/admin/consistency`
is gone; nothing in the current codebase runs these checks. Kept below **as history only** —
do not treat any of it as describing live behavior.

Historical description: a set of checks for detecting data desync, run via
`GET /api/v1/admin/consistency`.

Категории (as they existed):

| Категория | Пример |
|-----------|--------|
| **COUNT = COUNT** | bookings ↔ purchases, users(role=master+admin) ↔ master_profiles |
| **SUM = 0** | Σ(user_ledger + master_ledger + company_ledger) = 0 |
| **Computed = Actual** | `User.balance_cents` = SUM(user_ledger), `MasterProfile.available_cents` = SUM(master_ledger WHERE NOT frozen) |
| **Orphan Detection** | booking без practice = 0, notification_delivery без user = 0 |
| **Invariants** | Отрицательный баланс = 0, frozen у завершённой практики = 0 |

---

## 7. Конфигурация

Все параметры в `app/core/config.py`, загружаются из `.env`.
Ключевые:

| Переменная | Дефолт | Описание |
|-----------|--------|---------|
| `APP_ENV` | `development` | Среда (`development` / `production`) |
| `SECRET_KEY` | — | Обязателен в production |
| `DATABASE_URL` | — | Обязателен в production |
| `TELEGRAM_BOT_TOKEN` | `""` | Токен бота |
| `TELEGRAM_BOT_URL` | `""` | URL бота для deep links |
| `STRIPE_SECRET_KEY` | `""` | Stripe API key (`"TEST"` = stub mode) |
| `STRIPE_WEBHOOK_SECRET` | `""` | Stripe webhook signature |
| `COMMISSION_PERCENT` | `15` | Комиссия платформы (%) |
| `MIN_WITHDRAWAL_CENTS` | `5000` | Минимальный вывод (€50.00) |
| `WITHDRAWAL_FEE_CENTS` | `200` | Комиссия за вывод (€2.00) |
| `CANCELLATION_DEADLINE_HOURS` | `24` | Дедлайн бесплатной отмены |
| `CHECKIN_WINDOW_HOURS` | `24` | За сколько часов до открывается check-in (3 -> 24, запрос заказчика 2026-06-03) |
| `FEEDBACK_WINDOW_HOURS` | `72` | Сколько часов после практики открыт feedback |
| `SESSION_TTL_DAYS` | `30` | Срок жизни сессии Redis |
| `LOG_LEVEL` | `INFO` | Уровень логирования |

**Пороги фильтров Календаря** (settings в `config.py`, НЕ env — внутренние константы, NO-LITERALS):

| Параметр | Дефолт | Назначение |
|----------|--------|-----------|
| `practice_duration_long_min_minutes` | `60` | Граница `duration_bucket`: short < N, long >= N |
| `practice_time_night_start_hour` | `0` | Начало корзины «ночь» (локальный час) |
| `practice_time_morning_start_hour` | `5` | Начало «утро» |
| `practice_time_day_start_hour` | `12` | Начало «день» |
| `practice_time_evening_start_hour` | `17` | Начало «вечер» (до 24) |

Корзины полусегментные `[start, next_start)`: night [0,5), morning [5,12), day [12,17), evening [17,24).
En-значения query-параметров (`short|long`, `night|morning|day|evening`) остаются `Literal` в роутере.

---

## 8. Тесты

Все запускаются внутри Docker:

```bash
velo test          # все тесты
velo lint          # ruff check
```

**Числа прогона здесь нет намеренно.** Раньше в этой строке стояло
«615 passed, 12 skipped»; на 2026-09-02 фактический прогон дал 1522 passed,
3 skipped — расхождение в 2.5 раза, и никто его не заметил, потому что
пересчитать число можно только запустив сьюту. Кодекс говорит, **чем
измерить**, а не чем измерили однажды: `velo test` печатает актуальное.

### Диапазоны `telegram_id` — живой реестр, не таблица

**Единственный источник — `backend/tests/telegram_id_bands.py`**, который
парсит объявления `_TID_MIN`/`_TID_MAX` из самих тест-файлов. Он заменил собой
удалённый `docs/telegram-id-bands.md`, и по той же причине здесь больше нет
таблицы: **таблица в Кодексе была вторым реестром и разошлась с первым.**
Она называла «admin | 87xxx», тогда как `87000-87999` держит
`test_diary_entries.py` — то есть уже вводила в заблуждение.

Напечатать текущее состояние:

```python
# из backend/
python3 -c "
import sys; sys.path.insert(0,'.')
from tests.telegram_id_bands import declared_bands, find_overlaps, free_windows
for b in sorted(declared_bands(), key=lambda x: x.low):
    print(f'{b.low}-{b.high}  {b.file}')
print('overlaps:', len(find_overlaps()))
print('free in 65000-65999:', free_windows(space=(65000, 65999)))
"
```

Реестр же и **проверяется** сьютой (`test_telegram_id_bands.py`): файл,
использующий id без объявления банда, падает на
`test_blind_zone_has_not_grown`; дефолтный `telegram_id` вне своего банда — на
`test_no_default_id_sits_outside_its_own_band`. Ручная таблица так себя
проверять не может, и именно поэтому её нет.

Линия школ (GT-9…GT-17) занимает три кластера: `65000-65599` (право заводить
школы / журнал / аватар), `66000-66799` (группы / страница / инвайты /
передача), `68000-68399` + `69000-69099` (аудитория практик / advisory /
админский список).

> **Развод диапазона 56xxx (TD-TGID-56XXX, закрыт 24 мая):** изначально
> `test_master_public.py` занимал весь 56000-56999 и пересекался с
> `test_admin_masters.py` (56001-56010 аппликанты, 56900-56907 админы) по id
> 56001/56900 — оба модуля ещё и чистили весь 56xxx (`cleanup_range(56000,56999)`).
> Зелено держалось только на cleanup между модулями — хрупко. Исправлено: master_public
> перенесён в компактный **56500-56599** (мастер 56501, вьюеры 565xx, админ 56590) и
> чистит ТОЛЬКО свой поддиапазон. admin_masters не тронут (остаётся в 560xx/569xx).

> **Пересечение диапазона 63xxx (TD-TGID-63XXX) — ✅ ЗАКРЫТО (июнь 2026):**
> `test_series_cancel_scope.py` (E3) изначально занял **63xxx**, который уже
> использует `test_attendance.py` (§3.12) — оба брали 63001/63900 и чистили весь
> `full_cleanup_range(63000, 63999)`. Зелено держалось только на последовательном
> прогоне (без xdist) + per-test cleanup — та же хрупкость, что закрыл TD-TGID-56XXX.
> Исправлено: cancel-scope-тесты перенесены на свободный **64xxx** (мастер 64001,
> админ 64900) и чистят только `full_cleanup_range(64000, 64999)`.
> `test_attendance.py` не тронут (остаётся в 63xxx, теперь единолично).

---

## 9. Технический долг

### Обозначения

- **Среда:** 🧪 низкий приоритет / 🚀 перед публичным запуском
- **Статус:** ⬜ Open / ✅ Done

### Перед публичным запуском 🚀

| ID | Файл | Описание | Решение |
|----|------|----------|---------|
| **TD-RU-PROXY** | Инфра | Hetzner IP заблокирован ТСПУ. Недоступен из России без VPN | Российский reverse proxy (Timeweb/Selectel ~300-500₽/мес) или DDoS-Guard CDN |
| **AUDIT-0520-01** 🔴 | `payments/stripe.py` | Stripe `amount_total=None` обходит проверку суммы: `if stripe_amount is not None and ...` -> при отсутствии суммы блок пропускается, баланс кредитуется без верификации | Инвертировать: `if stripe_amount is None or stripe_amount != payment.amount_cents:` -> mark FAILED. + тест на `amount_total=None` (AUDIT-0520-09) |
| **AUDIT-0520-02** 🔴 | `practices/schemas.py` | `zoom_link` принимает любую строку (только max_length), вкл. `javascript:...` -> XSS если фронт рендерит как href. Нет валидатора ни в Create, ни в Update. **Частично смягчено на фронте (2026-05-21):** экран 14 открывает ссылку через `platform.openLink` только при `https://`-схеме, кнопка дизейблится иначе — но это НЕ заменяет серверную валидацию | `@field_validator("zoom_link")`: требовать `https://` schema (или пустоту/None). Остаётся открытым на бэке |
| **CRITICAL-4** | `auth/router.py` | Нет rate limiting на `POST /auth/telegram`. Replay valid initData в 5-минутном окне → тысячи Redis-сессий | `slowapi` или Redis-based limiter |
| **WARNING-4** | `auth/router.py` | Telegram initData replay в 5-минутном окне — нет защиты от повторного использования | Redis SET `used_init_data:{hash}` с TTL 5 минут |
| **WARNING-5** | `payments/webhook.py` | Stripe webhook signature не проверяется при `STRIPE_STUB=true` | Запрет `STRIPE_STUB` в production через config validator |
| **CAL-W1** 🔴🚀 | `core/config.py` | **Проверить, не затёрт ли startup-`model_validator` Stripe-ключей при правках config в Calendar iteration.** Если валидатор пропал — production может стартовать с пустыми Stripe-ключами и упасть только при первой оплате | Сверить текущий `config.py` с дореитерационным; восстановить `model_validator`, проверяющий наличие ключей в `APP_ENV=production`. Найдено аудитом Calendar (W-1), принято в техдолг |
| TD-025 | Все роутеры | Нет rate limiting на masters endpoints. **(подтверждено аудитом 2026-05-20: распространить и на топап `POST /payments/topup` и покупку `POST /practices/{id}/purchase`)** | `slowapi` или Redis-based custom limiter |
| TD-026 | `docker-compose.yml` | Redis без пароля | `requirepass` + `REDIS_PASSWORD` в .env |
| **AUDIT-0520-03** 🟡🚀 | `core/middleware.py` | `_extract_client_ip` берёт первый элемент `X-Forwarded-For` без проверки trusted proxy -> клиент может подделать IP в audit log финансовых операций | Доверять XFF только от известного прокси (Nginx); или брать N-й справа hop; список trusted proxies в config |

### Открытые находки

| ID | Среда | Файл | Описание | Решение |
|----|-------|------|----------|---------|
| **CRITICAL-3** | 🚀 | `payments/service.py` | `record_master_ledger` при отсутствующем `MasterProfile` создаёт ledger entry но не обновляет кэшированный баланс → расхождение | Бросать `BadRequestError` вместо silent continue |
| **WARNING-2** | 🧪 | `main.py` | Глобальный 500-обработчик без `request.method` и `trace_id` в логах | Добавить контекст запроса в exception handler |
| **WARNING-14** | 🧪 | `*/service.py` | Сервисы импортируют `settings` напрямую — затрудняет unit-тестирование | Инъекция через параметры или DI |
| TD-013 | 🧪 | `migrations/env.py` | Engine не dispose если `connect()` упадёт | `try/finally` вокруг async with |
| TD-014 | 🧪 | Несколько файлов | Версия `0.1.0` захардкожена в трёх местах | Единый источник в `config.py` или `__version__` |
| TD-015 | 🧪 | `config.py` | `postgres_password` дефолт `"velo"` без проверки в проде | Validator аналогично `SECRET_KEY` |
| TD-017 | 🧪 | `alembic.ini` | Placeholder URL в `sqlalchemy.url` | Убрать или заменить на комментарий |
| TD-022 | 🧪 | `auth/schemas.py` | `balance_cents` в `AuthResponse` — всегда 0 до платежей | Убрать или оставить осознанно |
| TD-024 | ✅ | `users/models.py` | `User` не наследовал `JSONBMixin` для `credentials` | ЗАКРЫТО (onboarding flow): `User` наследует `JSONBMixin`, мутация через `set_jsonb("credentials", ...)` в `update_user`. См. 3.7 |
| TD-F7-W5 | ✅ | `masters/models.py` | `payout_details: dict` — содержимое не типизировано | CR-01: `WithdrawalResponse.payout_details` и `AdminWithdrawalResponse.payout_details` теперь типизированы как `PayoutDetails` |
| TD-W01 | 🧪 | `bookings/service.py` | Нет cron для экспирации `NOTIFIED` waitlist-записей | Cron job или processor расширить |
| PERF-04 | 🚀 | `notifications/service.py` | `_resolve_target_users` для ALL и ROLE загружает все user IDs в память | Batched processing при росте базы (10k+) |
| **AUDIT-0520-04** | 🧪 | `core/database.py` | `get_db_reader` не делает `SET TRANSACTION READ ONLY` — случайная мутация в reader-сессии не блокируется на уровне БД, только откатывается в конце (TD-008, ранее жил только в докстринге) | `await session.execute(text("SET TRANSACTION READ ONLY"))` в начале reader-сессии |
| **AUDIT-0520-05** | 🧪 | `payments/refund.py` | `_get_master_frozen_amount` и `_is_company_promo` оба делают `session.get(Promo, ...)` одного объекта — дублирование. Identity-map сессии смягчает реальный hit к БД, но логика дублирована | Загрузить Promo один раз, передавать в обе функции (или объединить) |
| **AUDIT-0520-06** | 🧪 | `admin/withdrawals/service.py` | Устаревший count-паттерн (не subquery, как в B-05/B-09 для прочих модулей) | Унифицировать на subquery-паттерн |
| **AUDIT-0520-07** | 🧪 | `payments/purchase_router.py` | `Practice` загружается дважды при покупке с промокодом (узкое окно). FOR UPDATE защищает от гонки -> перф-нюанс, не корректность | Переиспользовать загруженный объект |
| **AUDIT-0520-08** | 🧪 | `payments/refund.py` | `update(Waitlist).values(status=...)` (bulk core UPDATE) не обновляет `Waitlist.updated_at` | Добавить `updated_at=func.now()` в `.values(...)` или onupdate-триггер для bulk |
| **AUDIT-0520-09** | 🧪 | `tests/` | Нет теста на Stripe `amount_total=None` (кейс AUDIT-0520-01) | Тест: webhook без `amount_total` -> payment FAILED, баланс не кредитуется |
| **AUDIT-0520-S** | 🧪 | разное (SUGGESTION) | Унификация count-паттерна в 3 модулях (см. B-05/B-09); вынос `recalculate_participants` (см. TD-034); обновление Stripe SDK до v9 | Низкий приоритет, по мере касания кода |
| **CAL-FLAKE** | ✅ | `tests/test_notifications.py`, `core/config.py`, `main.py`, `tests/conftest.py` | Флак `TestStageDeliver::test_failed_delivery_retries` (attempts 0 вместо 1): фоновый `run_processor()` под `ASGITransport` lifespan гонялся с ручными `_stage_*` через `FOR UPDATE SKIP LOCKED` | ЗАКРЫТО (24 мая): флаг `notification_processor_enabled` (safe default True); тесты выключают его в session-autouse `setup_infrastructure`. Детали — §5.2 |
| **TD-TGID-56XXX** | ✅ | `tests/test_master_public.py` | Диапазон `telegram_id` 56xxx пересекался между master_public (был 56000-56999) и admin_masters (56001-56010, 56900-56907); оба чистили весь 56xxx — зелено только из-за cleanup между модулями, хрупко | ЗАКРЫТО (24 мая): master_public перенесён в 56500-56599 (мастер 56501, вьюеры 565xx, админ 56590) и чистит только свой поддиапазон. admin_masters не тронут |
| **TD-NOTIF-RACE** | 🧪 | `tests/test_notifications.py`, `notifications/processor.py` | Рецидив `CAL-FLAKE` после ввода второго live-воркера (авто-финализатор, см. блок-цитату ниже). Постоянный `app`-контейнер крутит lifespan-`run_processor`; тесты `exec`-аются в ТОТ ЖЕ контейнер. Стейдж-тесты зовут ГЛОБАЛЬНЫЕ `_stage_resolve/_stage_deliver/_stage_rollup` (без scope — селектят по всей таблице через `FOR UPDATE SKIP LOCKED`), live-процессор гоняется с ними → нотификация застревает в `processing` или `resolved=0`. Флаг `notification_processor_enabled` НЕ помогает: conftest гасит воркер в pytest-процессе, а не в live-uvicorn того же контейнера. Изолированный прогон `pytest tests/test_notifications.py` всегда зелёный | Временно: 3 класса под `@pytest.mark.skip` — `TestStageResolve`, `TestStageDeliver`, `TestRollup` (единственные, кто зовёт глобальные `_stage_*`). Постоянно: опциональный параметр `scope` стадиям (трогает `processor.py`) — тест дёргает стадию только по своему диапазону; ЛИБО одноразовый тест-контейнер без live-воркеров. Прочие классы нотификаций (`TestCreateNotification/TestTargetResolution/TestTemplateEngine/TestTelegramFormatter`) не тронуты |
| **TD-LOCK-AUTOGEN** | 🧪 | Инфра, `install_velo.sh` (секция `update`) | `package-lock.json` синхронизируется с `package.json` вручную. Сервер эфемерный (сносится по плану), `npm ci` в `frontend/Dockerfile` требует синхронный lock из репозитория — рассинхрон валит сборку фронта при пересоздании сервера | Автогенерировать и пушить `package-lock.json` в репозиторий при смене зависимостей — ровно как `generated.ts` (`velo update` его регенерирует и коммитит, «Types are in sync»). Хук — рядом с генерацией типов в секции `update`: при изменении `package.json` → `npm install --package-lock-only` → commit/push lock |
| **TD-CONFIG-FE-MIRROR** | 🧪 | `core/config.py`, `frontend/src/utils/constants.ts` | Числовые настройки, нужные и бэку, и фронту (`checkin_window_hours`/`CHECKIN_WINDOW_H`, `feedback_window_hours`/`FEEDBACK_WINDOW_H`, лимиты вывода), зеркалируются во фронт ВРУЧНУЮ — фронт собирается в статику и не читает `settings` в рантайме. При смене значения легко забыть обновить вторую сторону → расхождение окон UI vs бэк. Значения меняются крайне редко (окно чек-ина 3→24 за всё время — единственная смена), поэтому ручное зеркало пока приемлемо | Устранимо только инфраструктурой, не уборкой: либо рантайм-эндпоинт `GET /api/v1/config` (фронт тянет значения на старте; +сетевой запрос на крит. пути загрузки, +состояние «ещё не загружено»), либо расширить кодогенерацию (`generate_ts_types.py`) на числовые константы из конфига в `generated.ts` (правка генератора; значения уедут в автоген, который «MUST NOT edit by hand»). Делать как отдельную задачу с проектированием, НЕ заодно. Низкий приоритет (значения статичны) |

> **Источник AUDIT-0520-*:** полный аудит ветки main от 2026-05-20.
> Отчёт: `docs/01_refer/ARCHIVES/CODE-AUDIT/PROBKIT-REVIEW/2026-05-20-full-audit.md` (оценка 7/10).
> Циклические импорты через lazy import, отмеченные аудитом, — осознанное решение
> проекта (см. ТЗ Phase 5.3 / 6.4), НЕ техдолг.

> **Аудит Calendar iteration (2026-05-22, оценка 7/10):**
> отчёт `docs/01_refer/ARCHIVES/CODE-AUDIT/PROBKIT-REVIEW/2026-05-22-calendar-iteration.md`.
> - **C-1** (роутер импортировал приватную `_user_flags_for_practices`) — ✅ устранено
>   через публичную `get_practice_detail()` в сервисе.
> - **W-2** (граница недели в локальном TZ vs UTC-фильтр) — ✅ устранено буфером ±1 день
>   в `frontend/src/stores/calendar.ts` (клиент группирует по `calendarDateInTz`,
>   лишние дни не протекают в неделю).
> - **W-1** (Stripe startup-валидатор) — ⬜ в техдолге (CAL-W1 выше).
> - **W-3** (EditPracticeView молча проставляет `meditation/beginner` старым практикам
>   без таксономии) — won't fix: БД сносится после каждого обновления кода, практик без
>   таксономии не существует; ветка недостижима. Пересмотреть, если появится импорт
>   практик извне или миграция без сноса БД.
> - 5 SUGGESTION — открыты, низкий приоритет, см. отчёт.

> **Аудит итерации «Профиль» (2026-05-29):**
> - **W-1** (`practices/service.py` `update_practice`) — ✅ устранено: при PATCH
>   `style` без `direction` сервис ре-валидирует против СОХРАНЁННОГО direction
>   (`_validate_style_for_direction` из schemas), невалидная пара -> 400. Закрыло
>   и **S-5** (функция-валидатор теперь переиспользуется и в service, не только в
>   schemas). **W-4** — добавлены 3 теста (`test_update_style_rejected_for_wrong_direction`,
>   `..._for_styleless_direction`, `..._accepted_for_same_direction`).
> - **W-3** (replay-окно initData после удаления anti-replay) — ⬜ осознанный
>   компромисс, не код: приемлемо в Telegram-контексте (HTTPS + rate-limit),
>   задокументировать в threat model; пересмотреть при server-side push/критичных
>   операциях.
> - **S-3** (`bookings/service.py` `hours_attended` — banker's rounding в `round()`)
>   — ⬜ безвреден для статистики; заменить на `Decimal`, если значение пойдёт в
>   финансовые расчёты.

> **Итерация авто-финализации + таймзоны (2026-05-31):** переписана работа
> практик до рабочего состояния. Шесть батчей, все зелёные.
> - **Авто-финализация 24ч** — ✅ корень «зависших» практик: мастер забывал
>   финализировать вручную, практика навечно оставалась `scheduled/live`, деньги
>   заморожены. Фоновый воркер `bookings/autofinalize.py` (`run_autofinalizer`,
>   поллинг 5 мин, backoff, gate `practice_autofinalize_enabled`) добивает
>   просроченные через 24ч-потолок. `finalize_practice` расщеплён на
>   `_finalize_practice_core(actor=...)` (без auth/commit), тонкий owner-checked
>   `finalize_practice` (P-08, сигнатура та же) и системный
>   `auto_finalize_practice` (actor_type="system", actor_id=None, без owner-check).
>   `_claim_overdue_ids` — `FOR UPDATE SKIP LOCKED`, батч 50, своя короткая
>   транзакция. Тесты гасят воркер флагом в conftest (как процессор).
> - **Фильтр публичного фида по времени** — ✅ дефолтный фид (`list_public_practices`
>   без явного `?status=`) теперь отдаёт только `scheduled_at > now()`: начавшиеся/
>   прошедшие скрыты («можно ли ещё забронировать»). Явный `?status=` обходит гейт.
> - **`time_of_day` в поясе ЗРИТЕЛЯ** (Батч 5d) — ✅ фасет «утро/день/вечер»
>   теперь считает локальный час в таймзоне зрителя (`user.timezone`, фолбэк "UTC"),
>   а не практики: `_time_of_day_filter(time_of_day, viewer_tz)` подаёт строку пояса
>   в уже-параметризованный `_local_hour` (`func.timezone(tz, ts)` — bound-параметр,
>   не идентификатор, ORM-чисто). Фид аутентифицирован, `user` уже прокинут —
>   контракт API и фронт не менялись. Тест `test_filter_time_of_day_uses_viewer_timezone`
>   доказывает зависимость от пояса зрителя (практика в UTC@08:00 → morning для
>   UTC-зрителя, day для Asia/Bangkok-зрителя). Решение по таймзонам в целом —
>   Фронтовый Кодекс §10 (пояс профиля решает везде).
> - **TD-NOTIF-RACE** — второй live-воркер обострил гонку тест/процессор; 3 класса
>   под skip. См. «Открытые находки» выше.

> **Итерация P0 frontend-backlog + внешнее код-ревью + #3 (июнь 2026):** закрыт
> весь P0 фронт-бэклога, пройдено внешнее ревью ветки `test` (0 critical, 7/10),
> всё LIVE на `test` (564 passed). Детали контрактов — §2.
> - **E1/E2/E5/E9 + #3** — см. §2 (именованные отзывы; доход/лента мастера;
>   students CRM; admin metrics/revenue/practices + seed-выводы; cross-practice
>   лента отзывов). Переиспользование вместо дублирования: E9 revenue стоит на том
>   же ledger-слое, что E2; #3 берёт бакет/имя-хелперы из `diary.service` (S-2).
> - **W-1 (явка по PRE-чек-ину)** — ✅ ключевая правка. `joined_at` ставится ТОЛЬКО
>   через Zoom-join; при выключенном Zoom все confirmed уходили в `no_show`, что
>   блокировало `upsert_feedback` (требует attended) → у E1 не было данных. В общем
>   ядре `_finalize_practice_core` (используют и ручной `finalize_practice`, и
>   системный `auto_finalize_practice`) правило стало:
>   `confirmed + (joined_at IS NOT NULL OR есть PRE-Checkin) -> attended`, иначе
>   `no_show`. Деньги/diary-проекция не тронуты. Тесты — `test_finalize_attendance_checkin.py`
>   (оба пути, 95xxx). Фронт проверен: чек-ин Zoom-независим (баннер на дашборде +
>   кнопка на live-экране), цепочка к attended/E1 рабочая.
> - **W-3 (feedback-метрика ≤100%)** — ✅ `ratings` джойнятся к тем же attended-броням
>   периода (`Feedback → Booking` по `practice_id+user_id`, `status=attended`), так
>   что `left_review ≤ visited`. Регресс — feedback на no_show не считается.
> - **W-2 (семантика income)** — ✅ докстринги `finance_service`/`finance_schemas`
>   переписаны под «gross booked turnover» (frozen-продажи включены by design, чтобы
>   совпадать с лентой); **числа не менялись**.
> - **W-4 (role-switch defense-in-depth)** — ✅ вариант D: валидатор `config.py` при
>   `role_switch_enabled=True` пишет громкий WARNING в `velo.security` (ожидаемый шум
>   на TEST, сигнал тревоги в прод-логах). Env-гейт **невозможен**: `app_env` бинарный
>   (development/prod-grade), TEST сам prod-grade, флаг — единственный признак
>   test/prod. WARNING (не `raise`) Alembic-safe.
> - **S-1** — `delta_pct` только при `prev_income > 0` (убран `abs()`, ломавший знак
>   при отрицательном базовом периоде). **S-3** — фоллбэк имени мастера в admin
>   revenue → «Мастер»; в admin metrics `top_users` оставлено «Участник» (там это
>   участники, не мастера). **S-2** (дубли хелперов) — частично закрыт переиспользованием
>   в #3; остальное — низкоприоритетный рефактор-долг.
>
> **Авто-финализация — актуальное состояние (supersedes блок «24ч» от 2026-05-31):**
> воркер `bookings/autofinalize.py` (`run_autofinalizer`, запущен в `main.py` lifespan,
> gate `practice_autofinalize_enabled=True`, off только в тестах) закрывает практики
> по **`scheduled_at + duration_minutes + buffer`** (`practice_autofinalize_buffer_minutes`,
> дефолт 15 мин), а НЕ по 24ч-потолку (24ч оставлен как extreme fallback). Поллинг
> 5 мин, backoff, `FOR UPDATE SKIP LOCKED`, батч 50, своя транзакция на практику.
> Это и есть «auto-complete по длительности» — фронт убрал ручную кнопку «Завершить»
> (`finalizePractice` без вызовов), бэкенд закрывает практики и освобождает frozen
> сам. **Финансовый тайминг:** разморозка + комиссия теперь оседают ~в конце практики
> (end+buffer), а не +24ч — осознанное решение, согласовать перед прод-нагрузкой.
> TD-NOTIF-RACE (3 класса нотификаций под skip из-за live-воркеров в тест-контейнере)
> — остаётся открытым (см. «Открытые находки»).

> **Эпик E3 (серии) + E7 (период-статы) + аудит ветки `test` (июнь 2026):**
> 615 passed, 12 skipped. Контракты — §2; механика серий — §3.13; период-математика
> — §1.2 (`core/periods.py`).
> - **E3** — `RecurrenceSpec` + генерация на публикации + серийная карточка
>   (2 запроса, без N+1) + отмена с охватом (`this`/`this_and_future`). Ноль
>   миграций (всё в `data.recurrence` + существующий `parent_practice_id`).
> - **E7** — `GET /masters/me/stats` и `GET /admin/stats/overview` (период-сетки с
>   дельтами); `core/periods.py` стал единым источником границ периода и
>   `delta_pct`/`delta_pp`; `finance_service` / admin revenue / admin metrics
>   перенесены на него (числа не менялись).
> - **Внешний аудит F8 (по `test`):** **W-1** (вырожденный `until_date` -> серия из
>   0 сессий) — ✅ 400 на ПУБЛИКАЦИИ (слой генерации, полнее схемной date-проверки:
>   ловит и same-day/too-early, не только прошлое; тест `..._rejected_on_publish`).
>   **W-3** (N diary-таймстемпов при bulk-отмене) — ✅ один общий timestamp.
>   **W-2** (нет теста cancel completed-root) — ✅ добавлен. **S-1** (импорт
>   приватных хелперов из `diary`) — ✅ публичные `ATTENTION_RATING_MAX` /
>   `rating_bucket`; **S-1c** (4 копии форматтера имени) — ✅ один
>   `users.helpers.display_name`.
> - **Отклонено с обоснованием:** **S-2** (жёсткий блок switch->admin) — фича
>   намеренная и gated (эндпоинт 404 в проде при `role_switch_enabled=False`,
>   громкий `velo.security` WARNING если включён, есть UI и зелёный тест); блок
>   сломал бы фичу и тест — оставлено как defense-in-depth (W-4). **S-3**
>   (`new_masters` по дате регистрации, не «стал мастером») — оставлено как
>   согласованная конвенция (аудит признал MVP-приемлемым), задокументировано в
>   `overview_service.py`.
> - **Поздний ре-флаг W-1 как «open»** — ложный: ревьюер сверял схему-валидатор, а
>   фикс намеренно на слое публикации (полнее). Схему НЕ трогаем «чтобы было».
> - **Фронт (W-5/W-6/W-7):** не бэкенд-скоуп — Фронтовый Кодекс §10. W-5
>   (`AdminWithdrawalDetailView` dead-end при deep-link) — pre-prod; W-6/W-7
>   (dashboard-статы из 20 броней; нет load-more) — задокументированный
>   MVP-компромисс.

---

## 10. Phase 9 (не начата)

| Задача | Статус | Описание |
|--------|--------|----------|
| AI-розетка | ✅ Заготовка | `app/modules/ai/interface.py` (Protocol) + `mock.py`, эндпоинт `GET /practices/{id}/ai-summary` возвращает placeholder |
| Library-розетка | ✅ Заготовка | Модель `Recording` (закомментирована) + TODO в коде |
| E2E-тестирование | ❌ | Основные flow: auth → practice → booking → payment → checkin → feedback → withdrawal |
| Load testing | ❌ | — |
| Security audit | ❌ | — |

---

## 11. Розетки

Заготовки, намеренно не реализованные в MVP. Интерфейсы определены, чтобы будущая реализация не ломала архитектуру.

### 11.1. AI-саммари

```python
# app/modules/ai/interface.py
class AIService(Protocol):
    async def generate_summary(
        self,
        practice_id: UUID,
        checkins: list[Checkin],
        feedbacks: list[Feedback],
    ) -> str: ...
```

### 11.2. Library (Записи практик)

Будущие таблицы: `recordings` (метаданные) + S3 для файлов. В коде — TODO-комментарии.

### 11.3. Подписки

Таблица `subscriptions` спроектирована, логика не реализована:

```python
class Subscription:
    plan: Enum          # monthly | yearly
    status: Enum        # active | cancelled | expired
    stripe_subscription_id: str
```

### 11.4. OAuth (Google, Apple)

`User.credentials` — JSONB, структура поддерживает несколько провайдеров:

```json
{
  "telegram": {"id": 123456789},
  "google":   {"id": "...", "email": "..."},
  "apple":    {"id": "..."}
}
```

---

**Конец документа**
