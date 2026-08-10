# VELO — Гайд для LLM: предсказуемые ошибки при реализации

**Цель:** Превентивный анализ ТЗ. Список паттернов ошибок, которые Claude (Opus) повторяет при реализации кода по VELO Technical Specification. Каждый паттерн подтверждён реальными находками из 8 раундов аудита.

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> STALE-BUT-HARMLESS — NOT rewritten this round; no line-level check was performed against
> current code for this pass (this doc wasn't named in the drift map's contradiction list).
> Treat all patterns here as unverified against current code.

**Как использовать:** Перед началом каждой фазы — прочитать соответствующие секции. После написания кода — проверить по чеклисту.

---

## Часть 1: Повторяющиеся паттерны ошибок

### P-01: Двойной коммит в роутере

**Найдено в:** Round 1 (auth/router.py), Round 2 (masters/router.py)

**Суть:** LLM вызывает `await session.commit()` в роутере, хотя `get_db_session()` уже делает commit после yield. Результат — двойной коммит, риск `InvalidRequestError` или частичного коммита.

**Где повторится:**
- Phase 2.3: `POST /admin/masters/{id}/verify` — после изменения `user.role` и `profile.data`
- Phase 3.3: `POST /reports` — после создания Report
- Phase 4.2: `POST /practices` — после создания Practice
- Phase 5.2: `POST /bookings` — после создания Booking + обновления `current_participants`
- Phase 6.3–6.8: ВСЕ финансовые операции (ledger записи)
- Phase 8: Check-ins, Feedbacks, Diary entries

**Правило:**
```python
# ЗАПРЕЩЕНО в роутерах:
await session.commit()

# ПРАВИЛЬНО:
await session.flush()        # получить DB-generated значения
await session.refresh(obj)   # загрузить обновлённые поля
# get_db_session() сделает commit сам
```

**Чеклист:** Grep `session.commit()` в каждом router.py. Если найден — баг.

---

### P-02: Pydantic `str | None` на NOT NULL колонку

**Найдено в:** Round 1 (users/schemas.py — timezone, language)

**Суть:** В Pydantic-схемах для PATCH-операций поля типа `str | None` принимают `null`. Если колонка в БД NOT NULL, отправка `{"timezone": null}` проходит Pydantic-валидацию, но вызывает 500 IntegrityError на коммите.

**Где повторится:**
- Phase 4.2: `PracticeUpdate` — поля `title`, `timezone`, `status` (все NOT NULL)
- Phase 4.4: `PracticePricingUpdate` — `currency` (NOT NULL, default "USD")
- Phase 5.2: Любые PATCH-схемы с NOT NULL полями
- Phase 8.3: `DiaryEntryUpdate` — `content` (NOT NULL)

**Правило:**
```python
# Для КАЖДОГО NOT NULL поля в Update-схеме — добавить валидатор:
@field_validator("title", "timezone", "status", mode="before")
@classmethod
def _reject_null(cls, v):
    if v is None:
        raise ValueError("This field cannot be set to null")
    return v
```

**Чеклист:** Для каждой Update-схемы: сверить поля с моделью. Если поле NOT NULL в модели, но `str | None` в схеме — нужен валидатор.

---

### P-03: JSONB мутация без `set_jsonb()`

**Найдено в:** Предупреждение из Round 2 (masters/service.py)

**Суть:** SQLAlchemy не видит изменения JSONB-колонок при прямом присвоении или in-place мутации. Данные молча не сохраняются.

**Где повторится:**
- Phase 2.3: Верификация мастера — `profile.data["account"]["status"] = "verified"`
- Phase 2.3: Отклонение мастера — добавление rejection в `profile.data["account"]["rejections"]`
- Phase 4.2: Если MasterProfile.data.stats обновляется при создании практики
- Phase 6.2: Balance listeners — если будут писать в JSONB
- Pre-6.2: AuditLog.data (если мутируется после создания)

**САМЫЙ ОПАСНЫЙ ВАРИАНТ ошибки (silent data loss):**
```python
# ❌ SQLAlchemy НЕ увидит это изменение:
profile.data["account"]["status"] = "verified"
# UPDATE не будет выполнен. Данные потеряны. Нет ошибки. Нет логов.

# ❌ Тоже не сработает:
new_data = profile.data.copy()
new_data["account"]["status"] = "verified"
profile.data = new_data
# shallow copy — SQLAlchemy может не заметить

# ✅ ЕДИНСТВЕННЫЙ правильный способ:
import copy
new_data = copy.deepcopy(profile.data)
new_data["account"]["status"] = "verified"
profile.set_jsonb("data", new_data)
```

