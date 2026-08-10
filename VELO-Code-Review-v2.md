# VELO — Code Review (живой документ) 

**Последнее обновление:** 2026-03-10
**Ревьюер:** Senior Software Engineer (Claude Code)
**Стек:** Python 3.12 / FastAPI / SQLAlchemy async / PostgreSQL / Redis / Vue 3 / TypeScript / Pinia

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> ACTIVELY MISLEADING overall — this pass corrected two specific items: the CRITICAL-3
> semaphore reference (feature removed 2026-07-07) and WARNING-5's file pointer + status
> (the guard it asks for already exists, in a different file than named; the operational
> risk it warns about is real and current — see WARNING-5). The doc's overall "8.5/10" score,
> the closed-count ("17 из 19… 9 из 12"), and every other open item below are UNVERIFIED this
> pass — do not treat them as current without re-checking against today's code.

**Оценка: 8.5/10** (Backend: 9/10, Frontend: 8/10)

Закрыто: 17 из 19 бэкенд-замечаний, 9 из 12 фронтенд-замечаний.
Ниже — только то, что **ещё не исправлено**.

---

## Бэкенд — открытые замечания

### 🔴 CRITICAL-3: `record_master_ledger` при отсутствующем MasterProfile

**Файл:** `backend/app/modules/payments/service.py`

Когда `MasterProfile` не найден, функция создаёт ledger entry но НЕ обновляет cached balance
→ расхождение между `master_ledger` и cached balance (раньше это ловили семафоры 3.2/3.3;
consistency-семафоры удалены 2026-07-07 `9ca5619` — сейчас это расхождение ничем не
мониторится).

**Исправление:** Бросать `BadRequestError` вместо silent continue.

---

### 🟡 CRITICAL-4: Нет rate limiting на `/auth/telegram`

**Файл:** `backend/app/modules/auth/router.py`

`POST /auth/telegram` без ограничений. Атакующий с валидным initData может создать тысячи
Redis-сессий за 5-минутное окно → OOM Redis.

**Исправление:** `slowapi` или Redis-based limiter, лимит 5 req/min на telegram_id.

---

### 🟡 WARNING-4: Anti-replay для initData

**Файл:** `backend/app/modules/auth/router.py`

Нет защиты от повторного использования одного и того же initData в пределах 5-минутного окна.

**Исправление:** `SET used_init_data:{hash}` с TTL 5 минут, проверка перед обработкой.

---

### 🟡 WARNING-5: `STRIPE_SECRET_KEY=TEST` (stub-режим) в production

