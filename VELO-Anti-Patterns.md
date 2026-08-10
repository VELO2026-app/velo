# VELO — Anti-Patterns

**Версия:** 1.1
**Дата:** 8 марта 2026
**Назначение:** Проспективный гайд по предсказанию повторяющихся ошибок при реализации.
Каждый паттерн подтверждён реальными находками из 8+ раундов code review.

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> STALE-BUT-HARMLESS — NOT rewritten this round. Not sampled beyond one spot-check: P-01's
> "семафорах 3.2/3.3" reference (data-integrity semaphores, removed 2026-07-07 `9ca5619`) was
> found but is left as-is — it illustrates a bug pattern's *consequence*, is not in this
> pass's named scope, and a full sweep of this doc wasn't performed. Treat all patterns here
> as unverified against current code.

**Как использовать:** Перед началом каждой фазы — прочитать соответствующие секции.
После написания кода — проверить по чеклисту (Часть 3).

---

## Часть 1: Бэкенд — повторяющиеся паттерны

### P-01: Двойной коммит в роутере

**Найдено в:** Round 1 (auth/router.py), Round 2 (masters/router.py)

`get_db_session()` делает `await session.commit()` автоматически после `yield`.
Явный `commit()` в роутере = двойной коммит = риск `InvalidRequestError`.

```python
# ЗАПРЕЩЕНО в роутерах:
await session.commit()

# ПРАВИЛЬНО:
await session.flush()        # получить DB-generated значения
await session.refresh(obj)   # загрузить обновлённые поля
# get_db_session() сделает единственный commit сам
```

**Чеклист:** Grep `session.commit()` в каждом router.py. Если найден — баг.

---

### P-02: Pydantic `str | None` на NOT NULL колонку

**Найдено в:** Round 1 (users/schemas.py — timezone, language)

PATCH-схема с `str | None` принимает `null`. Если колонка NOT NULL — 500 IntegrityError на коммите,
хотя Pydantic-валидация прошла.

```python
# Для КАЖДОГО NOT NULL поля в Update-схеме:
@field_validator("title", "timezone", "status", mode="before")
@classmethod
def _reject_null(cls, v):
    if v is None:
        raise ValueError("This field cannot be set to null")
    return v
```

**Чеклист:** Для каждой Update-схемы сверить поля с моделью. Если поле NOT NULL в модели,
но `str | None` в схеме — нужен валидатор.

---

### P-03: JSONB мутация без `set_jsonb()`

**Найдено в:** Round 2 (masters/service.py)

SQLAlchemy не видит изменения JSONB при прямом присвоении или shallow copy.
**Silent data loss: данные не сохраняются, нет ошибки, нет логов.**

```python
# ❌ SQLAlchemy НЕ увидит:
profile.data["account"]["status"] = "verified"

# ❌ Shallow copy тоже не сработает:
new_data = profile.data.copy()
profile.data = new_data

# ✅ Единственный правильный способ:
import copy
new_data = copy.deepcopy(profile.data)
new_data["account"]["status"] = "verified"
profile.set_jsonb("data", new_data)
```

**Чеклист:** Grep `\.data\[` и `\.data =` в service-файлах. Если найдено без `set_jsonb` — баг.

---

### P-04: `UUID()` без полного перехвата исключений

**Найдено в:** Round 3 (auth/dependencies.py), Round 4 (повтор)

`UUID(value)` бросает разные исключения:
- `UUID("not-a-uuid")` → `ValueError`
- `UUID(None)` → `TypeError`
- `UUID(123)` → `AttributeError`
- missing key → `KeyError`

LLM ловит только `ValueError`, остальные улетают как 500.

```python
try:
    parsed = UUID(raw_value)
except (KeyError, ValueError, TypeError, AttributeError):
    raise SomeHttpError("Invalid ID") from None
```

**Важно:** FastAPI автоматически валидирует UUID path-параметры. Проблема — только при ручном
парсинге из dict/Redis/JSONB.

**Чеклист:** Grep `UUID(` в service-файлах. Если `except ValueError` only — неполный.

---

### P-05: IntegrityError без `begin_nested()` (savepoint)

**Найдено в:** Round 2 (masters/service.py)

PostgreSQL при нарушении constraint переводит транзакцию в состояние "aborted".
`session.rollback()` убивает ВСЮ транзакцию включая FOR UPDATE-блокировки.
`begin_nested()` создаёт SAVEPOINT — откатывается только он.