**Чеклист:** Grep `\.data\[` и `\.data =` в service-файлах. Если найдено без `set_jsonb` — баг.

---

### P-04: `UUID()` без полного перехвата исключений

**Найдено в:** Round 3 (auth/dependencies.py), Round 4 (повтор в main)

**Суть:** `UUID(value)` бросает разные исключения в зависимости от типа value:
- `UUID("not-a-uuid")` → `ValueError`
- `UUID(None)` → `TypeError`
- `UUID(123)` → `AttributeError`
- missing key → `KeyError`

LLM ловит только `ValueError`, остальные улетают как 500.

**Где повторится:**
- Phase 2.3: `POST /admin/masters/{user_id}/verify` — парсинг user_id из path
- Phase 3.3: `POST /reports` — target_id
- Phase 4.2: `GET /practices/{id}` — practice_id из path
- Phase 5.2: `POST /bookings` — practice_id из body
- Phase 6: Все endpoint-ы с UUID в path/body

**Правило:**
```python
# Для парсинга UUID из недоверенных источников:
try:
    parsed = UUID(raw_value)
except (KeyError, ValueError, TypeError, AttributeError):
    raise SomeHttpError("Invalid ID") from None
```

**Важно:** FastAPI автоматически валидирует UUID path-параметры через Pydantic. Проблема возникает только при ручном парсинге UUID из dict/Redis/JSONB.

**Чеклист:** Grep `UUID(` в service-файлах. Если except ловит только `ValueError` — неполный.

---

### P-05: IntegrityError без savepoint (begin_nested)

**Найдено в:** Round 2 (masters/service.py — race condition на apply)

**Суть:** PostgreSQL при нарушении constraint (UNIQUE, FK, PK) переводит транзакцию в состояние "aborted". Любая следующая операция в этой сессии упадёт с `InFailedSqlTransaction`. Использование `session.rollback()` убивает ВСЮ транзакцию, включая FOR UPDATE-блокировки и предыдущие операции. Правильное решение — `session.begin_nested()` (SAVEPOINT): при IntegrityError откатывается только savepoint, внешняя транзакция остаётся живой.

**Где повторится:**
- Phase 5.2: Бронирование — `UNIQUE(practice_id, user_id)`. Два одновременных POST /bookings от одного юзера
- Phase 5.3: Waitlist — `UNIQUE(practice_id, user_id)`
- Phase 6.7: Promo — `UNIQUE(code)`. Два админа создают промокод с одинаковым кодом
- Phase 3.3: Report — если есть UNIQUE constraint

**Паттерн:**
```python
session.add(obj)
try:
    async with session.begin_nested():  # SAVEPOINT
        await session.flush()
except IntegrityError:
    raise ConflictError("Already exists") from None
```

**Почему НЕ `session.rollback()`:**
```python
# ❌ rollback() убивает ВСЮ транзакцию:
#    - FOR UPDATE блокировки теряются
#    - Ранее добавленные объекты (audit log и т.п.) теряются
#    - Session становится непредсказуемой
await session.rollback()

# ✅ begin_nested() создаёт SAVEPOINT:
#    - Откатывается ТОЛЬКО flush внутри savepoint
#    - Внешняя транзакция и все блокировки живы
#    - Можно продолжать работу в той же сессии
async with session.begin_nested():
    await session.flush()
```

**Чеклист:** Grep `IntegrityError` — если есть catch, проверить наличие `session.begin_nested()`. Наличие `session.rollback()` рядом с IntegrityError — баг.

---

### P-06: Отсутствие проверки ownership

**Найдено в:** Предупреждение из полного аудита (потенциал для IDOR)

**Суть:** При операциях с ресурсом (практика, бронь, дневник) не проверяется, что ресурс принадлежит текущему пользователю. Результат — IDOR (Insecure Direct Object Reference): юзер A может удалить практику юзера B, зная её UUID.

**Где повторится:**
- Phase 4.2: `PATCH/DELETE /practices/{id}` — только мастер-владелец
- Phase 5.2: `DELETE /bookings/{id}` — только тот, кто бронировал
- Phase 6.6: `POST /masters/me/withdraw` — проверить `user_id == current_user.id`
- Phase 8.3: `PATCH/DELETE /diary/{id}` — только автор
- Phase 6.7: `POST /masters/me/promos` — `master_id == current_user.id`