**Файл:** `backend/app/core/config.py` (`Settings.is_stripe_stub_blocked`) + guard в
`backend/app/main.py` (`lifespan()`) — **не** `payments/webhook.py` (this file doesn't exist;
the webhook module is `payments/webhook_router.py`, and its signature check
(`payments/stripe.py::verify_webhook_signature`) is unconditional — stub mode never touches
it. Stub mode instead makes topup skip Stripe entirely at session-creation time
(`payments/stripe.py::_create_stub_topup`), so no webhook is even involved when stub is on.

**Corrected 2026-07-19 (PROMPT №510):** the guard this finding originally asked for
already exists — `is_stripe_stub_blocked` raises `RuntimeError` at startup when
`not is_dev and is_stripe_stub and not allow_stripe_stub`. It is not a gap in the code.
The operational risk is real and current: per commit `8d4948f` (owner-measured
2026-07-17), **PROD is right now running `STRIPE_SECRET_KEY=TEST` with no
`ALLOW_STRIPE_STUB` set** — exactly the state this guard exists to refuse. Prod has not
crashed only because its currently-deployed build predates the guard. The next prod
release containing it will raise at startup and refuse to come up.

**Исправление:** before releasing this code to prod, either set a real Stripe secret key
on prod, or set `ALLOW_STRIPE_STUB=true` there if the stub is genuinely intended to stay.
No code change needed — this is an environment fix, and it blocks the next prod release.

---

### 🟡 WARNING-2: 500-обработчик без request context

**Файл:** `backend/app/main.py`

Глобальный `Exception` handler не логирует `request.method` и `trace_id`.

**Исправление:** Добавить `method=request.method`, `path=request.url.path`, `trace_id` из `contextvars`.

---

### 🟢 SUGGESTION-12.1: `diary_comment_max_length` — config vs schemas рассинхрон

**Файлы:** `core/config.py`, `diary/schemas.py`

`settings.diary_comment_max_length = 1000` в конфиге, но Pydantic schemas hardcode `max_length=1000`.
Синхронизированы случайно — при изменении конфига schemas не узнают.

**Варианты:**
- Простой: убрать `diary_comment_max_length` из config (раз schemas hardcoded)
- Правильный: `Field(max_length=settings.diary_comment_max_length)` в schemas

---

## Фронтенд — открытые замечания

### 🔴 CRITICAL-2: Нет таймаута запросов в API-клиенте

**Файл:** `frontend/src/api/client.ts`

`fetch()` без `AbortController` и timeout. При потере сети запрос висит бесконечно.
В мобильной Telegram WebApp потеря сети — обычное дело.

```ts
// Исправление:
const controller = new AbortController()
const timeoutId = setTimeout(() => controller.abort(), 15_000)
try {
  response = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  })
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') {
    throw new ApiTimeoutError()
  }
  throw new ApiNetworkError()
} finally {
  clearTimeout(timeoutId)
}
```

---

### 🟡 WARNING-1: Нет единого error handler в stores

**Файлы:** `stores/*.ts`

7+ дублей одинакового паттерна try/catch по всем stores.

**Исправление:** Единый composable `useApiError.ts`.

---

### 🟡 WARNING-3: `waitUntilReady()` не различает timeout и success

**Файл:** `frontend/src/composables/useAuth.ts`

При таймауте резолвится без ошибки — вызывающий код думает что auth готов.

**Исправление:** Возвращать `{ ok: boolean, timedOut: boolean }`.

---

### 🟡 WARNING-8: Избыточный fetch practice в checkin/feedback views

**Файлы:** `CheckinView.vue`, `FeedbackView.vue`

`fetchPractice()` вызывается в `onMounted` всегда, даже если practice уже есть в store.

```ts
// Исправление:
if (practicesStore.selected?.id !== practiceId) {
  await practicesStore.fetchPractice(practiceId)
}
```

---

### 🟡 WARNING-9: CSS дублирование CheckinView / FeedbackView (~200 строк)

**Файлы:** `CheckinView.vue`, `FeedbackView.vue`

Header, back button, practice info, textarea, actions, success screen — ~200 строк идентичного CSS.

**Исправление:** Извлечь `FormShell.vue` с слотами.

---

### 🟡 WARNING-11: `platform.hapticFeedback()` без fallback

Silent crash если platform не инициализирован или среда не поддерживает haptic.

**Исправление:** try/catch вокруг вызовов haptic.

---

### 🟡 WARNING-12: Фронтенд почти не покрыт тестами

2 тест-файла при значительной бизнес-логике F9.

**Приоритет:**
1. DiaryStore CRUD + pagination
2. `inCheckinWindow` / `inFeedbackWindow` time window logic
3. Alert banners computeds в UserDashboardView
4. Router guards integration

---

### 🟡 WARNING-13: Module-level mutable state не сбрасывается между тестами

**Файлы:** `api/client.ts` (`_token`), `useAuth.ts` (`isReady`, `isStandalone`)

**Исправление:** Явный `resetAuthState()` или DI через параметры.

---

### 🟢 NEW-1: `CHECKIN_WINDOW_H` / `FEEDBACK_WINDOW_H` дублируются

**Файлы:** `UserDashboardView.vue`, `PracticeDetailView.vue`

**Исправление:** Вынести в `utils/constants.ts`.

---

### 🟢 NEW-3: DiaryView.vue — монолит ~1000 строк

**Исправление:** Декомпозиция: `DiaryList.vue`, `DiaryEntryForm.vue`, `DiaryCheckinDetail.vue`, `DiaryFeedbackDetail.vue`.

---

### 🟢 NEW-4: `onMounted` Promise.all без `.catch()`

**Файл:** `DiaryView.vue`

Ошибки уходят в unhandled rejection. Обернуть в try/catch.

---

### 🟢 NEW-5: `background: white` хардкод

**Файлы:** `CheckinView.vue`, `FeedbackView.vue`, `DiaryView.vue`

**Исправление:** `var(--velo-bg-card)`.

---

### 🟢 NEW-6: `insightsCache` (Map) растёт бесконечно

**Файл:** `stores/diary.ts`

**Исправление:** LRU-ограничение (50-100 записей).

---

### 🟢 WARNING-10: Magic numbers в стилях

`font-size: 80px`, `56px`, `min-width: 90px` без CSS tokens.

**Исправление:** Добавить токены в `variables.css`.

---

### 🟢 TD-FE-W6: Финансовые константы захардкожены на фронтенде

**Файл:** `MasterFinanceView.vue`

`MIN_WITHDRAWAL_EUROS=50`, `WITHDRAWAL_FEE_EUROS=2` — рассинхрон с `config.py`.

**Исправление:** `GET /api/v1/config` эндпоинт или явный комментарий с источником.

---

## Архив закрытых замечаний

| ID | Суть | Закрыто |
|----|------|---------|
| BE: 2.1 | `confirm_waitlist` rollback → begin_nested | Phase 5.3 |
| BE: 2.2 | login перезаписывал язык пользователя | Phase 8 |
| BE: 2.3 | Redis session SET memory leak | Phase 8 |
| BE: 3.1 | waitlist stub notification | Phase 7 |
| BE: 4.2 | delete_all_sessions race condition | Phase 8 |
| BE: 5.1 | N+1 в notification rollup | Phase 7 |
| BE: 5.2 | N+1 в reschedule_reminders | Phase 8 |
| BE: 5.3 | DRY фильтры list_public_practices | Phase 8 |
| BE: 6.1 | Redundant import purchase_router | 2026-03-10 |
| BE: 6.2 | Misleading "NOT USED" comment current_participants | Phase 8 |
| BE: 7.1 | conftest.py db_session без rollback | 2026-03-10 |
| BE: 11.1 | Diary listing filter duplication | 2026-03-10 |
| BE: 11.2 | first_purchase_only считал PENDING | 2026-03-10 |
| BE: 11.3 | check_type без CheckConstraint | 2026-03-10 |
| BE: TD-029 | Двойная DB-сессия в PATCH /users/me | Phase 8 |
| BE: WARNING-6 | N+1 в finalize_practice | Phase 8 |
| BE: WARNING-7 | list_public_practices без составного индекса | 2026-03-10 |
| FE: CRITICAL-1 | Race condition в roleGuard | Phase F9 |
| FE: W-2/S-3 | Emoji/label маппинги дублировались | Phase F9 |
| FE: 10.1 | telegram.ts crash при недоступности CDN | Phase F9 |
| FE: 10.3 | Hardcoded bot URL | Phase F9 |
| FE: 10.5 | X-Frame-Options DENY ломал Telegram iframe | Phase F9 |
| FE: 10.6 | Google Fonts блокировал рендеринг | Phase F9 |
| FE: 10.7 | Double redirect при logout | Phase F9 |
| FE: 10.8 | SVG-логотип дублировался в 3 компонентах | Phase F9 |
| FE: 10.9 | user-scalable=no | Phase F9 |
| FE: NEW-2 | formatShortDate → formatLongDate | Phase F9+ |