```python
# ❌ rollback() убивает транзакцию полностью:
await session.rollback()

# ✅ begin_nested() — savepoint, внешняя транзакция жива:
session.add(obj)
try:
    async with session.begin_nested():
        await session.flush()
except IntegrityError:
    raise ConflictError("Already exists") from None
```

**Чеклист:** Grep `IntegrityError`. Если есть catch — проверить наличие `begin_nested()`.
`session.rollback()` рядом с IntegrityError — баг.

---

### P-06: Отсутствие проверки ownership (IDOR)

**Найдено в:** Полный аудит (потенциал для IDOR)

При PATCH/DELETE без проверки `resource.owner_id == user.id` — юзер A может изменить
ресурс юзера B, зная его UUID.

```python
# Обязательная проверка на PATCH/DELETE:
if practice.master_id != user.id:
    raise ForbiddenError("Not your practice")
```

**Чеклист:** Каждый PATCH/DELETE эндпоинт — проверить наличие ownership check.

---

### P-07: Конкурентные записи без атомарности (race condition)

**Найдено в:** Round 5 (payments)

Два одновременных запроса читают одно значение и оба считают, что операция допустима.

```python
# ❌ Не атомарно — concurrent requests оба пройдут:
if practice.current_participants < practice.max_participants:
    practice.current_participants += 1

# ✅ Атомарный UPDATE с проверкой:
stmt = (
    update(Practice)
    .where(
        Practice.id == practice_id,
        Practice.current_participants < Practice.max_participants,
    )
    .values(current_participants=Practice.current_participants + 1)
    .returning(Practice.id)
)
result = await session.execute(stmt)
if not result.scalar_one_or_none():
    raise ConflictError("Practice full")
```

**Чеклист:** Все числовые инкременты/декременты — через атомарный UPDATE или FOR UPDATE.

---

### P-08: Информационная утечка через HTTP-коды / сообщения

**Найдено в:** Round 3, Round 4

Разные HTTP-коды или разные сообщения для разных причин ошибки = информация атакующему.

```python
# ❌ Раскрывает существование ресурса:
raise ForbiddenError("You don't have access to this practice")

# ✅ Нельзя отличить "нет доступа" от "не существует":
raise NotFoundError("Practice not found")
```

**Правила:**
- Auth errors: всегда 401 с общим сообщением
- Доступ к ресурсу без прав: 404 (не 403)
- Promo validation: одно общее сообщение для всех причин отказа (SEC-07)

---

### P-09: `str, Enum` вместо `StrEnum`

**Найдено в:** Round 1 (users/models.py)

Python 3.12 имеет `enum.StrEnum`. Устаревший `(str, Enum)` не проходит ruff UP017.

```python
# ❌ Устаревший стиль:
class PracticeType(str, Enum):
    LIVE = "live"

# ✅ Python 3.12:
import enum
class PracticeType(enum.StrEnum):
    LIVE = "live"
```

**Чеклист:** Grep `(str, Enum)` — заменить на `(enum.StrEnum)`.

---

### P-10: `import logging` вместо `import structlog`

**Найдено в:** Round 2 (masters/router.py)

Новые файлы копируют паттерн из стандартных примеров Python, а не из существующего кода.

```python
# ❌ Стандартная библиотека:
import logging
logger = logging.getLogger(__name__)
logger.info(f"Created practice {practice.id}")

# ✅ Structlog (VELO):
import structlog
logger = structlog.get_logger()
logger.info("practice_created", practice_id=str(practice.id), master_id=str(user.id))
```

**Чеклист:** Grep `import logging` в app/ (кроме core/logging.py). Если найден — заменить.

---

### P-11: `Enum(value)` без try/except на пользовательском вводе

**Найдено в:** Round 8 (admin/users/service.py)

`SomeEnum(value)` с невалидным значением → `ValueError` → 500 вместо 400.

```python
# ❌ Без обработки:
query = query.where(User.role == UserRole(role))

# ✅ Вариант 1 — try/except:
try:
    role_enum = UserRole(role)
except ValueError:
    raise BadRequestError(f"Invalid role: '{role}'") from None

# ✅ Вариант 2 — Literal в сигнатуре роутера (FastAPI вернёт 422):
from typing import Literal
@router.get("/users")
async def get_users(role: Literal["user", "master", "admin"] | None = Query(None)):
    ...
```