**Паттерн:**
```python
async def get_practice_for_owner(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
) -> Practice:
    practice = await get_practice(practice_id, session)
    if not practice:
        raise NotFoundError("Practice not found")
    if practice.master_id != user.id:
        raise ForbiddenError("Not your practice")
    return practice
```

**Чеклист:** Каждый PATCH/DELETE эндпоинт — проверить наличие `owner_id == user.id`.

---

### P-07: Race condition при конкурентных записях

**Найдено в:** Round 2 (masters/apply — два INSERT на один PK)

**Суть:** TOCTOU (Time-of-check to Time-of-use). Код проверяет условие (SELECT), потом действует (INSERT/UPDATE). Между проверкой и действием другой запрос может изменить состояние.

**Где КРИТИЧЕСКИ повторится:**

**Phase 5.2: Overbooking**
```python
# ❌ Race condition — два запроса видят current_participants=19 (max=20):
practice = await get_practice(id, session)
if practice.current_participants >= practice.max_participants:
    raise ConflictError("Practice is full")
practice.current_participants += 1  # оба ставят 20

# ✅ Атомарный инкремент:
stmt = (
    update(Practice)
    .where(Practice.id == practice_id)
    .where(Practice.current_participants < Practice.max_participants)
    .values(current_participants=Practice.current_participants + 1)
    .returning(Practice)
)
result = await session.execute(stmt)
if not result.scalar_one_or_none():
    raise ConflictError("Practice is full")
```

**Phase 6.7: Promo used_count**
```python
# ❌ Race condition — два юзера видят used_count=9 (max_uses=10):
promo = await get_promo(code, session)
if promo.used_count >= promo.max_uses:
    raise ConflictError("Promo expired")
promo.used_count += 1

# ✅ Атомарный инкремент:
stmt = (
    update(Promo)
    .where(Promo.code == code)
    .where(Promo.is_active == True)
    .where(
        or_(Promo.max_uses.is_(None), Promo.used_count < Promo.max_uses)
    )
    .values(used_count=Promo.used_count + 1)
    .returning(Promo)
)
```

**Phase 6.4: Insufficient balance**
```python
# ❌ Race condition — два покупки одновременно:
user = await get_user(user_id, session)
if user.balance_user < price:
    raise BadRequestError("Insufficient balance")
# Оба видят баланс 100, оба покупают за 60 → баланс -20

# ✅ Атомарное списание через ledger + SELECT FOR UPDATE:
stmt = select(User).where(User.id == user_id).with_for_update()
user = (await session.execute(stmt)).scalar_one()
if user.balance_user < price:
    raise BadRequestError("Insufficient balance")
```

**Чеклист:** Каждый service, который проверяет число/статус и потом пишет — подозревать race condition.

---

### P-08: Информационная утечка через HTTP-коды

**Найдено в:** Round 3 (404 для "User not found" на валидной сессии), Round 4 (тот же паттерн в новом коде)

**Суть:** Разные HTTP-коды для разных причин ошибки позволяют атакующему узнать внутреннее состояние системы.

**Где повторится:**
- Phase 2.3: `POST /admin/masters/{id}/verify` — если master_id не найден, НЕ возвращать "Master not found" (раскрывает, что ID не существует)
- Phase 4.2: `GET /practices/{id}` — для приватных практик: 404 vs 403 говорит "существует, но нет доступа"
- Phase 5.2: `POST /bookings` — "Practice not found" vs "Practice is full" — оба должны быть одним кодом для анонимных запросов
- Phase 6: Финансовые операции — "Insufficient balance" раскрывает баланс

**Правило:**
- Для авторизованных пользователей — можно возвращать детальные ошибки
- Для ошибок аутентификации — **всегда** 401 с общим сообщением
- Для ресурсов, к которым нет доступа — 404 (не 403), чтобы не раскрывать существование

---

### P-09: `str, Enum` вместо `StrEnum`

**Найдено в:** Round 1 (users/models.py — UserRole)

**Суть:** В Python 3.12 есть `enum.StrEnum`. LLM использует устаревший `class Role(str, Enum)`, который работает, но не идиоматичен и не проходит ruff UP017.

**Где повторится:**
- Phase 4.1: `PracticeType(str, Enum)`, `PracticeStatus(str, Enum)` — обе в ТЗ
- Phase 5.1: `BookingStatus(str, Enum)` — в ТЗ
- Phase 6.1: `LedgerStatus(str, Enum)`, `CompanyLedgerType(str, Enum)` — в ТЗ
- Phase 6.7: `PromoType(str, Enum)` — в ТЗ

**Правило:**
```python
# ❌ Устаревший стиль (ТЗ написано так, но это legacy):
class PracticeType(str, Enum):
    LIVE = "live"

# ✅ Python 3.12:
import enum
class PracticeType(enum.StrEnum):
    LIVE = "live"
```

**Чеклист:** Grep `(str, Enum)` — заменить на `(enum.StrEnum)`.

---

### P-10: Structlog — `import logging` вместо `import structlog`

**Найдено в:** Round 2 (masters/router.py использовал stdlib logging)

**Суть:** Новые файлы копируют паттерн из стандартных примеров Python, а не из существующих файлов проекта.

**Где повторится:** Каждый новый модуль (practices, bookings, payments, notifications, diary, admin, reports).

**Правило:**
```python
# ❌ Стандартная библиотека:
import logging
logger = logging.getLogger(__name__)
logger.info(f"Created practice {practice.id}")

# ✅ Structlog (проект VELO):
import structlog
logger = structlog.get_logger()
logger.info("practice_created", practice_id=str(practice.id), master_id=str(user.id))
```

**Чеклист:** Grep `import logging` в app/ (кроме core/logging.py). Если найден — заменить на structlog.

---

### P-11: Enum(value) без try/except на пользовательском вводе

**Найдено в:** Round 8 (admin/users/service.py — `UserRole(role)`)

**Суть:** При фильтрации по query parameter, LLM конвертирует строку в enum через `SomeEnum(value)`. Если значение невалидное, Python бросает `ValueError`, который не перехватывается и улетает как 500 Internal Server Error вместо 400 Bad Request.

**Отличие от P-04 (UUID):** P-04 — это про парсинг UUID из dict/Redis. P-11 — это про ЛЮБОЕ преобразование enum из query params, path params, или request body.

**Где повторится (конкретные enum-классы и эндпоинты):**

| Phase | Эндпоинт | Enum-класс | Файл (ожидаемый) |
|---|---|---|---|
| 4.2 | `GET /practices?type=...` | `PracticeType` | practices/service.py |
| 4.2 | `GET /practices?status=...` | `PracticeStatus` | practices/service.py |
| 5.2 | `GET /bookings?status=...` | `BookingStatus` | bookings/service.py |
| 6.3 | `GET /ledger?status=...` | `LedgerStatus` | payments/service.py |
| 6.3 | `GET /company/ledger?type=...` | `CompanyLedgerType` | payments/service.py |
| 6.7 | `GET /promos?type=...` | `PromoType` | payments/promos/service.py |
| 3.3 | `GET /admin/reports?status=...` | `ReportStatus` | admin/reports/service.py |

**Рекомендация:** Использовать `Literal` в сигнатуре роутера (см. шаблон в Части 4) вместо ручного `Enum(value)` в сервисе. Это решает P-11 на уровне архитектуры.

**Правило:**
```python
# ❌ Без обработки — 500 на невалидном значении:
query = query.where(User.role == UserRole(role))

# ✅ С обработкой — 400 с понятным сообщением:
try:
    role_enum = UserRole(role)
except ValueError:
    valid = ", ".join(r.value for r in UserRole)
    raise BadRequestError(f"Invalid role: '{role}'. Valid: {valid}") from None
query = query.where(User.role == role_enum)
```

**Альтернатива (лучше):** Использовать `Literal` или `Enum` прямо в сигнатуре роутера — FastAPI валидирует автоматически и вернёт 422:
```python
from typing import Literal

@router.get("/users")
async def get_users(
    role: Literal["user", "master", "admin"] | None = Query(default=None),
):
    ...
```

**Чеклист:** Grep `Enum(` в service-файлах (кроме определений классов). Если аргумент — пользовательский ввод, нужен try/except или Literal в роутере.

---

### P-12: State machine transitions без FOR UPDATE

**Найдено в:** Round 5 (admin/service.py — concurrent verify + reject)

**Суть:** Подтип P-07 для admin-операций. Когда два админа одновременно выполняют разные действия над одним ресурсом (verify + reject), без `SELECT FOR UPDATE` оба видят `status=pending`, оба проходят проверку, и результат зависит от порядка коммитов. Если reject коммитится после verify:
- `MasterProfile.data.status = "rejected"` (от reject)
- `User.role = MASTER` (от verify, уже закоммичено)
- **Результат: role=MASTER но status=rejected — несогласованность данных**