**Чеклист:** Grep `Enum(` в service-файлах (кроме определений). Если аргумент — пользовательский ввод, нужен try/except или Literal в роутере.

---

### P-12: State machine transitions без `FOR UPDATE`

**Найдено в:** Round 5 (admin/service.py — concurrent verify + reject)

Два admin-а одновременно выполняют разные действия над одним ресурсом.
Без `SELECT FOR UPDATE` оба видят исходный статус и проходят проверку.

```python
# ❌ Без блокировки — race condition:
profile = await session.get(MasterProfile, user_id)

# ✅ С блокировкой — второй запрос ждёт коммита первого:
stmt = select(MasterProfile).where(MasterProfile.user_id == user_id).with_for_update()
result = await session.execute(stmt)
profile = result.scalar_one_or_none()
```

**Затрагивает:**
- Master verify/reject: `profile.data.status`, `user.role`
- Booking cancel: `booking.status`, `current_participants`, ledger
- Withdrawal approve/reject: `withdrawal.status`, `available_cents`
- Report resolve/dismiss: `report.status`

**Чеклист:** Каждый service с admin state transitions — проверить наличие `with_for_update()`.

---

## Часть 2: Фронтенд — повторяющиеся паттерны

### FP-01: Хардкод API URL

```typescript
// ❌ ЗАПРЕЩЕНО:
fetch('https://api.talentir.info/api/v1/users/me')

// ✅ ПРАВИЛЬНО:
const BASE_URL = import.meta.env.VITE_API_BASE_URL
fetch(`${BASE_URL}/api/v1/users/me`)
```

---

### FP-02: Прямая мутация Pinia store из компонента

```typescript
// ❌ ЗАПРЕЩЕНО:
authStore.user = response.data

// ✅ ПРАВИЛЬНО — через action:
authStore.setUser(response.data)
```

---

### FP-03: Запрос API без try/catch

```typescript
// ❌ ЗАПРЕЩЕНО:
const data = await api.get('/practices')
practices.value = data.items

// ✅ ПРАВИЛЬНО:
try {
  const data = await api.get<PaginatedPracticesResponse>('/practices')
  practices.value = data.items
} catch (error) {
  toast.error('Не удалось загрузить практики')
}
```

---

### FP-04: Кнопка без loading-состояния (double-submit)

```typescript
// ❌ Двойной клик отправит два запроса:
async function book() {
  await api.post(`/practices/${id}/purchase`)
}

// ✅ Guard первым, до валидации:
const loading = ref(false)
async function book() {
  if (loading.value) return
  loading.value = true
  try {
    await api.post(`/practices/${id}/purchase`)
  } finally {
    loading.value = false
  }
}
```

---

### FP-05: Тип `any`

```typescript
// ❌ ЗАПРЕЩЕНО:
function handleResponse(data: any) { ... }

// ✅ ПРАВИЛЬНО:
function handleResponse(data: PracticeResponse) { ... }
```

---

### FP-06: Деньги без formatMoney()

```typescript
// ❌ ЗАПРЕЩЕНО:
<span>{{ user.balance_cents / 100 }}€</span>

// ✅ ПРАВИЛЬНО:
<span>{{ formatMoney(user.balance_cents, 'EUR', 'ru', true) }}</span>
```

---

### FP-07: Прямой вызов Telegram SDK из компонента

```typescript
// ❌ ЗАПРЕЩЕНО в компонентах:
window.Telegram.WebApp.HapticFeedback.impactOccurred('medium')

// ✅ ПРАВИЛЬНО — через платформенную абстракцию:
platform.hapticFeedback('medium')
```

---

### FP-08: Прямая мутация sessionStorage/token из api/client.ts

```typescript
// ❌ ЗАПРЕЩЕНО в client.ts:
if (response.status === 401) {
  sessionStorage.removeItem('velo_token')
  window.location.href = '/'
}

// ✅ ПРАВИЛЬНО — через onUnauthorized callback:
if (response.status === 401) {
  _onUnauthorized?.()
}
// auth.ts регистрирует callback при инициализации
```

---

## Часть 3: Глобальный чеклист для каждого нового эндпоинта