**Отличие от P-07:** P-07 — это про числовые гонки (balance, counters). P-12 — это про state machine, где разные transitions затрагивают разные поля в разных моделях.

**Где повторится (полные state machines):**

**Practice (Phase 4.2):** `draft -> published -> scheduled -> completed / cancelled`
- Concurrent: master publishes + admin cancels одну и ту же практику
- Concurrent: cron auto-completes (по времени) + master cancels
- Затрагивает: `Practice.status`, `Practice.current_participants`, связанные `Booking` (каскадная отмена)

**Booking (Phase 5.2):** `confirmed -> completed / cancelled`
- Concurrent: user cancels + system auto-completes после завершения практики
- Concurrent: admin force-cancels + user cancels
- Затрагивает: `Booking.status`, `Practice.current_participants` (декремент), `UserLedger` + `MasterLedger` (refund)

**Withdrawal (Phase 6.6):** `pending -> approved / rejected`
- Concurrent: два админа -- один approve, другой reject (идентично masters verify/reject)
- Затрагивает: `Withdrawal.status`, `MasterLedger` (unfreeze или списание), `User.balance_master`

**Report (Phase 3.3):** `pending -> resolved / dismissed`
- Concurrent: два модератора -- один resolve, другой dismiss
- Затрагивает: `Report.status`, возможно `User` (ban/warning)

**Правило:**
```python
# ❌ Без блокировки — race condition:
profile = await session.get(MasterProfile, user_id)

# ✅ С блокировкой — второй запрос ждёт коммита первого:
stmt = (
    select(MasterProfile)
    .where(MasterProfile.user_id == user_id)
    .with_for_update()
)
result = await session.execute(stmt)
profile = result.scalar_one_or_none()
```

**Чеклист:** Каждый service с admin state transitions (verify/reject/approve/cancel) — проверить наличие `with_for_update()`.

---

## Часть 2: Предсказания по фазам

### Phase 2.3: Верификация мастера -- РЕЗУЛЬТАТЫ

**Предсказания vs реальность:**

| Предсказание | Сбылось? | Комментарий |
|---|---|---|
| P-03: Прямое присвоение JSONB | **НЕТ** | Код использовал `copy.deepcopy()` + `set_jsonb()` — идеально |
| P-01: `session.commit()` в роутере | **НЕТ** | `flush()` + `refresh()` — правильно |
| P-08: Разные сообщения для разных ошибок | **ДА** | `"current status: {status}"` в ConflictError — статус утекал |
| Забытый `user.role = UserRole.MASTER` | **НЕТ** | Обе операции (data + role) были на месте |
| **НЕ ПРЕДСКАЗАНО:** Race condition на verify/reject | **ПРОПУЩЕНО** | `session.get()` без FOR UPDATE. Нашлось в аудите -> P-12 |

### Phase 3.1: Admin stats -- РЕЗУЛЬТАТЫ

| Предсказание | Сбылось? | Severity | Комментарий |
|---|---|---|---|
| P-10: stdlib logging | **НЕТ** | -- | structlog использован корректно |
| P-01: commit в роутере | **НЕТ** | -- | Stats -- read-only endpoint, commit не нужен |
| **НЕ ПРЕДСКАЗАНО:** Misleading docstring "GIN-path" | **ДА** | LOW | Утверждал наличие GIN-индекса, которого нет |

**Точность Phase 3.1:** 0/2 предсказаний сбылись. 1 непредсказанная проблема (LOW).

### Phase 3.2: Admin user/master listings -- РЕЗУЛЬТАТЫ

| Предсказание | Сбылось? | Severity | Комментарий |
|---|---|---|---|
| P-10: stdlib logging | **НЕТ** | -- | structlog использован корректно |
| P-01: commit в роутере | **НЕТ** | -- | Правильный flush в листингах |
| **НЕ ПРЕДСКАЗАНО:** `UserRole(role)` -> ValueError -> 500 | **ДА** | MEDIUM | Новый паттерн -> P-11 |
| **НЕ ПРЕДСКАЗАНО:** Dead code `PaginatedParams` | **ДА** | LOW | Определён, но не используется нигде |

**Точность Phase 3.2:** 0/2 предсказаний сбылись. 2 непредсказанные проблемы (1 MEDIUM, 1 LOW).

**Калибровочный вывод Phase 3.1-3.2:** P-01 и P-10 -- "зрелые" паттерны, код уже не повторяет эти ошибки. Гайд оказал профилактический эффект. Новые проблемы (P-11, dead code, misleading docs) относятся к категориям, которые гайд ещё не покрывал. **Рекомендация:** снизить приоритет P-01/P-10 в предсказаниях для поздних фаз; фокусироваться на новых паттернах (P-11, P-12).

### Phase 2.3: Верификация мастера

**Ожидаемые ошибки:**
1. **P-03**: Прямое присвоение `profile.data["account"]["status"] = "verified"` вместо `set_jsonb()`
2. **P-01**: `session.commit()` после изменения `user.role`
3. **P-08**: `POST /admin/masters/{id}/reject` — разные сообщения для "не найден" и "уже верифицирован"
4. Забытый `user.role = UserRole.MASTER` — меняет data.status, но не меняет роль

**Что проверить:**
```python
# Верификация должна делать ДВЕ вещи:
# 1. Обновить data в MasterProfile
new_data = copy.deepcopy(profile.data)
new_data["account"]["status"] = "verified"
new_data["account"]["verification"] = {
    "verified_at": datetime.now(UTC).isoformat(),
    "verified_by": str(admin.id),
}
profile.set_jsonb("data", new_data)

# 2. Обновить роль User
user.role = UserRole.MASTER
```

**Не забыть:** `get_current_admin` зависимость на обоих эндпоинтах.

---

### Phase 4.1–4.3: Practices

**Ожидаемые ошибки:**
1. **P-01**: Двойной коммит в POST /practices
2. **P-02**: PracticeUpdate с `str | None` для NOT NULL полей (title, timezone, status)
3. **P-06**: PATCH /practices/{id} без проверки `practice.master_id == user.id`
4. **P-09**: `PracticeType(str, Enum)` вместо `StrEnum`
5. **Новый:** `scheduled_at` в прошлом — не валидируется
6. **Новый:** `timezone` в Practice не валидируется как IANA (та же ошибка, что в UserUpdate)
7. **Новый:** soft-delete через `DELETE /practices/{id}` — LLM может сделать hard delete

**Что проверить:**
```python
# scheduled_at валидация:
@field_validator("scheduled_at")
@classmethod
def _not_in_past(cls, v):
    if v < datetime.now(UTC):
        raise ValueError("Cannot schedule practice in the past")
    return v

# timezone валидация (копия из UserUpdate):
@field_validator("timezone")
@classmethod
def validate_timezone(cls, v):
    if v is None:
        return v
    try:
        ZoneInfo(v)
    except (ZoneInfoNotFoundError, KeyError):
        raise ValueError(f"Invalid timezone: '{v}'") from None
    return v
```

---

### Phase 5.1–5.3: Bookings

**Ожидаемые ошибки:**
1. **P-07**: Overbooking — `current_participants` increment без атомарности
2. **P-05**: UNIQUE(practice_id, user_id) — IntegrityError без savepoint (begin_nested)
3. **P-06**: DELETE /bookings/{id} без проверки ownership
4. **P-01**: Двойной коммит при создании бронирования
5. **Новый:** Бронирование на свою практику — мастер не должен бронировать у себя
6. **Новый:** Бронирование на завершённую/отменённую практику — нет проверки статуса

**Критический паттерн — атомарное бронирование:**
```python
async def create_booking(user: User, practice_id: UUID, session: AsyncSession):
    # 1. Проверить, что практика доступна (статус + места)
    # 2. Атомарный инкремент current_participants
    # 3. Создать Booking
    # 4. Поймать IntegrityError (дупликат)

    # Шаг 1+2 атомарно:
    stmt = (
        update(Practice)
        .where(
            Practice.id == practice_id,
            Practice.status == PracticeStatus.SCHEDULED,
            or_(
                Practice.max_participants.is_(None),
                Practice.current_participants < Practice.max_participants,
            ),
        )
        .values(current_participants=Practice.current_participants + 1)
        .returning(Practice.id)
    )
    result = await session.execute(stmt)
    if not result.scalar_one_or_none():
        raise ConflictError("Practice unavailable or full")

    # Шаг 3:
    booking = Booking(practice_id=practice_id, user_id=user.id)
    session.add(booking)
    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError("Already booked") from None
```

---

### Phase 6: Payments (САМАЯ ОПАСНАЯ ФАЗА)

**Ожидаемые ошибки:**