```
Бэкенд:
□ Нет session.commit() в роутере (P-01)
□ Update-схема: NOT NULL поля защищены валидатором (P-02)
□ JSONB мутации через set_jsonb() (P-03)
□ UUID из недоверенных источников — полный except (P-04)
□ IntegrityError catch → session.begin_nested() (P-05)
□ Ownership check на PATCH/DELETE (P-06)
□ Конкурентные записи — атомарные операции / FOR UPDATE (P-07)
□ Нет утечки информации через HTTP-коды/сообщения (P-08)
□ Enums — enum.StrEnum (P-09)
□ structlog, не stdlib logging (P-10)
□ Enum(value) из query params — try/except или Literal в роутере (P-11)
□ Admin state transitions — with_for_update() (P-12)
□ Все datetime — timezone-aware (UTC)
□ Все денежные суммы — Decimal или integer cents, не float
□ Тест: happy path
□ Тест: auth required (401)
□ Тест: forbidden (403)
□ Тест: валидация входных данных (422)
□ Тест: невалидный enum в фильтре (400)
□ Тест: конфликт (409)

Фронтенд:
□ Нет хардкода API URL (FP-01)
□ Store мутации только через action (FP-02)
□ Все API-вызовы в try/catch (FP-03)
□ Кнопки с loading, guard ДО валидации (FP-04)
□ Нет any (FP-05)
□ Деньги через formatMoney() (FP-06)
□ Telegram SDK только через platform абстракцию (FP-07)
□ Нет прямой мутации sessionStorage в client.ts (FP-08)
□ Нет хардкода цветов — только CSS-переменные (FP-01 extension)
□ Маппинги emoji/label только из displayHelpers.ts
```

---

## Часть 4: Шаблон нового модуля (бэкенд)

```python
# router.py
import structlog                              # P-10
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
# service.py
import structlog
from sqlalchemy.exc import IntegrityError

logger = structlog.get_logger()

async def create_something(user, body, session):
    obj = Model(...)
    session.add(obj)
    try:
        async with session.begin_nested():    # P-05: savepoint
            await session.flush()
    except IntegrityError:
        raise ConflictError("Already exists") from None

    logger.info("something_created",
        id=str(obj.id), user_id=str(user.id))
    return obj
```

```python
# Фильтр с enum (P-11) — рекомендуемый вариант через Literal:
from typing import Literal
from fastapi import Query

@router.get("/items")
async def list_items(
    status: Literal["active", "cancelled", "completed"] | None = Query(default=None),
    session: AsyncSession = Depends(get_db_reader),
):
    # FastAPI вернёт 422 на невалидное значение автоматически
    return await list_items_service(status=status, session=session)
```

---

## Часть 5: Предсказания по фазам (архив результатов)

### Phase 2.3: Верификация мастера — результаты

| Предсказание | Сбылось? | Комментарий |
|---|---|---|
| P-03: Прямое присвоение JSONB | НЕТ | `copy.deepcopy()` + `set_jsonb()` — идеально |
| P-01: `session.commit()` в роутере | НЕТ | `flush()` + `refresh()` — правильно |
| P-08: Разные сообщения | ДА | `"current status: {status}"` — статус утекал |
| Забытый `user.role = UserRole.MASTER` | НЕТ | Обе операции на месте |
| **НЕ ПРЕДСКАЗАНО:** Race condition | ПРОПУЩЕНО | `session.get()` без FOR UPDATE → P-12 |

### Phase 3.1: Admin stats — результаты

| Предсказание | Сбылось? | Комментарий |
|---|---|---|
| P-10: stdlib logging | НЕТ | structlog использован корректно |
| P-01: commit в роутере | НЕТ | Read-only endpoint |
| **НЕ ПРЕДСКАЗАНО:** Misleading docstring | ДА | LOW — Утверждал GIN-индекс, которого нет |

### Phase 3.2: Admin listings — результаты

| Предсказание | Сбылось? | Комментарий |
|---|---|---|
| P-10: stdlib logging | НЕТ | structlog корректно |
| P-01: commit в роутере | НЕТ | Правильный flush |
| **НЕ ПРЕДСКАЗАНО:** `UserRole(role)` → ValueError → 500 | ДА | MEDIUM → P-11 |
| **НЕ ПРЕДСКАЗАНО:** Dead code `PaginatedParams` | ДА | LOW |

**Калибровочный вывод:** P-01 и P-10 — "зрелые" паттерны, гайд оказал профилактический эффект.
Новые проблемы (P-11, P-12, dead code) относятся к категориям, которые гайд ещё не покрывал.

---

*Создано на основе 8+ раундов code review (февраль–март 2026).
Обновлять по мере обнаружения новых повторяющихся паттернов.*