1. **P-07**: Race condition на балансе — два списания одновременно уводят баланс в минус
2. **Новый: Нарушение double-entry** — LLM запишет в один ledger, забудет второй
3. **Новый: Frozen vs Available путаница** — списание из frozen вместо available при выводе
4. **Новый: Listener не обновляет cached balance** — `User.balance_user` рассинхронизируется с `SUM(user_ledger)`
5. **P-01**: Двойной коммит в каждом финансовом эндпоинте
6. **P-05**: IntegrityError без savepoint (begin_nested) при дубликате платежа
7. **Новый: Комиссия считается неточно** — float вместо Decimal

**Критический чеклист для каждой финансовой операции:**
```
□ Все ledger-записи создаются в ОДНОЙ транзакции
□ Сумма amount по всем ledger-записям = 0
□ Баланс проверяется с SELECT FOR UPDATE (P-07)
□ Decimal(18,2) везде, ни одного float
□ Комиссия: Decimal("0.15"), НЕ 0.15
□ Тест: два concurrent запроса не уводят баланс в минус
□ AuditLog записан для каждой операции
```

**Самый опасный код — Purchase flow:**
```python
async def purchase_practice(user: User, practice_id: UUID, session: AsyncSession):
    # SELECT FOR UPDATE — блокировка баланса
    stmt = select(User).where(User.id == user.id).with_for_update()
    locked_user = (await session.execute(stmt)).scalar_one()

    price = await get_practice_price(practice_id, session)

    if locked_user.balance_user < price:
        raise BadRequestError("Insufficient balance")

    # Double-entry: user debit + master credit
    user_entry = UserLedger(
        user_id=user.id,
        amount=-price,  # Decimal, не float!
        reason=f"purchase:practice={practice_id}",
    )
    master_entry = MasterLedger(
        user_id=practice.master_id,
        amount=price,
        is_frozen=True,
        reason=f"sale:practice={practice_id}",
        practice_id=practice_id,
    )
    session.add_all([user_entry, master_entry])

    # Обновить cached balance
    locked_user.balance_user -= price  # или через listener

    await session.flush()
```

**Паттерн: Balance listener (Phase 6.2)**

LLM скорее всего реализует listener как SQLAlchemy event listener:
```python
@event.listens_for(UserLedger, "after_insert")
def update_user_balance(mapper, connection, target):
    ...
```

**Проблема:** SQLAlchemy ORM events работают синхронно. В async-контексте нужен другой подход:
```python
# Вместо event listener — явный вызов в service:
async def record_user_ledger(entry: UserLedger, session: AsyncSession):
    session.add(entry)
    await session.flush()

    # Пересчёт баланса:
    stmt = select(func.sum(UserLedger.amount)).where(
        UserLedger.user_id == entry.user_id,
        UserLedger.status == LedgerStatus.DONE,
    )
    total = (await session.execute(stmt)).scalar() or Decimal("0")

    user = await session.get(User, entry.user_id)
    user.balance_user = total
```

---

### Phase 6.5: Cancellations & Refunds

**Ожидаемые ошибки:**
1. **Дедлайн в неправильном timezone** — `scheduled_at` хранится в UTC, `cancellation_deadline_hours` тоже в UTC. LLM может сравнить с `datetime.now()` без UTC
2. **Возврат без проверки статуса** — бронь уже отменена, но повторный запрос делает двойной refund
3. **Master cancels practice** — цикл по всем бронированиям без `SELECT FOR UPDATE`
4. **Double-entry нарушен** — при возврате LLM забудет одну из двух ledger-записей

**Паттерн:**
```python
async def cancel_booking(booking_id: UUID, user: User, session: AsyncSession):
    # 1. Загрузить бронь с FOR UPDATE
    booking = await session.get(Booking, booking_id, with_for_update=True)

    # 2. Проверить ownership
    if booking.user_id != user.id:
        raise ForbiddenError("Not your booking")

    # 3. Проверить статус (идемпотентность)
    if booking.status == BookingStatus.CANCELLED:
        raise ConflictError("Already cancelled")

    # 4. Проверить дедлайн (UTC!)
    practice = await get_practice(booking.practice_id, session)
    deadline = practice.scheduled_at - timedelta(hours=CANCELLATION_DEADLINE_HOURS)

    if datetime.now(UTC) < deadline:
        # Возврат 100%
        await refund_booking(booking, practice, session)  # double-entry!

    # 5. Обновить статус
    booking.status = BookingStatus.CANCELLED
    booking.cancelled_at = datetime.now(UTC)
```

---

### Phase 7: Notifications

**Ожидаемые ошибки:**
1. **Новый:** `Notification.id` в ТЗ — `int`, а не UUID. Несоответствие с остальными моделями
2. **Новый:** NotificationProcessor — polling loop без backoff. При пустой очереди — 100% CPU
3. **Новый:** Telegram Bot + FastAPI в одном процессе — aiogram event loop конфликтует с uvicorn
4. **P-10**: stdlib logging вместо structlog

**Рекомендация:** Бот и FastAPI — в разных процессах (отдельный Docker service или отдельный entrypoint).

---

### Phase 3.3: Reports (Модерация)

**Ожидаемые ошибки:**
1. **P-06**: Пользователь создаёт жалобу на себя (`reporter_id == target_id`)
2. **P-08**: `GET /admin/reports` — не фильтровать по статусу = показывать все
3. **Новый:** `target_type` — произвольная строка. LLM не сделает enum/валидацию. Можно отправить `target_type: "drop_table"`

---

## Часть 3: Глобальный чеклист для каждого нового эндпоинта

```
□ Нет session.commit() в роутере (P-01)
□ Update-схема: NOT NULL поля защищены валидатором (P-02)
□ JSONB мутации через set_jsonb() (P-03)
□ UUID из недоверенных источников — полный except (P-04)
□ IntegrityError catch -> session.begin_nested() обёртка (P-05)
□ Ownership check на PATCH/DELETE (P-06)
□ Конкурентные записи — атомарные операции / FOR UPDATE (P-07)
□ Нет утечки информации через HTTP-коды (P-08)
□ Enums — enum.StrEnum (P-09)
□ structlog, не stdlib logging (P-10)
□ Enum(value) из query params — try/except или Literal в роутере (P-11)
□ Admin state transitions — with_for_update() (P-12)
□ Все datetime — timezone-aware (UTC)
□ Все денежные суммы — Decimal, не float
□ Тест на happy path
□ Тест на auth required (401)
□ Тест на forbidden (403)
□ Тест на валидацию входных данных (422)
□ Тест на невалидный enum в фильтре (400)
□ Тест на конфликт (409)
```

---

## Часть 4: Шаблон нового модуля

При создании нового модуля (practices, bookings, etc.) — использовать этот шаблон как стартовую точку:

```python
# router.py — шаблон
import structlog                              # P-10: structlog, не logging
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_session
from app.modules.auth.dependencies import get_current_user
from app.modules.users.models import User

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/...", tags=["..."])

@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_something(
    body: CreateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    result = await service_function(user, body, session)
    await session.flush()                     # P-01: flush, не commit
    await session.refresh(result)
    return ResponseSchema(...)
```

```python
# service.py — шаблон
import structlog
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

async def create_something(user, body, session):
    obj = Model(...)
    session.add(obj)
    try:
        async with session.begin_nested():    # P-05: savepoint, НЕ rollback
            await session.flush()
    except IntegrityError:
        raise ConflictError("...") from None

    logger.info("something_created",          # structlog keyword args
        id=str(obj.id), user_id=str(user.id))
    return obj
```

```python
# router.py -- шаблон фильтра с enum (P-11)
# Вариант 1 (рекомендуемый): Literal в сигнатуре -- FastAPI валидирует автоматически (422)
from typing import Literal
from fastapi import Query

@router.get("/items")
async def list_items(
    status: Literal["active", "cancelled", "completed"] | None = Query(default=None),
    session: AsyncSession = Depends(get_db_reader),
):
    # FastAPI вернёт 422 на невалидное значение -- ничего дополнительно не нужно
    items = await list_items_service(status=status, session=session)
    return items
```

```python
# service.py -- шаблон: если enum приходит как str (не через Literal)
from app.core.exceptions import BadRequestError

async def list_items_service(
    status: str | None,
    session: AsyncSession,
) -> list[Item]:
    query = select(Item)

    if status is not None:                       # P-11: try/except обязателен
        try:
            status_enum = ItemStatus(status)
        except ValueError:
            valid = ", ".join(s.value for s in ItemStatus)
            raise BadRequestError(
                f"Invalid status: '{status}'. Valid: {valid}"
            ) from None
        query = query.where(Item.status == status_enum)

    result = await session.execute(query)
    return list(result.scalars().all())
```

---

**Конец документа**

*Создано на основе 8 раундов аудита кодовой базы VELO (февраль 2026).*
*Обновлять по мере обнаружения новых паттернов.*
