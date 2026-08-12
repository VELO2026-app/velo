# VELO -- Техническое задание

**Версия:** 3.4
**Дата:** 29 мая 2026
**Статус:** Active

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> ACTIVELY MISLEADING overall. This pass corrected one item: §6.8 (Data Consistency
> Semaphores) marked "done" with a live file inventory — the whole feature was deleted
> 2026-07-07 (`9ca5619`). Section kept as a historical record, not current behavior.
> Everything else in this ~2900-line document is UNVERIFIED as of this pass — this is a
> large, versioned, mostly-superseded spec; do not treat any other phase/status marker as
> current without a direct check.

---

## 1. Обзор проекта

### 1.1. Цель MVP

Создать работающую платформу для мастеров практик (медитации, йоги, breathwork), которая:

- Автоматизирует записи и напоминания
- Принимает оплату через Stripe
- Работает как Telegram WebApp
- Снимает рутину с мастеров

### 1.2. Критерии готовности MVP

| Критерий | Описание |
|----------|----------|
| Auth | Вход через Telegram работает |
| Practices | Мастер может создать практику, юзер -- записаться |
| Payments | Пополнение баланса, оплата практики, вывод мастером |
| Notifications | Напоминания за 24ч, 1ч, 10мин |
| Admin | Верификация мастеров, базовая модерация |

### 1.3. Вне scope MVP

- OAuth (Google, Apple)
- Подписки (freemium есть, подписки -- нет)
- Library (записи практик)
- AI-саммари (только розетка)
- Мобильные приложения (только WebApp)

---

### Стилевое соглашение (введено Phase 2.3, Audit Round 6)

В комментариях и docstrings в коде:
- Вместо `→` используется `->` (ASCII)
- Вместо `—` (EN DASH) используется `--` (двойной дефис)
- ТЗ и документация вне кода могут использовать Unicode-символы

---

## 2. Фазы разработки

---

## PHASE 0: Инфраструктура

### 0.1: Репозиторий + структура проекта ✅

**Цель:** Базовая структура проекта с линтерами.

**Задачи:**
- [x] GitHub репозиторий `velo` (backend в `backend/` подпапке)
- [x] Структура папок (app/modules, app/core, tests)
- [x] pyproject.toml (dependencies, build-system, black, ruff, mypy)
- [x] .gitignore (корень репо + backend/), .env.example
- [x] README.md с инструкцией по запуску
- [x] pre-commit hooks (.pre-commit-config.yaml в корне репо)
- [x] Makefile (install, run, test, lint, format, clean)
- [x] app/core/config.py (pydantic-settings, загрузка из .env)
- [x] app/core/exceptions.py (VeloError → NotFound/Forbidden/Conflict/BadRequest)
- [x] tests/conftest.py (async client fixture) + test_root.py
- [x] .python-version (pyenv → 3.12)

**Результат:**
```
velo/                              ← GitHub repo root
├── .gitignore                     ← Игнор для .DS_Store, .idea/
├── .pre-commit-config.yaml        ← Hooks: black + ruff + mypy
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                ← FastAPI app (GET / → version)
│   │   ├── core/
│   │   │   ├── __init__.py
│   │   │   ├── config.py          ← Settings from .env
│   │   │   └── exceptions.py      ← Base exception hierarchy
│   │   └── modules/
│   │       └── __init__.py
│   ├── tests/
│   │   ├── __init__.py
│   │   ├── conftest.py            ← Async test client fixture
│   │   └── test_root.py           ← Root endpoint test
│   ├── pyproject.toml             ← Deps + tool config + build-system
│   ├── Makefile                   ← Dev commands (install/run/test/lint)
│   ├── .python-version            ← pyenv → 3.12
│   ├── .env.example
│   ├── .gitignore
│   └── README.md
├── desc/                          ← Project knowledge base (YAML)
├── diagrams/                      ← Mermaid diagrams
├── velo-mockups/                  ← UI prototypes
├── VELO-Design-Document.md
├── VELO-Technical-Specification.md
└── ...
```

**Решения, принятые при реализации:**
- Репо `velo` (не `velo-backend`) — место для будущего фронтенда рядом с бэкендом
- `.pre-commit-config.yaml` в корне репо — pre-commit работает от `.git/`, не от подпапки
- `[build-system]` в pyproject.toml обязателен для `pip install -e .` (регистрация `app` как импортируемого пакета)
- Makefile перенесён из Phase 0.2 — удобнее иметь `make install` с первого дня
- Приложение запускается нативно (не в Docker) для быстрых итераций, Docker — только для сервисов (Phase 0.2)

**Критерий готовности:** `ruff check .`, `mypy .`, `black --check .` проходят без ошибок. ✅

---

### 0.2: Docker Compose ✅

**Цель:** Локальное окружение с PostgreSQL и Redis.

**Задачи:**
- [x] docker-compose.yml (postgres:16 + redis:7-alpine)
- [x] Порты: Postgres 5433 (не 5432), Redis 6379 (стандарт)
- [x] Volume для данных postgres (persistent)
- [x] Healthchecks для обоих сервисов

**Критерий готовности:** `docker compose up -d` поднимает pg + redis. ✅

---

### 0.3: FastAPI скелет + health checks ✅

**Цель:** Базовый FastAPI с проверками здоровья, CORS, structlog.

**Задачи:**
- [x] app/core/database.py — AsyncEngine + AsyncSession (pool_size=10, max_overflow=20)
- [x] app/core/redis.py — async Redis client с lifecycle (init/close)
- [x] app/core/logging.py — structlog (ConsoleRenderer для dev, JSONRenderer для prod)
- [x] CORS middleware (origins из config.py, настраиваемые через .env)
- [x] GET /health — проверка DB (SELECT 1) + Redis (PING), статусы ok/degraded
- [x] GET / — версия API (было из 0.1)
- [x] Lifespan: startup (structlog + Redis init) → shutdown (Redis close + engine dispose)
- [x] tests/test_health.py — 3 теста с моками (all ok, db down, redis down)

**Результат:**
```
backend/app/core/
├── database.py   ← AsyncEngine, session factory, get_db_session()
├── redis.py      ← init_redis(), close_redis(), get_redis()
├── logging.py    ← setup_logging() — structlog конфигурация
├── config.py     ← Обновлён: cors_origins, redis_url, postgres_* поля
└── exceptions.py ← (из 0.1)

backend/app/main.py  ← Обновлён: lifespan, CORS, /health endpoint
backend/tests/test_health.py ← 3 теста (мокают DB/Redis)
```

**Endpoints:**
```
GET /        → {"name": "VELO API", "version": "0.1.0"}
GET /health  → {"status": "ok", "db": "ok", "redis": "ok"}
             → {"status": "degraded", "db": "error", "redis": "ok"}  (если что-то упало)
```

**Решения, принятые при реализации:**
- CORS origins вынесены в config.py (cors_origins) — настраиваются через .env, не хардкод
- `filter_by_level` убран из structlog processors — несовместим с PrintLoggerFactory
- `expire_on_commit=False` в session factory — объекты доступны после commit без lazy load
- Health check возвращает 200 с `"status": "degraded"` (не 500) — load balancer сам решит
- Тесты мокают DB/Redis через MagicMock + AsyncMock — работают без Docker
- `warn_unused_ignores = false` в mypy — разные версии type stubs между pip и pre-commit

**Критерий готовности:** `curl localhost:8000/health` возвращает 200 с `"status": "ok"`. ✅

---

### 0.4: Alembic + базовые миграции ✅ (механизм)

**Цель:** Система миграций БД.

**Задачи:**
- [x] alembic.ini — конфигурация (URL из config.py, не хардкод)
- [x] migrations/env.py — async runner (asyncpg через run_sync bridge)
- [x] migrations/script.py.mako — шаблон генерации миграций
- [x] app/core/database.py — добавлен Base (DeclarativeBase)
- [x] Первая миграция (пустая, проверка механизма)
- [x] `alembic upgrade head` выполняется без ошибок

**Результат:**
```
backend/
├── alembic.ini
├── migrations/
│   ├── env.py              ← Async migration runner
│   ├── script.py.mako      ← Template for new migrations
│   └── versions/
│       └── 2026_02_06_..._initial_empty.py
└── app/core/database.py    ← Обновлён: добавлен Base
```

**Решения, принятые при реализации:**
- URL берётся из app.core.config (единый источник), а не из alembic.ini
- Async bridge: asyncpg не работает с Alembic напрямую — `run_sync()` оборачивает sync-вызов
- Миксины (TimestampMixin, UUIDMixin) отложены до Phase 1.1 вместе с моделью User
- file_template с датой и slug для читаемых имён файлов миграций

**⚠️ Примечание:** Пустая миграция подтверждает работу механизма. Полноценная проверка autogenerate — в Phase 1.1, когда Alembic сгенерирует CREATE TABLE users.

**Критерий готовности:** `alembic upgrade head` выполняется без ошибок. ✅

---

### 0.5: VPS + деплой ✅

**Цель:** Приложение работает на сервере с HTTPS.

**Задачи:**
- [x] VPS (Inferno, NL, Ubuntu 22.04, 2 CPU / 4GB RAM / 30GB NVMe)
- [x] Домен: `api.talentir.info` → A-запись на VPS
- [x] `install_velo.sh` — единый скрипт установки (Docker, Nginx, Certbot, UFW, SSH deploy key)
- [x] Nginx reverse proxy → `127.0.0.1:8000`
- [x] SSL сертификат (Let's Encrypt) + auto-renewal cron
- [x] Firewall: только 22/80/443
- [x] `.env` на сервере (автогенерация с рандомными паролями)
- [x] Management-скрипт `velo` (start/stop/restart/status/logs/update/backup/db)
- [x] Ежедневный backup cron (4 AM, ротация 7 дней)
- [x] Production hardening — закрытие TD-001..TD-009

**Результат:**
```
VPS (37.1.204.171):
├── /opt/velo/
│   ├── repo/              ← Git clone (deploy key, read-only)
│   │   └── backend/       ← Docker stack (app + postgres + redis)
│   ├── scripts/manage.sh  ← Management script (symlink: /usr/local/bin/velo)
│   └── backups/           ← Ежедневные бэкапы (pg_dump + .env)
├── /etc/nginx/sites-available/velo  ← Reverse proxy + SSL
└── /etc/letsencrypt/      ← SSL-сертификат для api.talentir.info
```

**Решения, принятые при реализации:**
- Ручной деплой (`velo update`) вместо GitHub Actions — промежуточные пуши для БЗ Claude, не всегда готовы к деплою
- Ubuntu 22.04 (не 24.04) — предустановлена хостером, LTS до 2027, обновление ОС не оправдано
- Deploy key (read-only SSH) вместо personal access token — минимальные права
- `install_velo.sh` генерирует `.env` с рандомными паролями (openssl rand) — без дефолтных кредов. Спрашивает TELEGRAM_BOT_TOKEN интерактивно
- Postgres/Redis без published портов (Docker internal network only) — TD-004
- App на `127.0.0.1:8000` — только Nginx видит его
- Non-root user в Dockerfile (`USER velo`, UID 1000) — TD-005
- Alembic файлы копируются в Docker image — `velo db migrate` работает внутри контейнера

**Production hardening (закрыто в рамках Phase 0.5):**
- TD-001: SECRET_KEY обязателен в production (validator в config.py)
- TD-002: CORS credentials=False при wildcard origins
- TD-003: `GET /ready` (503 при деградации) + `GET /health` (200 всегда)
- TD-004: Postgres/Redis — no published ports
- TD-005: Docker non-root user
- TD-006: DATABASE_URL обязателен в production
- TD-007: VeloError exception handler + logging
- TD-008: `get_db_reader()` для read-only запросов
- TD-009: Lifespan try/finally — cleanup при падении startup

**Endpoints:**
```
GET /        → {"name": "VELO API", "version": "0.1.0"}
GET /health  → {"status": "ok", "db": "ok", "redis": "ok"}          (200 always)
GET /ready   → {"status": "ok", "db": "ok", "redis": "ok"}          (200 or 503)
```

**Management:**
```
velo status              — Docker ps + health check + external access
velo logs [app|db|redis] — Docker logs -f
velo test                — Run all tests inside container
velo lint                — Run ruff linter inside container
velo update              — git pull + rebuild + migrate + test + restart
velo restart [app]       — Restart all or just app
velo backup              — pg_dump + .env → tar.gz
velo db connect          — psql в контейнер
velo db migrate          — python -m alembic upgrade head
velo ssl renew           — certbot renew
```

**Критерий готовности:** `curl https://api.talentir.info/health` → `{"status":"ok"}`. ✅

---

### 0.6: VPS-only infrastructure rewrite ✅

**Цель:** Убрать все артефакты локальной разработки. Единственная среда — VPS через Docker.

**Контекст:** Phases 0.1–0.5 создавались итеративно и оставили артефакты для macOS/локальной разработки (docker-compose.dev.yml, Makefile, .python-version, .pre-commit-config.yaml, black). Эта фаза — одноразовая чистка.

**Удалено:**
- `docker-compose.dev.yml` — локальная разработка не используется
- `Makefile` — все команды через `velo` на VPS
- `.python-version` — pyenv не нужен (Docker image содержит Python)
- `.pre-commit-config.yaml` — pre-commit не используется (ruff через `velo lint`)

**Заменено:**

| Файл | Что изменилось |
|------|----------------|
| `Dockerfile` | Dev-зависимости всегда устанавливаются (`pip install ".[dev]"`). tests/ и pyproject.toml копируются в runtime image. |
| `docker-compose.yml` | Единственный compose-файл. Postgres/Redis без published портов. App на `127.0.0.1:8000`. |
| `.dockerignore` | tests/ и pyproject.toml НЕ исключены (нужны в контейнере). |
| `.env.example` | Хосты: `postgres:5432`, `redis:6379` (Docker service names, не localhost). |
| `README.md` | Только VPS-инструкции. |

**install_velo.sh обновлён:**
- `docker compose down -v` при переустановке (удаляет volumes, чтобы новый пароль PG работал)
- `cd "$INSTALL_BASE"` перед `rm -rf` (фикс CWD-бага — shell терял рабочую директорию)
- `.env` всегда генерируется заново (убрана проверка `if exists`)
- `TELEGRAM_BOT_TOKEN` спрашивается интерактивно через `read -p`
- Убран `$INSTALL_BASE/creds/credentials.txt` (дубликат паролей из .env — бессмысленно и опасно)
- `velo update`: pull → build → down → up → `python -m alembic upgrade head` → `python -m pytest` → health check. Тесты упали — exit 1
- `velo test`, `velo lint` — новые команды
- `velo db migrate`: `python -m alembic` вместо `alembic` (PYTHONPATH)

**Результат:**
```
backend/
├── app/
│   ├── core/
│   │   ├── database.py        ← Lazy engine: get_engine() / dispose_engine() + cached session factory (L-02)
│   │   ├── redis.py
│   │   ├── logging.py
│   │   ├── config.py
│   │   ├── mixins.py
│   │   └── exceptions.py
│   ├── modules/
│   │   ├── auth/
│   │   └── users/
│   └── main.py                ← Uses get_engine(), not module-level engine
├── tests/
│   ├── conftest.py            ← Session-scoped, pytest-asyncio 0.26 compatible
│   ├── test_auth.py
│   ├── test_health.py         ← Patches get_engine(), real DB for success tests
│   └── test_root.py
├── migrations/
├── docker-compose.yml         ← Single compose file (no dev/prod split)
├── Dockerfile                 ← Dev deps always installed, tests in image
├── .dockerignore
├── .env.example
├── pyproject.toml             ← No black/pre-commit, pytest cache_dir=/tmp
├── alembic.ini
└── README.md                  ← VPS-only instructions
```

**Решения, принятые при реализации:**
- pytest-asyncio 0.26: `asyncio_default_fixture_loop_scope = "session"` + `asyncio_default_test_loop_scope = "session"` — все тесты и fixtures на одном event loop. Кастомный `event_loop` fixture удалён (deprecated в 0.26)
- Миграции в conftest через subprocess — `env.py` использует `asyncio.run()`, который нельзя вложить в pytest event loop
- `cache_dir = "/tmp/.pytest_cache"` — контейнер работает от user `velo`, а `/app` принадлежит root
- Тесты запускаются в том же Docker image, что и приложение — нет разницы между test и prod окружением

**Критерий готовности:** `velo test` → 18 passed, 0 warnings. `velo update` включает тесты. ✅

---

### 0.7: Logging + Audit → перенесена перед Phase 6

> **Примечание:** Базовый structlog уже работает (Phase 0.3). Полноценный аудит нужен
> только для финансовых операций (Phase 6). Секция перенесена как **Pre-6: Audit** —
> см. перед Phase 6: Payments.

---

## PHASE 1: Auth + Users

### 1.1: Модель User ✅

**Цель:** Базовая модель пользователя.

**Задачи:**
- [x] app/core/mixins.py — UUIDMixin + TimestampMixin
- [x] app/modules/users/models.py — User model + UserRole enum
- [x] Миграция `create_users_table`

**Результат:**
```
backend/app/
├── core/
│   └── mixins.py              ← UUIDMixin, TimestampMixin (DateTime timezone=True)
└── modules/
    └── users/
        ├── __init__.py
        └── models.py          ← UserRole enum + User model
```

**Решения, принятые при реализации:**
- `telegram_id` — отдельная колонка (BigInteger, unique, indexed) для быстрого поиска при логине. Правило: ищем по колонке, храним в JSONB
- `credentials` — JSONB-песочница для данных auth неясной структуры (telegram username, photo, будущие email/password/OAuth)
- `role` хранится как `String(20)` (не PostgreSQL ENUM) — asyncpg не умеет кастить строки в PG ENUM при server_default. Python-side `UserRole(str, Enum)` валидирует
- `balance_cents` — `Integer`, default=0, EUR cents (Phase 6.1, TD-033 resolved)
- Миксины: `UUIDMixin` (uuid4 app-side), `TimestampMixin` (created_at server_default, updated_at ORM-level onupdate)
- Все datetime-колонки — `DateTime(timezone=True)` (TIMESTAMP WITH TIME ZONE)

**Критерий готовности:** Миграция применена, таблица создана. ✅

---

### 1.2: Telegram WebApp Auth ✅

**Цель:** Аутентификация через Telegram initData.

**Задачи:**
- [x] app/modules/auth/service.py — валидация initData (HMAC-SHA256)
- [x] app/modules/auth/router.py — POST /api/v1/auth/telegram
- [x] POST /api/v1/auth/logout — отзыв сессии
- [x] Атомарный upsert юзера при входе (INSERT ON CONFLICT DO UPDATE)
- [x] app/core/exceptions.py — добавлен UnauthorizedError (401)
- [x] Тесты валидации (8 тестов)

**Endpoints:**
```
POST /api/v1/auth/telegram      → AuthResponse {user, session_token}
POST /api/v1/auth/logout        → 204 No Content
POST /api/v1/auth/logout-all    → 204 No Content (W-06: invalidate all sessions)
```

**Решения, принятые при реализации:**
- `INSERT ... ON CONFLICT DO UPDATE` вместо SELECT+INSERT — атомарно, без race condition при двойном клике
- `session.commit()` ПЕРЕД созданием Redis-сессии — если commit упадёт, orphan-сессии в Redis не будет
- `telegram_bot_token` — пустой дефолт, заполняется в валидаторе (dev: fake token, prod: required)
- initData expiry: 5 минут (защита от replay)
- **credentials MERGE на UPDATE (onboarding flow, добавлено позже):** на ветке `on_conflict_do_update` credentials НЕ перезаписывается, а мерджится: `coalesce(User.credentials, '{}'::jsonb) || fresh`. Свежие Telegram-поля накладываются поверх, а ключи вне `fresh` (в т.ч. `onboarding_completed`) переживают релогин. COALESCE защищает edge-case `NULL || x = NULL`. На INSERT credentials = fresh (флага нет -> читается как false). См. Бэковый Кодекс 3.7

**Критерий готовности:** WebApp может залогинить юзера. ✅

---

### 1.3: Сессии (Redis) ✅

**Цель:** Управление сессиями через Redis.

**Задачи:**
- [x] Сессии в auth/service.py (create/get/delete/delete_all) — не отдельный файл
- [x] FastAPI Dependency вместо Middleware (решение Phase 0.5 обсуждение)
- [x] app/modules/auth/dependencies.py — get_current_user, get_optional_user, get_current_admin
- [x] TTL 30 дней (настраивается через SESSION_TTL_DAYS)
- [x] Session index (W-06): reverse index в Redis для logout-all

**Формат сессии в Redis:**
```
Key: session:{token}    (token = secrets.token_urlsafe(48))
Value: {"user_id": "uuid", "telegram_id": 123, "created_at": "iso"}
TTL: 30 days

Key: user_sessions:{user_id}    (Redis SET of tokens, W-06)
TTL: Same as session TTL
```

**Dependencies (вместо middleware):**
```python
get_current_user(request, session) → User       # 401 если нет токена
get_optional_user(request, session) → User|None  # None для анонимов
get_current_admin(user) → User                   # 403 если не admin
get_current_master(user, session) → (User, MasterProfile)  # 403 если не verified master (Phase 4.2)
```

**Решения, принятые при реализации:**
- Dependency вместо Middleware — явная авторизация на уровне эндпоинта, громко падает при отсутствии токена (не молчаливый None в request.state)
- Бесшовная миграция в будущем: при добавлении standalone app (JWT) меняется одна функция get_current_user, ни один роутер не трогаем
- Три уровня: обязательный (get_current_user), опциональный (get_optional_user), админский (get_current_admin)

**Критерий готовности:** Запросы с валидным токеном авторизованы. ✅

---

### 1.4: CRUD профиля юзера ✅

**Цель:** Endpoints для профиля.

**Задачи:**
- [x] app/modules/users/schemas.py — UserResponse (перенесён из auth/schemas.py), UserUpdate
- [x] app/modules/users/service.py — update_user (partial update через merge + exclude_unset)
- [x] app/modules/users/router.py — GET/PATCH /api/v1/users/me
- [x] auth/schemas.py — импортирует UserResponse из users/schemas.py (без дупликации)
- [x] main.py — include_router(users_router)
- [x] tests/helpers.py — общие хелперы (build_init_data, login_user, auth_headers)
- [x] tests/test_users.py — 10 тестов
- [x] tests/test_auth.py — рефакторинг на shared helpers

**Endpoints:**
```
GET  /api/v1/users/me        → UserResponse
PATCH /api/v1/users/me       → UserResponse (body: UserUpdate)
```

**Результат:**
```
backend/app/modules/users/
├── __init__.py
├── models.py           ← (из Phase 1.1)
├── schemas.py          ← UserResponse + UserUpdate
├── service.py          ← update_user()
└── router.py           ← GET/PATCH /users/me

backend/tests/
├── helpers.py          ← Shared: build_init_data, login_user, auth_headers
├── test_auth.py        ← Рефакторинг: импорты из helpers
└── test_users.py       ← 10 тестов (GET, PATCH, auth, validation)
```

**Решения, принятые при реализации:**
- `UserResponse` перенесён в users/schemas.py (домен users), auth/schemas.py импортирует оттуда — при распиле на микросервисы оба варианта эквивалентны (всё равно дупликация или shared-lib)
- `session.merge(user)` в service — user приходит из read-only сессии (get_db_reader), PATCH пишет через get_db_session. Merge переносит объект в write-сессию
- `exclude_unset=True` — различаем "поле не отправлено" и "поле отправлено как null". Пустой body `{}` = ничего не меняем, 200
- `min_length=1` на всех полях UserUpdate — пустые строки отклоняются (422). Очистка поля — через null
- `avatar_url` не входит в UserUpdate — управляется Telegram (будущее: Bot API getUserProfilePhotos)
- Тестовые хелперы вынесены в tests/helpers.py (не conftest — это функции, не fixtures). Устранена дупликация между test_auth.py и test_users.py
- telegram_id ranges: auth тесты 77xxx/99xxx, users тесты 88xxx — без конфликтов
- Closes TD-021
- **onboarding_completed (добавлено позже, onboarding flow):** `UserResponse` отдаёт `onboarding_completed: bool` (computed_field из `credentials` JSONB, сырой credentials скрыт через input-only поле `credentials_in` + exclude=True). `UserUpdate` принимает `onboarding_completed: bool | None`; `update_user` пишет его в credentials через `set_jsonb` (развилка JSONB-поля vs колоночные), `None` фильтруется (не сбрасывает флаг). Закрывает TD-024. См. Бэковый Кодекс 3.7. +5 тестов в test_users.py (дефолт false, set true, survives relogin, merge+telegram refresh, null ignored)

**Критерий готовности:** Юзер может видеть и редактировать свой профиль. 36 тестов (31 + 5 onboarding), 0 warnings. ✅

---

## PHASE 2: Masters

### 2.1: MasterProfile + JSONB data ✅

**Цель:** Модель профиля мастера.

**Задачи:**
- [x] app/modules/masters/models.py
- [x] MasterProfile с JSONB data
- [x] Поля frozen_amount и available_amount
- [x] Миграция

**Модель:**
```python
class MasterProfile(Base):
    __tablename__ = "master_profiles"
    
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB, default=dict)
    # data содержит: account, availability, profile, settings, stats
    
    # Balance fields (updated by ledger listeners, Phase 6.2)
    frozen_cents: Mapped[int] = mapped_column(Integer, default=0)     # EUR cents
    available_cents: Mapped[int] = mapped_column(Integer, default=0)  # EUR cents
    
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(onupdate=func.now())
    
    user: Mapped["User"] = relationship(back_populates="master_profile")
```

**Структура data JSONB:**
```json
{
  "account": {
    "status": "pending|verified|suspended|banned",
    "verification": {
      "verified_at": "datetime",
      "verified_by": "admin_id"
    }
  },
  "availability": {
    "is_accepting": true,
    "note": "В отпуске до 15.02"
  },
  "profile": {
    "bio": "...",
    "short_bio": "...",
    "methods": ["meditation", "breathwork"],
    "experience_years": 5,
    "certifications": []
  },
  "settings": {
    "auto_confirm_bookings": true,
    "max_participants_default": 20
  },
  "stats": {
    "total_practices": 47,
    "total_participants": 312,
    "avg_rating": 4.8
  }
}
```

**Решения, принятые при реализации:**
- Relationship: unidirectional (`MasterProfile → User`, без `back_populates` на User) — избегает циклических импортов при старте app
- Миграция написана вручную (нет локальной БД для autogenerate)
- `MasterProfile` наследует `JSONBMixin` — см. архитектурное правило ниже

**Критерий готовности:** Миграция применена. ✅

---

### Архитектурное правило: JSONBMixin (введено Phase 2.1)

**Контекст:** SQLAlchemy не детектит изменения JSONB-колонок при прямом
присвоении dict (shallow copy сохраняет ссылки на вложенные объекты,
SQLAlchemy сравнивает identity и считает значение неизменённым).
Это приводит к silent bugs — данные не сохраняются в БД.

**Правило:**
```python
# ❌ ЗАПРЕЩЕНО — SQLAlchemy может не увидеть изменение:
profile.data = new_data
profile.data["account"]["status"] = "verified"

# ✅ ОБЯЗАТЕЛЬНО — гарантирует UPDATE:
profile.set_jsonb("data", new_data)
```

**Реализация:** `JSONBMixin` в `app/core/mixins.py`:
```python
from sqlalchemy.orm.attributes import flag_modified

class JSONBMixin:
    def set_jsonb(self, field: str, value: dict) -> None:
        setattr(self, field, value)
        flag_modified(self, field)
```

**Где применяется:**
- `MasterProfile(JSONBMixin, Base)` — колонка `data`
- `User` — колонка `credentials` (пока мутируется только через raw SQL INSERT ON CONFLICT; JSONBMixin добавить при первой ORM-мутации)
- Все будущие модели с JSONB-колонками обязаны наследовать `JSONBMixin`

**TD-024:** Добавить `JSONBMixin` к `User` при первой ORM-мутации `credentials`.

---

### Архитектурное правило: Session Commit (введено Phase 2.2)

**Контекст:** `get_db_session()` автоматически делает `commit()` после `yield`
и `rollback()` при исключении. Явный `commit()` в роутере создаёт двойной
коммит, что может привести к `InvalidRequestError` или частичному коммиту.

**Правило:**
```python
# ❌ ЗАПРЕЩЕНО — двойной коммит:
await session.commit()

# ✅ ОБЯЗАТЕЛЬНО — flush для DB-generated значений:
await session.flush()
await session.refresh(obj)
```

**Сессии в VELO:**
- `get_db_session()` — write: auto-commit после yield, rollback при ошибке
- `get_db_reader()` — read-only: всегда rollback (TD-008)
- В роутерах **никогда** не вызывать `session.commit()` и `session.rollback()`
- В service-слое допустим `session.rollback()` только внутри `try/except IntegrityError`

---

### Архитектурное правило: State Machine (введено Phase 4.2)

**Контекст:** Модели с колонкой `status` имеют допустимые переходы.
`setattr(obj, "status", new_value)` без валидации позволяет невалидные
переходы (например, `completed → draft`). Lost updates при concurrent
PATCH усугубляют проблему.

**Правило:**
```python
# ❌ ЗАПРЕЩЕНО -- слепое присвоение:
practice.status = body.status

# ✅ ОБЯЗАТЕЛЬНО -- валидация перехода + FOR UPDATE:
stmt = select(Practice).where(...).with_for_update()  # P-12
allowed = _VALID_TRANSITIONS.get(practice.status, set())
if new_status not in allowed:
    raise BadRequestError(...)
practice.status = new_status
```

**Где применяется:**
- `Practice` -- `_VALID_TRANSITIONS` в `practices/service.py`
- `Booking` (Phase 5) -- обязан иметь аналогичную карту переходов
- Все будущие модели с lifecycle-статусами

**NOT NULL guard (P-02):**
При partial update через PATCH, NOT NULL поля должны быть защищены от explicit null:
```python
_NOT_NULL_FIELDS = {"title", "scheduled_at", ...}
for field in _NOT_NULL_FIELDS:
    if field in update_data and update_data[field] is None:
        raise BadRequestError(f"{field} cannot be null")
```

---

### 2.2: Заявка на мастера ✅

**Цель:** Flow подачи заявки (3 шага из мокапов).

**Задачи:**
- [x] POST /api/v1/masters/apply — создание заявки
- [x] Шаг 1: Профиль (имя, email, телефон)
- [x] Шаг 2: Опыт (направления, сертификаты)
- [x] Шаг 3: Документы (загрузка)
- [x] Статус "pending"
- [x] Повторная заявка после rejection (с сохранением истории)
- [x] Race condition guard (IntegrityError + rollback)
- [x] tests/test_masters.py — 8 тестов

**Endpoint:**
```
POST /api/v1/masters/apply
Body: {
  "profile": {...},
  "experience": {...},
  "documents": [...]
}
Response: {"user_id": "...", "status": "pending", "created_at": "..."}
```

**Критерий готовности:** Юзер может подать заявку на мастера. ✅

---

### 2.3: Верификация мастера ✅

**Цель:** Админ может верифицировать или отклонить заявку мастера.

**Задачи:**
- [x] POST /api/v1/admin/masters/{user_id}/verify
- [x] POST /api/v1/admin/masters/{user_id}/reject
- [x] Изменение user.role на MASTER при верификации
- [x] app/modules/admin/ — ВРЕМЕННЫЙ модуль (см. примечание ниже)
- [x] tests/test_admin_masters.py — 10 тестов

**Endpoints:**
```
POST /api/v1/admin/masters/{user_id}/verify
Body: {"notes": "Всё ок"}      (notes — опционально)
Response: {"user_id": "...", "status": "verified"}

POST /api/v1/admin/masters/{user_id}/reject
Body: {"reason": "Недостаточно опыта"}     (reason — обязательно, min_length=1)
Response: {"user_id": "...", "status": "rejected"}
```

**Результат:**
```
backend/app/modules/admin/       ← ⚠️ ВРЕМЕННЫЙ модуль
├── __init__.py
├── schemas.py          ← VerifyMasterRequest, RejectMasterRequest, AdminMasterActionResponse
├── service.py          ← verify_master(), reject_master(), _load_pending_profile()
└── router.py           ← 2 POST-эндпоинта, get_current_admin

backend/tests/
└── test_admin_masters.py  ← 10 тестов (telegram_id range: 56xxx)
```

**Решения, принятые при реализации:**
- **Временный admin-модуль:** содержит только verify/reject. Phase 3 ДОЛЖНА переработать его в полноценный admin-модуль (stats, user lists, moderation). Не добавлять сюда новый код без плана Phase 3
- `_load_pending_profile()` использует `SELECT ... FOR UPDATE` (P-07) — защита от race condition при двух админах одновременно
- Все JSONB-мутации через `copy.deepcopy()` + `set_jsonb()` (P-03)
- Никакого `session.commit()` в роутере (P-01) — только `flush()` + `refresh()`
- Сообщение ConflictError: `"Application is not pending"` без интерполяции текущего статуса (P-08)
- Verify выполняет ДВЕ операции: `profile.set_jsonb(...)` + `user.role = UserRole.MASTER`
- Reject НЕ меняет роль — пользователь остаётся USER и может reapply
- Verification info записывается в `data.account.verification` (verified_at, verified_by, notes)
- Rejection info записывается в `data.account` (rejected_at, rejection_reason, rejected_by)
- `get_current_admin` dependency на обоих эндпоинтах
- structlog (P-10) для логирования всех действий
- CORS fix: `settings.cors_origins.split(",")` — исправлен наследственный баг (str vs list)
- telegram_id ranges: 56001-56099 (аппликанты), 56900-56999 (админы)

**Аудит:**
- Round 5: найдены 4 проблемы (race condition MEDIUM, CORS LOW, status leak LOW, lint). Все исправлены
- Round 6: чистый проход, только косметика (ASCII стиль в комментариях)
- Предсказанные ошибки из LLM Code Review Guide (P-01, P-03, P-10, forgotten role change) — все избежаны

**Критерий готовности:** Админ может верифицировать/отклонить заявку. 49 тестов, 0 warnings. ✅

---

### 2.4: Публичный профиль мастера ✅ (Calendar flow, 2026-05-24)

**Цель:** Юзер видит публичную карточку мастера (Figma `541:1553` кадр 4 + master profile).

```
GET /api/v1/masters/{user_id}
Response (MasterPublicResponse): user_id, status, display_name, bio, methods,
  experience_years, avatar_url, practices_count, reviews_count
```

- Только публичные поля — финансы/контакты/payout в схему НЕ входят (граница изоляции
  в самой схеме). Только verified-мастер, иначе 404 (P-08).
- `practices_count` / `reviews_count` — два live ORM-COUNT (детали и обоснование — Бэковый
  Кодекс §3.9). Роут объявлен последним в `masters/router.py` (после `/me*`).
- Бонус: `master_avatar_url` добавлен в детали практики.
- Тесты: `test_master_public.py`, 11 шт. (диапазон 56xxx — см. коллизию в Бэковом Кодексе §8).

---

## PHASE 3: Admin

### 3.1: Админские эндпоинты + реструктуризация admin-модуля ✅

**Цель:** Базовые админ-функции + переработка временного admin-модуля из Phase 2.3.

**Задачи:**
- [x] Переработать app/modules/admin/ из плоской структуры в sub-packages
- [x] Перенести verify/reject в admin/masters/ (без изменений логики)
- [x] GET /api/v1/admin/stats — базовая статистика
- [x] tests/test_admin_stats.py — 6 тестов

**Endpoint:**
```
GET /api/v1/admin/stats
Response: {
  "users_count": 150,
  "masters_count": 12,
  "practices_count": 0,
  "pending_verifications": 2
}
```

> **✅ RESOLVED (Phase 4.1):** `practices_count` заменён на реальный `COUNT(*)` из таблицы `practices`.

**Результат:**
```
backend/app/modules/admin/
├── __init__.py              ← модуль (убран TEMPORARY)
├── router.py                ← агрегатор: include masters + stats sub-routers
├── masters/
│   ├── __init__.py
│   ├── schemas.py           ← перенос из Phase 2.3
│   ├── service.py           ← перенос из Phase 2.3 (FOR UPDATE)
│   └── router.py            ← POST verify/reject (prefix=/masters)
└── stats/
    ├── __init__.py
    ├── schemas.py           ← AdminStatsResponse
    ├── service.py           ← get_stats(): 4 real COUNTs (Phase 4.1)
    └── router.py            ← GET /stats (get_db_reader)

backend/tests/
└── test_admin_stats.py      ← 6 тестов (telegram_id range: 57xxx)
```

**Решения, принятые при реализации:**
- Sub-packages вместо плоской структуры — готовность к Phase 3.2 (users/), 3.3 (reports/) без раздувания файлов
- `admin/router.py` — агрегатор, include sub-routers. Импорт в main.py не меняется: `from app.modules.admin.router import router`
- Stats использует `get_db_reader` (read-only) — не write session
- JSONB filter: `MasterProfile.data["account"]["status"].as_string() == "pending"` — sequential scan на master_profiles (таблица маленькая, GIN-индекс не нужен для MVP)
- `practices_count` -- было stub=0, заменено реальным COUNT(*) в Phase 4.1
- telegram_id ranges: stats тесты 57xxx (не пересекаются с 55xxx masters, 56xxx admin_masters)

**Аудит:** 2 замечания (LOW docstring, LINT formatting). Исправлены.

**Критерий готовности:** Админ видит статистику. 55 тестов, 0 warnings. ✅

---

### 3.2: Список юзеров/мастеров ✅

**Цель:** Админ видит всех пользователей и мастеров с пагинацией и фильтрами.

**Задачи:**
- [x] GET /api/v1/admin/users — список юзеров (пагинация, фильтры role, is_active)
- [x] GET /api/v1/admin/masters/list — список мастеров (фильтр status)
- [x] GET /api/v1/admin/masters/pending — шорткат: pending
- [x] GET /api/v1/admin/masters/rejected — шорткат: rejected
- [x] app/modules/admin/users/ sub-package
- [x] tests/test_admin_users.py — 9 тестов

**Endpoints:**
```
GET /api/v1/admin/users?limit=20&offset=0&role=user&is_active=true
Response: {"items": [...], "total": 45, "limit": 20, "offset": 0}

GET /api/v1/admin/masters/list?status=verified&limit=20&offset=0
GET /api/v1/admin/masters/pending
GET /api/v1/admin/masters/rejected
Response: {"items": [...], "total": 12, "limit": 20, "offset": 0}

GET /api/v1/admin/masters/{user_id}        ← ДОБАВЛЕН в F8 review (W-1)
Response: AdminMasterListItem (полный профиль мастера)
```

**Результат:**
```
backend/app/modules/admin/users/
├── __init__.py
├── schemas.py           ← PaginatedUsersResponse, AdminMasterListItem, PaginatedMastersResponse
├── service.py           ← list_users(), list_masters()
└── router.py            ← 4 GET endpoints

backend/tests/
└── test_admin_users.py  ← 9 тестов (telegram_id range: 58xxx)
```

**Решения, принятые при реализации:**
- `/masters/list` вместо `/masters` — избежание path conflict с `POST /masters/{user_id}/verify`. FastAPI путал бы "pending" как UUID
- `str(user.role)` вместо `user.role.value` — при JOIN из read-only сессии role приходит как str, не enum
- `try/except ValueError` на `UserRole(role)` — невалидный фильтр (`?role=superadmin`) возвращает 400, не 500
- `status` filter на `/masters/list`: `Literal["pending", "verified", "rejected"] | None` (L-04). FastAPI возвращает 422 на невалидное значение автоматически (P-11)
- Все эндпоинты используют `get_db_reader` (read-only) — не write session
- JOIN User + MasterProfile в одном запросе (не N+1)
- Пагинация: limit (1-100, default 20), offset (>=0). Total count отдельным запросом
- telegram_id ranges: users тесты 58xxx

**Аудит:** 2 замечания (MEDIUM невалидный role → 500, LOW неиспользуемый класс). Исправлены.

**Критерий готовности:** Админ видит списки с фильтрами. 64 теста, 0 warnings. ✅

---

3.3: Модерация ✅
Цель: Базовая система жалоб — юзеры создают жалобы, админы резолвят/отклоняют.
Задачи:

 Модель Report (status, target_type, reason, resolution)
 app/modules/reports/ — новый модуль (model, schemas, service, router)
 app/modules/admin/reports/ — admin sub-package (schemas, service, router)
 POST /api/v1/reports — создать жалобу (юзер)
 PATCH /api/v1/reports/{id} — редактировать свою жалобу
 GET /api/v1/reports/me — список своих жалоб
 GET /api/v1/admin/reports — список жалоб (фильтры, пагинация)
 POST /api/v1/admin/reports/{id}/resolve — резолв жалобы
 POST /api/v1/admin/reports/{id}/dismiss — отклонение жалобы
 migrations/env.py — добавлен import Report для autogenerate
 tests/test_reports.py — 11 тестов
 tests/test_admin_reports.py — 13 тестов

Endpoints:
POST  /api/v1/reports                          → ReportResponse (201) | ExistingReportResponse (200)
PATCH /api/v1/reports/{id}                     → ReportResponse
GET   /api/v1/reports/me?limit=20&offset=0     → [ReportResponse]

GET   /api/v1/admin/reports?status=pending&target_type=user&limit=20&offset=0
Response: {"items": [...], "total": 5, "limit": 20, "offset": 0}

GET   /api/v1/admin/reports/{id}            ← ДОБАВЛЕН в F8 review (W-2)
Response: ReportResponse

POST  /api/v1/admin/reports/{id}/resolve       → ReportResponse
POST  /api/v1/admin/reports/{id}/dismiss       → ReportResponse
Модель:
pythonclass ReportStatus(enum.StrEnum):
    PENDING = "pending"
    RESOLVED = "resolved"
    DISMISSED = "dismissed"

class ReportTargetType(enum.StrEnum):
    USER = "user"
    MASTER = "master"
    PRACTICE = "practice"

class Report(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "reports"

    reporter_id: Mapped[UUID]       # FK users.id, CASCADE
    target_type: Mapped[str]        # String(20), polymorphic
    target_id: Mapped[UUID]         # No FK -- polymorphic target
    reason: Mapped[str]             # Text
    status: Mapped[str]             # String(20), default "pending"
    resolved_by: Mapped[UUID|None]  # FK users.id, SET NULL
    resolution_note: Mapped[str|None]
    resolved_at: Mapped[datetime|None]

    # UniqueConstraint("reporter_id", "target_type", "target_id")
Результат:
backend/app/modules/reports/
├── __init__.py
├── models.py        ← Report, ReportStatus, ReportTargetType
├── schemas.py       ← CreateReportRequest, UpdateReportRequest, ReportResponse, ExistingReportResponse
├── service.py       ← create_report(), update_report(), get_existing_report()
└── router.py        ← POST, PATCH, GET /me (prefix=/api/v1/reports)

backend/app/modules/admin/reports/
├── __init__.py
├── schemas.py       ← ResolveReportRequest, DismissReportRequest, PaginatedReportsResponse
├── service.py       ← resolve_report(), dismiss_report(), list_reports()
└── router.py        ← GET, POST resolve, POST dismiss (prefix=/reports)

backend/app/modules/admin/router.py  ← обновлён: include reports_router
backend/app/main.py                  ← обновлён: include reports_router
backend/migrations/env.py            ← обновлён: import Report

backend/tests/
├── test_reports.py       ← 11 тестов (telegram_id range: 59001-59199)
└── test_admin_reports.py ← 13 тестов (telegram_id range: 59200-59999)
Решения, принятые при реализации:

Полиморфный target — target_type + target_id без FK constraint. Валидация в service.py на уровне приложения. Позволяет ссылаться на users, master_profiles, practices (future) одной таблицей
Дубликаты — UniqueConstraint (reporter_id, target_type, target_id). При попытке создать дубликат: POST возвращает 200 + ExistingReportResponse с предложением отредактировать существующий, а не 409
Race condition на UNIQUE — create_report() делает flush() внутри service с try/except IntegrityError + rollback() (P-05). Если два одинаковых запроса проходят SELECT одновременно, второй получит IntegrityError → graceful fallback на "duplicate found"
Self-report prevention — проверка для target_type in (USER, MASTER), т.к. target_id для мастера это тоже user_id (FK в master_profiles). Practice не проверяется (мастер не может "быть" практикой)
Два эндпоинта resolve/dismiss (не один PATCH) — консистентность с verify/reject (Phase 2.3). Явные URL, легче тестировать. Общий _load_pending_report() с with_for_update() (P-12)
Practice validation -- target_type="practice" заменён реальным SELECT из practices (Phase 4.1)
Фильтры через Literal — status: Literal["pending", "resolved", "dismissed"] и target_type: Literal["user", "master", "practice"] в admin роутере. FastAPI возвращает 422 на невалидное значение автоматически (P-11)
telegram_id ranges: reports тесты 59xxx (не пересекаются с 55xxx masters, 56xxx admin_masters, 57xxx stats, 58xxx users)


✅ RESOLVED (Phase 4.1): Валидация target_type="practice" заменена на реальный SELECT из таблицы practices.

Аудит: 5 замечаний (1 MEDIUM race condition, 1 LOW self-report bypass, 3 LINT). Все исправлены.
Критерий готовности: Жалобы можно создавать и обрабатывать. 89 тестов, 0 warnings. ✅


---

## PHASE 4: Practices

### 4.1: Модель Practice ✅

**Цель:** Базовая модель практики + удаление стабов.

**Задачи:**
- [x] app/modules/practices/models.py -- Practice, PracticeType, PracticeStatus
- [x] app/modules/practices/__init__.py
- [x] Миграция `create_practices_table` (down_revision: b2c3d4e5f6a7)
- [x] Удаление стабов: admin/stats (practices_count), reports (practice validation)
- [x] migrations/env.py -- import Practice (для autogenerate)

**Модель:**
```python
class PracticeType(enum.StrEnum):
    LIVE = "live"
    SERIES = "series"
    ONE_ON_ONE = "one_on_one"
    REPLAY = "replay"

class PracticeStatus(enum.StrEnum):
    DRAFT = "draft"
    SCHEDULED = "scheduled"
    LIVE = "live"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    DELETED = "deleted"  # Phase 4.2: soft delete for drafts

class Practice(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "practices"

    master_id: Mapped[UUID] = mapped_column(
        ForeignKey("master_profiles.user_id", ondelete="CASCADE"),
        index=True,  # R-07: synced with ix_practices_master_id in migration
    )

    practice_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="draft")

    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, default=None)

    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int] = mapped_column(Integer)
    timezone: Mapped[str] = mapped_column(String(50))

    max_participants: Mapped[int | None] = mapped_column(Integer, default=None)
    current_participants: Mapped[int] = mapped_column(Integer, default=0)
    # Updated by recalculate_participants() after every booking status change.
    # Capacity checks still use COUNT(bookings) (TD-034). This is a denormalized
    # cache for PracticeResponse display only.

    zoom_link: Mapped[str | None] = mapped_column(String(500), default=None)

    parent_practice_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("practices.id", ondelete="SET NULL"), default=None
    )
```

**Индексы миграции:**
- `ix_practices_master_id` -- listing practices by master
- `ix_practices_scheduled_at` -- public feed chronological order

**Решения, принятые при реализации:**
- **FK → master_profiles.user_id** (не users.id) -- DB-level guarantee: только мастера владеют практиками
- **`practice_type`** (не `type`) -- избегаем shadowing Python builtin
- **`scheduled_at` NOT NULL** -- мастер обязан указать время при создании, нет nullable drafts
- **`parent_practice_id`** -- self-referential FK для серий, создан сразу (не отложен).
  Задействован эпиком E3 (июнь 2026): связь оккуренция -> корень серии (см. блок-цитату E3 ниже)
- **`current_participants`** -- denormalized cache, updated by `recalculate_participants()` (bookings/service.py) after every booking/waitlist/refund status change. Capacity checks still use `COUNT(bookings)` (TD-034). Cache is for PracticeResponse display only
- **`DELETED`** -- добавлен в Phase 4.2 (soft delete для черновиков, отделён от `cancelled`)
- **Стабы удалены**: admin/stats/service.py (practices_count → реальный COUNT), reports/service.py (practice validation → реальный SELECT)
- **StrEnum (P-09)** -- не `(str, Enum)` как в старом ТЗ

**Аудит:** 4 замечания (1 LOW stale docstring, 3 LINT formatting/indent/E501). Все исправлены.

**Критерий готовности:** Миграция применена, стабы заменены. 89 тестов, 0 warnings. ✅

> **Calendar iteration (2026-05-22, пост-фазовая):** `Practice` получил JSONB-колонку
> `data` (миграция `b2c3d4e5f6a8`, down_revision `a1b2c3d4e5f7`) + `JSONBMixin`, и enums
> `PracticeDirection` (meditation|yoga|breathwork) / `PracticeDifficulty` (beginner|medium|high).
> Таксономия (`data.taxonomy`: direction/difficulty/style) — schema-on-read, см. Бэковый
> Кодекс §3.8. На create direction/difficulty обязательны, style опционален; на PATCH все
> опциональны (merge). Не отдельная фаза — расширение поверх Phase 4.

> **Эпик E3: серии / повторяющиеся практики (июнь 2026, пост-фазовая):** расширение
> поверх Phase 4, ноль миграций. Спека повтора — `data.recurrence` (JSONB) на корне
> серии, оккуренции связаны существующим `parent_practice_id`; идентичность серии =
> `coalesce(parent_practice_id, id)`, корень = оккуренция №1. `RecurrenceSpec`
> (daily|weekly|biweekly; end never|until_date|after_count; потолок
> `practice_series_max_occurrences`=40) принимается на create только при
> `practice_type="series"`; оккуренции №2..N материализуются при ПУБЛИКАЦИИ корня
> (DST-safe), вырожденная спека (0 сессий после первой) -> 400. Карточка
> `PracticeResponse` получила `recurrence_days/total_sessions/completed_sessions`
> (2 запроса, без N+1; публичный фид их не отдаёт). Отмена приняла тело
> `CancelPracticeRequest { scope: this|this_and_future }` (`_cancel_one` ядро +
> scope-обёртка). Детали — Бэковый Кодекс §3.13 и §2; ответ на внешний аудит F8 —
> Бэковый Кодекс §9 (блок «Эпик E3…»).

---

### 4.2: CRUD для мастера ✅

**Цель:** Мастер может управлять практиками.

**Задачи:**
- [x] app/modules/practices/schemas.py -- CreatePracticeRequest, UpdatePracticeRequest, PracticeResponse
- [x] app/modules/practices/service.py -- create, get, update, delete, list_master_practices
- [x] app/modules/practices/router.py -- POST, GET/{id}, PATCH/{id}, DELETE/{id}
- [x] app/modules/auth/dependencies.py -- добавлен `get_current_master`
- [x] app/modules/masters/router.py -- добавлен GET /masters/me/practices
- [x] app/core/config.py -- practice_min/max_duration_minutes
- [x] State machine enforcement (VALID_TRANSITIONS)
- [x] NOT NULL field guard (P-02)
- [x] FOR UPDATE на мутирующих операциях (P-12)
- [x] tests/test_practices.py -- 27 тестов

**Endpoints:**
```
POST   /api/v1/practices               -- создание (verified master only)
GET    /api/v1/practices/{id}           -- детали (любой auth user, visibility rules)
PATCH  /api/v1/practices/{id}           -- редактирование (owner master only)
DELETE /api/v1/practices/{id}           -- soft delete draft (owner master only)
GET    /api/v1/masters/me/practices     -- мои практики (verified master only)
```

**Результат:**
```
backend/app/modules/practices/
├── __init__.py
├── models.py        ← Phase 4.1 + DELETED status
├── schemas.py       ← Create/Update/Response, validators
├── service.py       ← CRUD + state machine + visibility
└── router.py        ← 4 endpoints (prefix=/api/v1/practices)

backend/app/modules/auth/dependencies.py  ← +get_current_master
backend/app/modules/masters/router.py     ← +GET /me/practices
backend/app/core/config.py               ← +duration bounds

backend/tests/
└── test_practices.py  ← 27 тестов (telegram_id range: 60xxx)
```

**Решения, принятые при реализации:**

- **`get_current_master`** dependency -- проверяет role=MASTER + MasterProfile exists + status=verified. Возвращает `tuple[User, MasterProfile]`. Переиспользуется в Phase 6 (withdrawals), Phase 8 (insights)
- **GET /masters/me/practices** живёт в `masters/router.py` (URL domain), service-функция в `practices/service.py` (бизнес-логика). Возвращает `PaginatedPracticesResponse` с total/limit/offset (R-04, консистентно с public feed)
- **Soft delete vs cancel:**
  - `DELETE` на draft → `status=deleted` (мастер тихо удалил черновик, без последствий)
  - Cancel для published практик → `cancel_practice()` в Phase 6.5 (refunds, уведомления)
  - `deleted` и `cancelled` -- разные статусы с разной семантикой
- **State machine enforcement** -- `_VALID_TRANSITIONS` map в service:
  ```
  draft      → scheduled, deleted (via PATCH)
  scheduled  → live (via PATCH)
  scheduled  → cancelled (via cancel_practice() ONLY — Phase 6.5)
  live       → completed (via PATCH)
  live       → cancelled (via cancel_practice() ONLY — Phase 6.5)
  completed  → (terminal)
  cancelled  → (terminal)
  deleted    → (terminal)
  ```
  PATCH с невалидным переходом → 400. `UpdatePracticeRequest.status` Literal: `scheduled, live, completed, deleted` (I-04: `cancelled` и `draft` убраны — недостижимы через PATCH). Попытка PATCH status=cancelled → 422 от Pydantic
- **FOR UPDATE (P-12)** -- `update_practice()` и `delete_practice()` используют `with_for_update()` для предотвращения lost updates при concurrent status transitions
- **NOT NULL guard (P-02)** -- `_NOT_NULL_FIELDS = {"title", "scheduled_at", "duration_minutes", "timezone"}`. PATCH с explicit null → 400 (не 500 IntegrityError)
- **Ownership checks (P-08)** -- update_practice и delete_practice возвращают 404 (не 403) при чужом ресурсе, единообразно с cancel_practice, bookings, waitlist, reports (R-01 fix)
- **Visibility rules** -- GET /{id}: draft/deleted видит только owner, остальным 404 (P-08: 404 not 403). scheduled/live/completed/cancelled видят все auth users
- **Validation** -- scheduled_at > now, IANA timezone (ZoneInfo), duration в config-bounds (5-480 min), practice_type через Literal
- **Config** -- `PRACTICE_MIN_DURATION_MINUTES=5`, `PRACTICE_MAX_DURATION_MINUTES=480` (настраиваемо через .env)
- **list_master_practices** -- excludes deleted, shows own drafts, ORDER BY scheduled_at DESC, limit/offset
- **telegram_id ranges**: 60001-60099 masters, 60100-60199 regular users, 60900-60999 admins

**Аудит:**
- Round 12: 3 проблемы MEDIUM (no FOR UPDATE, no state machine, title missing from NOT_NULL_FIELDS) + 1 LOW (P-02 null for NOT NULL). Все исправлены
- Предсказанные ошибки из Code Review Guide (P-02, P-12) -- выявлены и закрыты

**Критерий готовности:** Мастер может создать и управлять практикой. 115 тестов, 0 warnings. ✅

---

### 4.3+4.4: Public Feed + Pricing ✅

**Цель:** Юзеры видят доступные практики. Мастер может установить цену.

> **Объединение:** 4.3 (public feed) и 4.4 (pricing) реализованы вместе,
> т.к. price-сортировка из 4.3 требует pricing-колонки из 4.4,
> а pricing без листинга бесполезен.

> **Отказ от отдельной таблицы:** ТЗ предполагало `PracticePricing` (1:1 с Practice).
> Решено добавить колонки прямо в `practices` — 1:1 = лишний JOIN, а цена устанавливается
> при создании практики (часть `CreatePracticeRequest`), не отдельным endpoint-ом.

**Задачи:**
- [x] Миграция: ALTER TABLE practices ADD `is_free`, `price_cents`, `currency`
- [x] practices/models.py -- +3 pricing колонки
- [x] practices/schemas.py -- pricing в Create/Update/Response + PaginatedPracticesResponse
- [x] practices/service.py -- `_enforce_pricing()` + `list_public_practices()`
- [x] practices/router.py -- GET /api/v1/practices (public feed)
- [x] tests/test_practices.py -- 26 → 27 тестов (+4 pricing, +6 feed, +1 delete_not_owner R-01)

**Endpoints (обновлённый полный список):**
```
GET    /api/v1/practices                -- public feed (4.3)
POST   /api/v1/practices               -- create (master only, 4.2)
GET    /api/v1/practices/{id}           -- get by id (any auth, 4.2)
PATCH  /api/v1/practices/{id}           -- update (owner master, 4.2)
DELETE /api/v1/practices/{id}           -- soft delete draft (owner, 4.2)
GET    /api/v1/masters/me/practices     -- my practices (master, 4.2)
```

**Public feed query params:**
```
GET /api/v1/practices?
    practice_type=live              -- Literal[live,series,one_on_one,replay]
    &status=scheduled               -- Literal[scheduled,live]
    &master_id=uuid
    &date_from=2026-02-01T00:00:00Z
    &date_to=2026-03-01T00:00:00Z
    &sort_by=price_cents            -- Literal[scheduled_at,price_cents]
    &sort_order=asc                 -- Literal[asc,desc]
    &limit=20                       -- 1..100
    &offset=0                       -- >=0

Response: {
    "items": [...PracticeResponse],
    "total": 45,
    "limit": 20,
    "offset": 0
}
```

**Pricing колонки (в таблице practices):**
```python
is_free: Mapped[bool]        # default=True, server_default="true"
price_cents: Mapped[int]     # default=0, server_default="0", NOT NULL
currency: Mapped[str]        # String(3), default="EUR", server_default="EUR"
```

**Результат:**
```
backend/app/modules/practices/
├── models.py        ← +is_free, price_cents, currency
├── schemas.py       ← +pricing fields + PaginatedPracticesResponse
├── service.py       ← +_enforce_pricing() + list_public_practices()
└── router.py        ← +GET "" public feed (before /{id})

backend/migrations/versions/
└── 2026_02_12_d4e5f6a7b8c9_add_practice_pricing.py

backend/tests/
└── test_practices.py  ← 26 тестов (telegram_id range: 60xxx)
```

**Решения, принятые при реализации:**

- **Колонки в Practice** (не отдельная таблица PracticePricing) -- 1:1 = лишний JOIN, цена часть CreatePracticeRequest. Миграция: ALTER TABLE с server_default — безопасно для существующих данных (все → free/0/EUR)
- **price_cents: int, NOT NULL, default=0** (не nullable!) -- nullable ломает SUM/AVG, усложняет сортировку. `is_free=True → price_cents=0` (invariant)
- **Pricing invariant** (`_enforce_pricing()`):
  - `is_free=True` → price_cents **принудительно** = 0 (даже если клиент прислал 500)
  - `is_free=False` → price_cents **обязательно** > 0, иначе 400
  - Применяется в create и в update (с resolve final values из existing + patch)
- **Центы, не доллары** -- `price_cents: int` (1500 = €15.00). Совместимо с будущим Phase 6 (balance migration planned, см. TD-033)
- **currency: "EUR"** -- MVP single currency. `Literal["EUR"]` в schema — расширяемо
- **Public feed** -- только `scheduled` + `live` (`_FEED_STATUSES`). Draft/deleted/completed/cancelled невидимы. Фильтр status ограничен `Literal["scheduled","live"]` — нельзя запросить draft
- **Router ordering** -- `GET ""` (list) определён **перед** `GET "/{id}"`, чтобы FastAPI не парсил query-строку как UUID
- **Sort injection protection** -- `sort_by` через `Literal`, не строковая подстановка в SQL
- **Count query sync** -- те же фильтры применены к items и count запросам
- **`_NOT_NULL_FIELDS`** расширен: +`is_free`, `price_cents`, `currency`

**Аудит:** Раунд 16 — чистый проход. Все 12 паттернов (P-01..P-12) пройдены. Pricing edge cases проверены (6 сценариев).

**Критерий готовности:** Юзер видит практики с фильтрами. Мастер устанавливает цену. 115 тестов, 0 warnings. ✅

> **Calendar iteration (2026-05-22, пост-фазовая):** `list_public_practices` расширен
> мульти-фасетными фильтрами `direction[]/difficulty[]/style` (из `data.taxonomy`),
> `practice_type` стал мульти, добавлены `duration_bucket` (short<60/long>=60) и
> `time_of_day` (night/morning/day/evening по локальному часу практики через
> `func.timezone`+`extract`, без сырого SQL). OR внутри фасета, AND между фасетами.
> `PracticeResponse` получил per-user флаги `is_booked`/`is_paid` (вариант 1: paid =
> booked И price_cents>0). Детальный эндпоинт собирается публичной `get_practice_detail()`
> (C-1 аудита). Пороги фильтров — в `config.py` (NO-LITERALS). +13 тестов
> (test_practices.py, telegram_id 60xxx). Полностью: Бэковый Кодекс §2, §3.8, §7.
> Тесты после итерации: 435 passed.

---

## PHASE 5: Bookings

### 5.1+5.2: Booking Model + Create/Cancel ✅

**Цель:** Модель бронирования. Юзер может записаться и отменить.

> **Объединение:** 5.1 (модель) и 5.2 (endpoints) реализованы вместе.

**Задачи:**
- [x] app/modules/bookings/models.py -- Booking, BookingStatus (StrEnum)
- [x] app/modules/bookings/schemas.py -- CreateBookingRequest, CancelBookingRequest, BookingResponse
- [x] app/modules/bookings/service.py -- create_booking(), cancel_booking()
- [x] app/modules/bookings/router.py -- POST, DELETE
- [x] Миграция create_bookings_table (down_revision: d4e5f6a7b8c9)
- [x] tests/test_bookings.py -- 13 тестов

**Endpoints:**
```
POST   /api/v1/bookings          -- create booking (any auth user)
DELETE /api/v1/bookings/{id}     -- cancel booking (owner only)
```

**Модель:**
```python
class BookingStatus(enum.StrEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    ATTENDED = "attended"
    NO_SHOW = "no_show"
    CANCELLED = "cancelled"

class Booking(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "bookings"

    practice_id: Mapped[UUID]   # FK practices.id, CASCADE, index=True (R-07)
    user_id: Mapped[UUID]       # FK users.id, CASCADE, index=True (R-07)
    status: Mapped[str]         # String(20), default "pending"
    purchase_id: Mapped[UUID | None]  # Phase 6.4, index=True (W-02), FK in migration e4f5a6b7c8d9
    cancelled_at: Mapped[datetime | None]
    cancellation_reason: Mapped[str | None]
    joined_at: Mapped[datetime | None]   # Phase 5.4
    left_at: Mapped[datetime | None]     # Phase 5.4

    # H-02: partial unique index -- prevents duplicate active bookings
    # but allows re-booking after cancellation.
    Index("uq_booking_practice_user_active", practice_id, user_id,
          unique=True, postgresql_where=text("status != 'cancelled'"))
```

**State machine:**
```
pending   -> confirmed, cancelled
confirmed -> attended, no_show, cancelled
attended  -> (terminal)
no_show   -> (terminal)
cancelled -> (terminal)
```

**Результат:**
```
backend/app/modules/bookings/
├── __init__.py
├── models.py        ← Booking + BookingStatus
├── schemas.py       ← Create/Cancel/Response
├── service.py       ← create_booking, cancel_booking
└── router.py        ← POST + DELETE

backend/migrations/versions/
├── 2026_02_12_e5f6a7b8c9d0_create_bookings_table.py
├── 2026_02_17_f5a6b7c8d9e0_booking_partial_unique_index.py (H-02)
└── 2026_02_18_a7b8c9d0e1f2_add_index_booking_purchase_id.py (W-02)

backend/tests/
└── test_bookings.py  ← 13 тестов (telegram_id range: 61xxx)
```

**Решения, принятые при реализации:**

- **`booked_at` убран** -- дублирует `created_at` из TimestampMixin. Косяк ТЗ, исправлен
- **`purchase_id: UUID | None`** -- FK added in Phase 6.4 (migration `e4f5a6b7c8d9`), `index=True` added by W-02 (migration `a7b8c9d0e1f2`)
- **`joined_at / left_at`** включены сразу -- Phase 5.4 (attendance) в той же Phase 5
- **H-02: partial unique index** -- заменяет абсолютный UniqueConstraint. Позволяет re-booking после отмены (миграция `f5a6b7c8d9e0`). Два отменённых booking'а для (practice, user) допустимы
- **R-07: index=True** на practice_id и user_id -- индексы существовали в миграции с Phase 5.1, `index=True` в модели добавлен для синхронности
- **Capacity: COUNT** (not increment `current_participants`) -- `SELECT COUNT(*) FROM bookings WHERE status IN (pending, confirmed)`. Точнее, нет risk рассинхрона. `current_participants` обновляется через `recalculate_participants()` как denormalized cache для PracticeResponse (TD-034 resolved)
- **Только scheduled** практики допускают бронирование (`live` = уже идёт)
- **Self-booking prevention** -- `practice.master_id == user.id` → 400 (мастер не может забронировать свою практику)
- **Мастер как юзер** -- мастер может бронировать чужие практики (мастер = юзер за пределами своей практики)
- **Free → auto-confirm** -- booking создаётся сразу в `confirmed` (не `pending`). Розетка для модерации мастером оставлена на будущее (за пределами MVP)
- **Duplicate → 409** -- partial unique index (H-02) WHERE status != 'cancelled' + `try/except IntegrityError` + `rollback()` (P-05). Позволяет re-booking после отмены
- **FOR UPDATE на Practice** при создании booking -- capacity check + INSERT атомарны, предотвращает overbooking
- **P-08** -- cancel_booking: non-owner получает 404 (не 403), единообразно со всеми модулями

> **Из Phase 4.2:** DELETE endpoint для практик работает только на draft'ах (→ status=deleted).
> Отмена published практик (scheduled/live → cancelled) с refund-логикой -- Phase 6.5.

**Аудит:** 1 замечание LOW (P-08 cancel 403→404). Исправлено.

**Критерий готовности:** Юзер может записаться и отменить. 128 тестов, 0 warnings. ✅

---

### 5.3: Waitlist ✅

**Цель:** Очередь ожидания. При отмене брони — автоматическое уведомление первого в очереди.

**Задачи:**
- [x] app/modules/waitlist/models.py -- Waitlist, WaitlistStatus (StrEnum)
- [x] app/modules/waitlist/schemas.py -- WaitlistEntryResponse, WaitlistConfirmResponse
- [x] app/modules/waitlist/service.py -- join_waitlist, leave_waitlist, confirm_waitlist, process_waitlist
- [x] app/modules/waitlist/router.py -- 3 endpoints (2 роутера)
- [x] Миграция create_waitlist_table (down_revision: e5f6a7b8c9d0)
- [x] Патч bookings/service.py -- cancel_booking → process_waitlist
- [x] Патч main.py -- include waitlist routers
- [x] tests/test_waitlist.py -- 19 тестов

**Endpoints:**
```
POST   /api/v1/practices/{id}/waitlist   -- join waitlist (any auth user)
DELETE /api/v1/waitlist/{id}             -- leave / decline (owner only)
POST   /api/v1/waitlist/{id}/confirm     -- confirm spot (creates booking)
```

**Модель:**
```python
class WaitlistStatus(enum.StrEnum):
    WAITING = "waiting"
    NOTIFIED = "notified"
    CONVERTED = "converted"
    LEFT = "left"
    DECLINED = "declined"
    EXPIRED = "expired"

class Waitlist(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "waitlist"

    practice_id: Mapped[UUID]       # FK practices.id, CASCADE, index=True (R-07)
    user_id: Mapped[UUID]           # FK users.id, CASCADE, index=True (R-07)
    position: Mapped[int]           # computed at INSERT/re-join
    status: Mapped[str]             # String(20), default "waiting"
    joined_at: Mapped[datetime]     # updated on re-join
    notified_at: Mapped[datetime | None]
    expires_at: Mapped[datetime | None]  # notified_at + 30 min

    UniqueConstraint("practice_id", "user_id")
    Index("ix_waitlist_practice_status_position", practice_id, status, position)
```

**State machine:**
```
waiting   -> notified, left
notified  -> converted, declined, expired, left
converted -> (terminal)
left      -> waiting (re-join: UPDATE position, joined_at, status)
declined  -> waiting (re-join)
expired   -> waiting (re-join)
```

**Результат:**
```
backend/app/modules/waitlist/
├── __init__.py
├── models.py        ← Waitlist + WaitlistStatus + REJOINABLE/ACTIVE sets
├── schemas.py       ← WaitlistEntryResponse, WaitlistConfirmResponse
├── service.py       ← join, leave, confirm, process_waitlist
└── router.py        ← 2 роутера (practices_waitlist_router, waitlist_router)

backend/migrations/versions/
└── 2026_02_12_f6a7b8c9d0e1_create_waitlist_table.py

backend/tests/
└── test_waitlist.py  ← 19 тестов (telegram_id range: 62xxx)
```

**Решения, принятые при реализации:**

- **Soft delete** -- нет hard delete. Leave/decline/expire меняют статус. Re-join обновляет ту же строку (UniqueConstraint остаётся простым)
- **Position: stored column** -- `MAX(position) + 1` subquery, race-safe т.к. Practice залочен FOR UPDATE. "Дырки" (1, 3, 5) допустимы — порядок сохраняется
- **Re-join** -- UPDATE существующей строки с новым position в конце очереди. Справедливо: ушёл — вернулся в хвост
- **Два роутера** -- `practices_waitlist_router` (`/practices/{id}/waitlist`) + `waitlist_router` (`/waitlist/{id}`) из-за разных URL-префиксов
- **process_waitlist** -- внутренняя функция, вызывается из cancel_booking (lazy import для circular prevention) и из leave (при decline)
- **Notifications** -- stub через `logger.info("waitlist_notification_stub", ...)`, реальные Telegram уведомления в Phase 7
- **Lazy expiration** -- проверка в confirm endpoint как safety net. Полная periodic task — отдельный тикет (Pre-6 или Phase 7)

**Баги найденные и исправленные (Раунд 18-19):**

1. **MEDIUM — Overbooking race** (Раунд 18): `confirm_waitlist` не проверял capacity. Между cancel и confirm конкурентный `create_booking` мог занять место → overbooking. **Фикс:** FOR UPDATE на Practice + capacity recheck. Если место занято → `entry.status = WAITING` (обратно в очередь, пользователь не виноват) + `return (entry, None)`

2. **MEDIUM — Lazy expiration rollback** (Раунд 18): `BadRequestError` после `entry.status = EXPIRED` + `process_waitlist` вызывал rollback в `get_db_session` → изменения терялись, entry "застревал" в notified. **Фикс:** `return (entry, None)` вместо raise. Роутер проверяет `booking is None` → `JSONResponse(400)` (не exception → get_db_session коммитит)

**Паттерн `return None + JSONResponse`:**
Когда service-функция должна одновременно (a) закоммитить изменения состояния и (b) вернуть ошибку клиенту — нельзя бросать exception (P-01: get_db_session откатит). Решение: service возвращает маркер (None), роутер возвращает JSONResponse(400) напрямую. Коммит происходит нормально.

**Аудит:** 2 замечания MEDIUM (overbooking race, expiration rollback). Исправлены. Re-check Раунд 19: ✅ чисто.

**Критерий готовности:** Waitlist работает автоматически. 145 тестов, 0 warnings. ✅
---

### 5.4: Attendance tracking ✅

**Цель:** Учёт посещаемости. Юзер чекинится при входе на Zoom. Мастер финализирует практику.

**Задачи:**
- [x] bookings/service.py -- +join_booking, leave_booking, finalize_practice, get_attendance
- [x] bookings/router.py -- +4 endpoints + practices_attendance_router
- [x] bookings/schemas.py -- +AttendanceItemResponse, AttendanceResponse
- [x] main.py -- include practices_attendance_router
- [x] tests/test_attendance.py -- 14 тестов

**Endpoints:**
```
POST   /api/v1/bookings/{id}/join         -- check-in (user, sets joined_at)
POST   /api/v1/bookings/{id}/leave        -- check-out (user, sets left_at)
POST   /api/v1/practices/{id}/finalize    -- finalize (master-owner only)
GET    /api/v1/practices/{id}/attendance   -- attendance list (master-owner only)
```

**Результат:**
```
backend/app/modules/bookings/
├── service.py       ← +4 функции (join, leave, finalize, attendance)
├── router.py        ← +4 endpoints, +practices_attendance_router
└── schemas.py       ← +AttendanceItemResponse, AttendanceResponse

backend/tests/
└── test_attendance.py  ← 14 тестов (telegram_id range: 63xxx)
```

**Миграция: не нужна** — joined_at, left_at уже в модели Booking (Phase 5.1). COMPLETED уже в PracticeStatus (Phase 4.1).

**Ключевые решения:**

- **Join ≠ attended**: join ставит только `joined_at`, статус остаётся `confirmed`. Переход в `attended` происходит при finalize. Это даёт мастеру контроль до финализации и безопаснее (случайный join не блокирует cancel)
- **Joinable statuses**: `{scheduled, live}`. Бэкенд не привязан к расписанию Zoom — join это просто чекин. Но нельзя чекиниться в cancelled/completed/deleted/draft практику
- **Finalize — bulk operation**: все confirmed bookings с joined_at → attended, без joined_at → no_show. Practice → completed. Идемпотентность: повторный finalize → 400 "already finalized"
- **Leave без join → 400**: бессмысленная операция, блокируем
- **Double join → 409**: строго, не идемпотентно (по решению)
- **Два роутера**: booking-level (join/leave) в `router`, practice-level (finalize/attendance) в `practices_attendance_router` — аналогично waitlist pattern
- **Attendance GET**: read-only, использует `get_db_reader`. Доступен в любом статусе практики (можно смотреть и после completed)
- **AttendanceResponse**: содержит агрегаты (total, attended, no_show, pending) + items list

> **Attendance enrichment (2026-06-02, пост-фазовая):** `AttendanceItemResponse`
> расширен под экран подготовки мастера: помимо `booking_id/user_id/status/
> joined_at/left_at` теперь несёт `user_display_name`, `user_avatar_url` и PRE-чек-ин
> участника `checkin: { mood, comment } | null` (новая схема `AttendanceCheckinResponse`
> в `bookings/schemas.py`). `get_attendance` батч-грузит участников (`User.id IN`) и
> PRE-чек-ины через новую `diary/service.py::get_pre_checkins_for_bookings`
> (`Checkin.booking_id IN`) — два запроса, без N+1. Приватность: PRE-чек-ин участника
> осознанно открыт владельцу практики и только в рамках её attendance (ownership →
> P-08); глобальная приватность `/users/me/checkins` не тронута. Поле
> `master_request`/эндпоинт «вопрос мастеру» НЕ добавлялись — диалог юзер↔мастер
> вынесен в отдельную фичу (TD-ASK-MASTER), вне MVP. +6 тестов (14 -> 20,
> `test_attendance.py` 63xxx). Полностью: Бэковый Кодекс §3.12.

**Concurrency (аудит Раунд 20):**
- join_booking: FOR UPDATE на Booking. Practice — только чтение статуса
- leave_booking: FOR UPDATE на Booking
- finalize_practice: FOR UPDATE на Practice + все confirmed Bookings
- Concurrent join + finalize: сериализуются через row-level lock на Booking. Оба порядка корректны (finalize первый → join видит status≠confirmed → 400; join первый → finalize видит joined_at → attended)

**Аудит:** 0 замечаний. Все 12 паттернов (P-01…P-12) пройдены чисто.

**Критерий готовности:** Мастер видит кто пришёл. 159 тестов, 0 warnings. ✅

---

## PRE-6: Logging Hardening + Audit

> Перенесена из Phase 0.6. Базовый structlog уже работает (Phase 0.3).
> Здесь: доработка логирования + аудит финансовых операций, необходимый для Phase 6.

### Pre-6.1: Logging hardening ✅

**Цель:** Довести structlog до production-качества.

**Задачи:**
- [x] Фильтрация по LOG_LEVEL (structlog `make_filtering_bound_logger`)
- [x] Идемпотентность `setup_logging()` (защита от двойной инициализации)
- [x] Middleware для trace_id (X-Trace-ID в каждый запрос/ответ)

**Решения, принятые при реализации:**
- Pure ASGI `TraceIdMiddleware` (не `BaseHTTPMiddleware` — избегаем двойное чтение body)
- Middleware также извлекает `ip_address` (X-Forwarded-For → ASGI client) и `user_agent` → contextvars
- `ip_address` и `user_agent` подхватываются `record_audit()` автоматически через `get_contextvars()`
- **Trace_id guard:** входящий `X-Trace-ID` длиннее 36 символов отбрасывается → генерируется uuid4. Защита от `DataError` в `AuditLog.trace_id = String(36)` при финансовых транзакциях

**Критерий готовности:** `LOG_LEVEL=WARNING` фильтрует debug/info, trace_id в каждом лог-сообщении. ✅

---

### Pre-6.2: Audit Service ✅

**Цель:** Аудит финансовых операций — юридическое требование.

**Задачи:**
- [x] app/core/audit.py — модель + сервис (единый файл, инфраструктурный слой)
- [x] Модель AuditLog (immutable, без TimestampMixin)
- [x] Миграция `a0b1c2d3e4f5`
- [x] 4 теста

**Решения, принятые при реализации:**
- AuditLog наследует `Base` напрямую (не UUIDMixin) — explicit uuid4 default, без `updated_at` (immutable)
- `actor_type: String(20)` — значения `"user"`, `"admin"`, `"system"` (не enum, задокументировано в docstring)
- `record_audit()` не коммитит (P-01), читает `trace_id`, `ip_address`, `user_agent` из contextvars
- structlog kwarg: `audit_event=event` (не `event=event` — конфликт с positional arg structlog)

**Модель AuditLog:**
```python
class AuditLog(Base):
    __tablename__ = "audit_logs"
    
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    
    event: Mapped[str] = mapped_column(String(100), index=True)
    actor_id: Mapped[UUID | None]
    actor_type: Mapped[str] = mapped_column(String(20))
    
    target_type: Mapped[str] = mapped_column(String(50))
    target_id: Mapped[UUID]
    
    data: Mapped[dict] = mapped_column(JSONB)
    
    ip_address: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(500))
    trace_id: Mapped[str | None] = mapped_column(String(36))
```

**Обязательные события для аудита:**

| Событие | Когда логировать |
|---------|------------------|
| `balance_topup` | Пополнение баланса |
| `purchase_created` | Покупка практики |
| `purchase_refunded` | Возврат |
| `withdrawal_requested` | Запрос на вывод |
| `withdrawal_confirmed` | Подтверждение вывода |
| `master_verified` | Верификация мастера |
| `master_rejected` | Отклонение заявки |
| `role_changed` | Изменение роли |
| `user_blocked` | Блокировка юзера |
| `practice_cancelled` | Отмена практики мастером |

**Retention policy:**
- Application logs (stdout): 30 дней
- Audit logs (БД): 5 лет (законодательные требования для финансов)

**Критерий готовности:** Аудит пишется в БД, trace_id связывает лог + аудит.

---

## PHASE 6: Payments

### 6.1: Ledgers ✅

**Цель:** Три журнала транзакций.

**Задачи:**
- [x] app/modules/payments/models.py — UserLedger, MasterLedger, CompanyLedger
- [x] Миграция `b1c2d3e4f5a6` — три таблицы
- [x] Миграция `c2d3e4f5a6b7` — TD-033: `Numeric(18,2)` → `Integer` (cents) + rename

**Модели (актуальные):**
- `LedgerStatus(StrEnum)`: `pending`, `done`, `cancelled`
- `CompanyLedgerType(StrEnum)`: `commission`, `marketing`, `refund`, `withdrawal_fee`
- `UserLedger`: UUIDMixin, `user_id`, `amount_cents: int`, `status`, `reason`, `notes`, `created_at`
- `MasterLedger`: UUIDMixin, `user_id`, `amount_cents: int`, `is_frozen: bool`, `status`, `reason`, `practice_id`, `notes`, `created_at`
- `CompanyLedger`: UUIDMixin, `amount_cents: int`, `type`, `status`, `reason`, `reference_id: UUID | None`, `created_at`

**Решения, принятые при реализации:**
- Все суммы в EUR cents (`Integer`), не `Decimal` (TD-033 resolved)
- `StrEnum` (P-09), хранение как `String(20)` (не PG ENUM)
- UUIDMixin для `id`, без TimestampMixin (immutable — только `created_at`, нет `updated_at`)
- `CompanyLedger.reference_id` — опциональная ссылка на purchase/withdrawal для audit trail
- **Rename balance columns:** `User.balance_user` → `balance_cents`, `MasterProfile.frozen_amount` → `frozen_cents`, `MasterProfile.available_amount` → `available_cents`
- Обновлены schemas: `UserResponse.balance_cents: int`, `MasterProfileResponse.frozen_cents: int`, `available_cents: int`
- Индексы: `user_id`, `practice_id`, `created_at`, `reference_id`

**Критерий готовности:** Миграции применены. 170 тестов. ✅

---

### 6.2: Balance listeners ✅

**Цель:** Автоматический пересчёт балансов.

**Задачи:**
- [x] app/modules/payments/service.py — три `record_*` функции
- [x] Listener на user_ledger → User.balance_cents
- [x] Listener на master_ledger → MasterProfile.frozen_cents / available_cents
- [x] Защита от прямого изменения балансов (`__setattr__` guard)
- [x] 5 тестов

**Логика (актуальная):**
```python
# User balance (SUM in cents)
User.balance_cents = SUM(user_ledger.amount_cents) WHERE status='done'

# Master balance — ДВА поля, ОДИН запрос (CASE SUM)
MasterProfile.frozen_cents = SUM(CASE WHEN is_frozen THEN amount_cents ELSE 0)
    WHERE status='done'
MasterProfile.available_cents = SUM(CASE WHEN NOT is_frozen THEN amount_cents ELSE 0)
    WHERE status='done'
```

**Решения, принятые при реализации:**
- **Не event listeners** — SQLAlchemy `@event.listens_for` синхронный, в async (asyncpg) не работает. Используем явные сервисные функции: `record_user_ledger()`, `record_master_ledger()`, `record_company_ledger()`
- **Паттерн:** `add → flush → SELECT SUM() → FOR UPDATE on owner row → update cache → flush`
- **Concurrency (P-07):** `session.get(User, id, with_for_update=True)` сериализует конкурентные записи одного владельца
- **Balance guard:** `__setattr__` на User и MasterProfile — логирует `warning("direct_balance_write")` при прямом присвоении `balance_cents`/`frozen_cents`/`available_cents`. НЕ блокирует — safety net
- **`_ledger_update` flag bypass:** `record_*` функции устанавливают `object.__setattr__(obj, '_ledger_update', True)` перед присвоением, чтобы guard молчал. `object.__setattr__` для флага, обычное присвоение для значения (SQLAlchemy instrumentation)

> **Архитектурное правило (P-13): `object.__setattr__` vs SQLAlchemy instrumentation.**
> `object.__setattr__(model, "field", value)` обходит SQLAlchemy instrumented descriptor —
> ORM НЕ видит изменение, НЕ включает поле в UPDATE. `flag_modified()` тоже не помогает
> (дескриптор не участвовал). Для обхода custom `__setattr__` guard'а при сохранении
> ORM tracking: использовать `_ledger_update` flag + обычное присвоение + `flush()`.

**Критерий готовности:** Балансы автоматически обновляются при записи в ledger. 170 тестов. ✅

---

### 6.3: Stripe integration (пополнение) ✅

**Цель:** Пополнение баланса через Stripe.

**Задачи:**
- [x] app/modules/payments/models.py -- +Payment, PaymentDirection, PaymentStatus
- [x] app/modules/payments/schemas.py -- TopupRequest, TopupResponse, PaymentResponse
- [x] app/modules/payments/stripe.py -- Stripe SDK wrapper (create_topup_session, verify_webhook_signature, handle_checkout_completed, handle_checkout_expired_or_failed)
- [x] app/modules/payments/router.py -- POST /api/v1/payments/topup
- [x] app/modules/payments/webhook_router.py -- POST /webhooks/stripe
- [x] core/config.py -- +6 Stripe settings, +2 topup limits
- [x] Миграция `d3e4f5a6b7c8` -- payments table
- [x] tests/test_payments_topup.py -- 11 тестов (telegram_id range: 73xxx)
- [x] tests/test_payments_stripe_integration.py -- 1 тест (real Stripe, skipped by default)
- [x] **F5 Stub mode:** `_create_stub_topup()` в stripe.py — instant topup без Stripe для e2e тестирования

**Endpoints:**
```
POST /api/v1/payments/topup       -- создать Stripe Checkout Session (auth)
POST /webhooks/stripe             -- Stripe webhook (no auth, signature verify)
```

**Flow:**
```
1. User: POST /payments/topup {amount_cents: 1000}
2. Server: Create Payment(status=pending) + Stripe Checkout Session
3. Server: Return {payment_id, checkout_url, amount_cents, currency}
4. User: Redirect to Stripe, оплачивает
5. Stripe: Webhook → /webhooks/stripe (checkout.session.completed)
6. Server: 
   - Payment: pending → confirmed
   - user_ledger: +amount_cents, reason="payment:{payment.id}"
   - Balance: recalculated via record_user_ledger
   - Audit: payment_topup_confirmed
```

**Stub mode flow (is_stripe_stub=True, добавлено в F5):**
```
1. User: POST /payments/topup {amount_cents: 1000}
2. Server: _create_stub_topup():
   - Create Payment(status=confirmed, stripe_session_id="STUB")
   - record_user_ledger: +amount_cents (instant balance credit)
   - Audit: payment_topup_stub_confirmed
   - Return {payment_id, checkout_url=stripe_success_url, amount_cents, currency}
3. Frontend: redirect to /user/topup/success (no Stripe involved)
4. TopupSuccessView: balanceStore.refresh() → shows updated balance
```
Stub mode позволяет тестировать полный end-to-end flow (UI → API → ledger → balance) без Stripe ключей. Для перехода на реальный Stripe: заменить `STRIPE_SECRET_KEY=TEST` на настоящий ключ в `.env`.

**Модель Payment:**
```python
class PaymentDirection(StrEnum):
    IN = "in"    # Stripe topup
    OUT = "out"  # withdrawal to bank

class PaymentStatus(StrEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    FAILED = "failed"
    REFUNDED = "refunded"

class Payment(UUIDMixin, Base):
    __tablename__ = "payments"

    user_id: Mapped[UUID]              # FK users.id, CASCADE
    direction: Mapped[str]             # String(5), "in"/"out"
    amount_cents: Mapped[int]          # Integer
    currency: Mapped[str]              # String(3), default "eur"
    status: Mapped[str]                # String(20), default "pending"
    stripe_session_id: Mapped[str | None]          # String(200), UNIQUE
    stripe_payment_intent_id: Mapped[str | None]   # String(200)
    stripe_metadata: Mapped[dict | None]           # JSONB
    created_at: Mapped[datetime]
    confirmed_at: Mapped[datetime | None]
```

**Config (новые поля):**
```python
stripe_secret_key: str = ""           # sk_test_... или "TEST" (stub)
stripe_webhook_secret: str = ""       # whsec_...
stripe_success_url: str = ""          # Redirect after success
stripe_cancel_url: str = ""           # Redirect after cancel
min_topup_cents: int = 100            # EUR 1.00
max_topup_cents: int = 50000          # EUR 500.00
default_currency: str = "eur"

@property
def is_stripe_stub(self) -> bool:     # True when key == "TEST"
```

**Результат:**
```
backend/app/modules/payments/
├── models.py              ← +Payment, PaymentDirection, PaymentStatus
├── schemas.py             ← +TopupRequest, TopupResponse, PaymentResponse
├── stripe.py              ← NEW: Stripe SDK wrapper
├── router.py              ← NEW: POST /payments/topup
├── webhook_router.py      ← NEW: POST /webhooks/stripe
└── service.py             ← (Phase 6.2, без изменений)

backend/app/core/config.py ← +stripe_*, min/max_topup, is_stripe_stub

backend/migrations/versions/
└── ..._d3e4f5a6b7c8_create_payments_table.py

backend/tests/
├── test_payments_topup.py             ← 11 тестов (mocked Stripe)
└── test_payments_stripe_integration.py ← 1 тест (real Stripe, skip by default)
```

**Решения, принятые при реализации:**

- **Lazy `_configure_stripe()`** -- Stripe API key устанавливается при каждом вызове, не при импорте. Позволяет тестам мокать `settings.stripe_secret_key` без побочных эффектов
- **Stub mode** -- `settings.is_stripe_stub` (property: `stripe_secret_key.upper() == "TEST"`). Приложение стартует без Stripe, topup endpoint возвращает `BadRequestError("Payment system is not configured yet")`
- **Config validators** -- `stripe_secret_key`, `stripe_webhook_secret`, `stripe_success_url`, `stripe_cancel_url` — обязательны в production, auto-generated dev defaults в development
- **Webhook router — отдельный файл** -- `webhook_router.py` (не `router.py`), потому что: (a) нет Bearer auth (Stripe аутентифицируется через signature), (b) нужен raw body (bytes) для верификации подписи, (c) manual session management (`get_session_factory()` вместо `Depends(get_db_session)`)
- **Raw body** -- `Request.body()` перед парсингом. Stripe Webhook construct_event требует именно bytes, не parsed JSON
- **Idempotency** -- `handle_checkout_completed` проверяет `Payment.status == CONFIRMED` перед обновлением. Дублирующие webhooks — no-op. `stripe_session_id` UNIQUE — защита от дублей на уровне БД
- **FOR UPDATE** -- `handle_checkout_completed` и `handle_checkout_expired_or_failed` блокируют Payment row через `.with_for_update()` (P-07)
- **Return 200 always** -- после валидной подписи webhook всегда возвращает 200, даже при ошибке бизнес-логики. Stripe ретрит на не-2xx, а мы не хотим retry для наших ошибок. Payment остаётся pending для ручного разбора
- **Unhandled events** -- логируем и возвращаем `{"status": "ignored"}`. Будущие event types добавляются в `_HANDLED_EVENTS`
- **TopupRequest validation** -- `amount_cents: int = Field(ge=min_topup_cents, le=max_topup_cents)`. Pydantic даёт 422 при нарушении
- **Audit** -- два события: `payment_topup_created` (actor=user) при создании session, `payment_topup_confirmed` (actor=system) при webhook. Связаны через `target_id=payment.id`
- **Stripe metadata** -- `metadata={"payment_id": str, "user_id": str}` в Checkout Session. Для reconciliation в Stripe Dashboard
- **stripe_metadata JSONB** -- на Payment: хранит event data от webhook (customer_email, amount_total, currency). Для дебаггинга расхождений

**Аудит:** Раунд 24 — 0 замечаний. P-01 (no commit), P-07 (FOR UPDATE), P-08 (auth) пройдены.

**Критерий готовности:** Юзер может пополнить баланс через Stripe. 183 теста (3 skipped: Stripe integration). ✅

---

### 6.4: Purchase flow (frozen → unfrozen) ✅

**Цель:** Покупка практики с заморозкой средств и комиссией при финализации.

> **Архитектурное правило:** Каждая финансовая операция создаёт ЧЁТНОЕ количество
> ledger-записей. Всегда. Даже для бесплатных практик (paid_cents=0). Нулевые
> записи доказывают, что транзакция прошла полный путь, и поддерживают инвариант
> COUNT(bookings) = COUNT(purchases), SUM(all ledgers) = 0 (изначально проверялось
> consistency-семафорами; семафоры удалены 2026-07-07 `9ca5619`, инвариант в коде остался).

**Задачи:**
- [x] app/modules/payments/purchase.py -- create_purchase_for_booking(), finalize_purchases()
- [x] app/modules/payments/purchase_router.py -- POST /api/v1/practices/{id}/purchase
- [x] app/modules/payments/models.py -- +Purchase, PurchaseStatus (обновлён)
- [x] app/modules/payments/schemas.py -- +PurchaseResponse (обновлён)
- [x] app/modules/bookings/service.py -- purchase integration в create_booking и finalize_practice
- [x] app/modules/waitlist/service.py -- purchase integration в confirm_waitlist
- [x] core/config.py -- +commission_percent: int = 15
- [x] main.py -- +purchase_router
- [x] Миграция `e4f5a6b7c8d9` -- purchases table + FK bookings.purchase_id
- [x] tests/test_purchase.py -- 12 тестов (telegram_id range: 75xxx)
- [x] tests/test_bookings.py -- обновлён (purchase cleanup + assertion fix)

**Endpoints:**
```
POST /api/v1/practices/{id}/purchase  -- purchase (creates booking + purchase)
```

> Endpoint является alias для booking flow: создаёт Booking + Purchase в одной транзакции.
> Возвращает PurchaseResponse (богаче BookingResponse — включает финансовые детали).

**Double-entry бухгалтерия:**

Создание (create_purchase_for_booking):
```
user_ledger:   -price_cents  (дебет пользователя)
master_ledger: +price_cents  (кредит мастера, is_frozen=True)
Σ = 0 ✅
```

Финализация (finalize_purchases):
```
1. Bulk UPDATE: master_ledger.is_frozen = False (разморозка)
2. Per purchase:
   master_ledger:  -commission_cents (дебет мастера)
   company_ledger: +commission_cents (кредит компании)
   Σ = 0 ✅
```

Бесплатные практики (price_cents=0):
```
Ledger entries создаются с amount=0 -- инвариант double-entry соблюдён.
Commission = int(0 * rate) = 0 -- корректно.
```

**Модель Purchase:**
```python
class PurchaseStatus(StrEnum):
    PENDING = "pending"      # Practice not yet completed. Funds frozen.
    COMPLETED = "completed"  # Finalized. Commission deducted, funds unfrozen.
    REFUNDED = "refunded"    # User refund (Phase 6.5).
    CANCELLED = "cancelled"  # Booking cancelled without refund.

class Purchase(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "purchases"

    user_id: Mapped[UUID]          # FK users.id, CASCADE
    practice_id: Mapped[UUID]      # FK practices.id, CASCADE
    booking_id: Mapped[UUID]       # FK bookings.id, CASCADE, UNIQUE
    paid_cents: Mapped[int]        # Integer, default=0
    currency: Mapped[str]          # String(3), default "eur"
    commission_cents: Mapped[int]  # Integer, default=0
    status: Mapped[str]            # String(20), default "pending"
    completed_at: Mapped[datetime | None]
```

**Результат:**
```
backend/app/modules/payments/
├── purchase.py         ← NEW: create_purchase_for_booking, finalize_purchases
├── purchase_router.py  ← NEW: POST /practices/{id}/purchase
├── models.py           ← +Purchase, PurchaseStatus (updated)
├── schemas.py          ← +PurchaseResponse (updated)
├── stripe.py           ← (Phase 6.3, без изменений)
├── router.py           ← (Phase 6.3, без изменений)
├── webhook_router.py   ← (Phase 6.3, без изменений)
└── service.py          ← (Phase 6.2, без изменений)

backend/app/modules/bookings/
└── service.py          ← PATCHED: +create_purchase_for_booking, +finalize_purchases

backend/app/modules/waitlist/
└── service.py          ← PATCHED: +create_purchase_for_booking в confirm_waitlist

backend/app/core/config.py  ← +commission_percent: int = 15
backend/app/main.py         ← +purchase_router include

backend/migrations/versions/
└── ..._e4f5a6b7c8d9_create_purchases_table.py

backend/tests/
├── test_purchase.py    ← 12 тестов (telegram_id range: 75xxx)
└── test_bookings.py    ← UPDATED: +purchase cleanup, assertion fix
```

**Решения, принятые при реализации:**

- **Purchase для КАЖДОГО booking** -- даже бесплатного, для инварианта COUNT(bookings) == COUNT(purchases) на active records (изначально проверялось Semaphore 1.1; семафоры удалены 2026-07-07 `9ca5619`). Нулевые записи — это не мусор, а proof of path
- **booking_id UNIQUE** -- одна покупка на один booking. Двойная покупка невозможна ни на уровне кода (purchase создаётся внутри create_booking), ни на уровне БД (UNIQUE constraint)
- **FOR UPDATE на User** (P-07) -- `session.get(User, id, with_for_update=True)` перед проверкой баланса. Конкурентные покупки сериализуются через row-level lock
- **Commission — pure integer math** -- `paid_cents * commission_percent // 100`. Без float промежуточных значений, без Decimal. Центы — целые числа (L-07 fix, консистентно с refund.py)
- **commission_percent в config** -- `settings.commission_percent: int = 15`. Настраивается через .env. Тест `test_configurable_commission_percent` мокает через `patch.object(settings, "commission_percent", 20)`
- **Bulk unfreeze** -- `UPDATE master_ledger SET is_frozen=False WHERE practice_id=X AND is_frozen=True`. Один запрос вместо N. Следующий `record_master_ledger(-commission)` пересчитывает balance cache
- **Purchase router — alias** -- `POST /practices/{id}/purchase` вызывает `create_booking()` внутри, затем загружает Purchase. Это тот же flow, что и `POST /bookings`, но возвращает PurchaseResponse (с financial details)
- **bookings/service.py integration** -- `create_booking` вызывает `create_purchase_for_booking()` после flush booking. `finalize_practice` вызывает `finalize_purchases()` после bulk status update. Import на уровне модуля (не lazy, circular deps нет)
- **waitlist/service.py integration** -- `confirm_waitlist` загружает user объект и вызывает `create_purchase_for_booking()` после booking flush
- **Миграция e4f5a6b7c8d9** -- таблица purchases (FK на users, practices, bookings), booking_id UNIQUE. FK `fk_bookings_purchase_id` (ondelete=SET NULL) добавлен на bookings.purchase_id. Индексы: ix_purchases_user_id, ix_purchases_practice_id, ix_purchases_status. Downgrade: FK → индексы → таблица (правильный порядок)
- **Test cleanup fixture** -- autouse, before+after каждый тест. Порядок: ledger → nullify purchase_id → purchases → bookings → practices → master_profiles → reset roles/balance. Использует raw SQL text() (TD-032 backlog)

**Анализ конкурентности (из ревью Раунд 25):**

- **Двойная покупка одного booking:** Невозможна — booking_id UNIQUE + purchase создаётся в той же транзакции
- **Конкурентные покупки разных пользователей:** Сериализуются через FOR UPDATE на User (каждый свой row). Capacity check на уровне create_booking с FOR UPDATE на Practice
- **finalize_purchases:** Practice заблокирована вызывающим кодом. Purchases блокируются через .with_for_update()
- **Waitlist confirm + direct booking race:** confirm_waitlist блокирует Practice с FOR UPDATE и перепроверяет capacity. Если spot занят → WAITING

**Аудит:** Раунд 25 — 0 замечаний (CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0). Double-entry верифицирован. P-01 (no commit), P-05 (IntegrityError), P-07 (FOR UPDATE), P-12 (state machine) пройдены.

**Критерий готовности:** Деньги замораживаются при покупке, размораживаются после практики. Комиссия рассчитывается и записывается. 196 тестов (3 skipped), 0 warnings. ✅

---

### 6.5: Cancellations & Refunds ✅

**Цель:** Политика отмен с refund-логикой.

> **Из Phase 4.2:** Practice state machine уже enforcement'ится в service.
> `scheduled → cancelled` и `live → cancelled` -- допустимые переходы, но
> ТОЛЬКО через `cancel_practice()` (не через PATCH status). Это гарантирует
> прохождение refund-логики.

**Задачи:**
- [x] app/modules/practices/service.py -- cancel_practice() (Phase 6.5 endpoint)
- [x] app/modules/payments/refund.py -- refund_booking(), refund_all_bookings(), early_finalize_booking()
- [x] practices/router.py -- POST /api/v1/practices/{id}/cancel
- [x] CANCELLATION_DEADLINE_HOURS = 24
- [x] Автовозврат при отмене мастером (100% всем)
- [x] Early finalize для юзерской отмены (комиссия мастеру)
- [x] Waitlist cleanup при отмене практики
- [x] tests/test_cancellation.py

**Endpoint:**
```
POST /api/v1/practices/{id}/cancel  -- cancel practice (master-owner only)
```

**Бизнес-правила:**
| Кто отменяет | Когда | Результат |
|--------------|-------|-----------|
| Юзер | > 24ч до практики | 100% возврат, мастер получает комиссию |
| Юзер | < 24ч до практики | 0% возврат, средства мастеру |
| Мастер | Любое время | 100% возврат всем, waitlist cleared |
| No-show | После практики | Деньги у мастера (finalize) |

**Результат:**
```
backend/app/modules/practices/
└── service.py       ← +cancel_practice()

backend/app/modules/payments/
└── refund.py        ← refund_booking, refund_all_bookings, early_finalize_booking

backend/tests/
└── test_cancellation.py
```

**Решения, принятые при реализации:**
- **cancel_practice()** -- единственный путь к статусу `cancelled`. PATCH status=cancelled заблокирован на уровне Pydantic Literal (I-04). Это гарантирует, что refund-логика не будет обойдена
- **refund_all_bookings()** -- bulk: все active bookings → cancelled + refund. Waitlist active → left
- **early_finalize_booking()** -- при юзерской отмене > 24ч: разморозка средств мастеру + комиссия. Использует `paid_cents * commission_percent // 100` (L-07, integer math)
- **P-08** -- cancel_practice: non-owner получает 404, консистентно со всеми модулями

**Критерий готовности:** Отмены работают по правилам. ✅

---

### 6.6: Withdrawals ✅

**Цель:** Вывод средств мастером.

**Задачи:**
- [x] POST /api/v1/masters/me/withdraw — запрос на вывод
- [x] POST /api/v1/admin/withdrawals/{id}/confirm — подтверждение админом
- [x] Проверка MIN_WITHDRAWAL_AMOUNT (50 EUR = 5000 cents)
- [x] Комиссия WITHDRAWAL_FEE (2 EUR = 200 cents)
- [x] `payout: PayoutDetailsResponse | None` в MasterProfileResponse (F7 backend fix)
- [x] `_make_profile_response()` в masters/router.py — извлекает payout из JSONB data
- [x] app/modules/payments/models.py — +Withdrawal, WithdrawalStatus
- [x] masters/schemas.py — +PayoutDetails, PayoutDetailsResponse, WithdrawalResponse, PaginatedWithdrawalsResponse
- [x] masters/router.py — PATCH /me/payout, POST /me/withdraw, GET /me/withdrawals
- [x] admin/withdrawals/ sub-package — POST /withdrawals/{id}/confirm
- [x] tests/test_withdrawals.py — тесты выводов + payout profile

**Endpoints:**
```
PATCH /api/v1/masters/me/payout          -- обновить реквизиты выплат
POST  /api/v1/masters/me/withdraw        -- запрос на вывод (amount_cents)
GET   /api/v1/masters/me/withdrawals     -- история выводов (paginated)
POST  /api/v1/admin/withdrawals/{id}/confirm  -- подтверждение вывода админом
```

**Бизнес-правила:**
- Минимальная сумма: `settings.min_withdrawal_cents` (5000 = €50)
- Комиссия: `settings.withdrawal_fee_cents` (200 = €2) вычитается из суммы
- Создаётся запись в master_ledger: -amount_cents (withdrawal debit)
- После confirm: Payment(direction=OUT, confirmed) + company_ledger(withdrawal_fee)
- Статусы: pending → approved → completed / rejected

**Payout methods:**
- `bank_transfer`: IBAN (поле `account_number`)
- `paypal`: email
- `revolut`: revolut_tag

**F7 Backend фикс (применён):**

| Файл | Изменение |
|------|-----------|
| `masters/schemas.py` | `payout: PayoutDetailsResponse | None = None` в `MasterProfileResponse` |
| `masters/router.py` | `_make_profile_response()` извлекает `payout_raw = data.get("payout")`, конструирует `PayoutDetailsResponse` |

**Открытый техдолг:**

| ID | Файл | Проблема | Статус |
|----|------|----------|--------|
| TD-F7-W5 | `masters/models.py` (Withdrawal) | `payout_details: dict` — содержимое не ограничено схемой | ⬜ |

**Критерий готовности:** Мастер может запросить вывод, админ подтверждает. ✅

---

### 6.7: Promos ✅

**Цель:** Промокоды для скидок на практики.

**Задачи (4 batch'а):**
- [x] Batch 1: Модель Promo, миграция `d0e1f2a3b4c5` (promos table + amount_cents/discount_cents/promo_id в purchases)
- [x] Batch 2: Master CRUD -- POST /api/v1/masters/me/promos, GET /api/v1/masters/me/promos (paginated)
- [x] Batch 3: Admin CRUD -- POST /api/v1/admin/promos (company promo), GET/PATCH/DELETE admin endpoints
- [x] Batch 4: Purchase интеграция -- validate_promo, create_purchase_for_booking +promo, promo-aware refund/early_finalize, preview-purchase, bookings +promo_code

**Endpoints:**
```
POST   /api/v1/masters/me/promos          -- master creates promo
GET    /api/v1/masters/me/promos          -- list master's promos (paginated)
POST   /api/v1/admin/promos               -- admin creates company promo
GET    /api/v1/admin/promos               -- list all promos (paginated, filterable)
PATCH  /api/v1/admin/promos/{id}          -- update promo (is_active, max_uses, valid_until)
DELETE /api/v1/admin/promos/{id}          -- soft-delete (is_active=False)
POST   /api/v1/practices/{id}/purchase    -- +optional promo_code in body
POST   /api/v1/practices/{id}/preview-purchase  -- preview with/without promo
POST   /api/v1/bookings                   -- +optional promo_code in body
```

**Два типа промокодов:**

| Тип | Кто создаёт | Кто платит скидку | Commission base |
|-----|-------------|-------------------|-----------------|
| Company | Admin | company_ledger (marketing) | 15% × paid_cents (live money) |
| Master | Master | Master absorbs (получает меньше) | 15% × paid_cents (live money) |

**Allowed discounts:** `[5, 25, 50, 75, 100]` percent (from settings.promo_allowed_discounts).

**Модель Promo:**
```python
class PromoType(StrEnum):
    COMPANY = "company"
    MASTER = "master"

class Promo(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "promos"
    code: Mapped[str]              # unique, uppercased
    type: Mapped[str]              # PromoType
    master_id: Mapped[UUID | None] # FK users.id (master promos only)
    practice_id: Mapped[UUID | None]  # FK practices.id (scope, nullable = all)
    discount_percent: Mapped[int]  # CHECK > 0 AND <= 100
    max_uses: Mapped[int | None]   # nullable = unlimited
    used_count: Mapped[int]        # default=0, CHECK >= 0
    valid_from: Mapped[datetime]
    valid_until: Mapped[datetime | None]  # nullable = no expiry
    first_purchase_only: Mapped[bool]     # default=False
    is_active: Mapped[bool]        # soft delete
```

**Purchase Phase 6.7 columns:**
```python
# Added to purchases table:
amount_cents: int    # full price before discount (server_default=0)
discount_cents: int  # promo discount (server_default=0)
promo_id: UUID | None  # FK promos.id (SET NULL on delete)
# Invariant: paid_cents = amount_cents - discount_cents
```

**Результат:**
```
backend/app/modules/promos/
├── __init__.py
├── models.py          ← Promo, PromoType
├── schemas.py         ← CreateMasterPromoRequest, CreateCompanyPromoRequest, PromoResponse, etc.
├── service.py         ← create_master_promo, list_master_promos
├── admin_service.py   ← create_company_promo, list_all_promos, update_promo, delete_promo
├── admin_router.py    ← POST/GET/PATCH/DELETE /api/v1/admin/promos
├── router.py          ← POST/GET /api/v1/masters/me/promos
└── validation.py      ← validate_promo, calculate_discount, increment_promo_usage

backend/app/modules/payments/
├── purchase.py        ← create_purchase_for_booking +promo (3 ledger patterns)
├── purchase_router.py ← +promo_code in purchase, +preview-purchase
├── refund.py          ← promo-aware refund + early_finalize
└── schemas.py         ← +PurchaseRequest, PreviewPurchaseRequest/Response

backend/app/modules/bookings/
├── router.py          ← +promo validation before create_booking
├── service.py         ← create_booking +promo param passthrough
└── schemas.py         ← +promo_code in CreateBookingRequest

backend/tests/
└── test_promo_purchase.py  ← 24 теста (telegram_id range 81xxx)

backend/migrations/versions/
└── 2026_02_21_d0e1f2a3b4c5_create_promos_and_update_purchases.py
```

**Решения, принятые при реализации:**
- **Race condition (P-07):** used_count инкрементируется атомарно: `UPDATE promos SET used_count = used_count + 1 WHERE id = X AND (max_uses IS NULL OR used_count < max_uses)`. Если rowcount=0 -- promo exhausted
- **3 ledger-паттерна:** (1) no promo -- как раньше; (2) master promo -- user платит paid_cents, master получает paid_cents (меньше full price); (3) company promo -- user платит paid_cents, master получает amount_cents (full price), company_ledger покрывает discount_cents как marketing
- **Commission:** всегда 15% × paid_cents (live money, не discount). Даже при 100% скидке commission=0
- **Master promo refund:** reverse paid_cents (master got less, returns less)
- **Company promo refund:** reverse amount_cents для master + reverse discount_cents marketing для company
- **Early finalize (company promo):** master keeps amount_cents (full price) minus commission on paid_cents; company marketing entry is NOT reversed (company absorbed the cost)
- **first_purchase_only:** проверяет Purchase.status IN ('pending', 'completed') -- не только completed, чтобы предотвратить race condition при конкурентных бронированиях
- **Backward compatibility:** promo_code optional в CreateBookingRequest и PurchaseRequest. Существующие клиенты работают без изменений
- **Soft delete:** is_active=False вместо DELETE. Existing purchases сохраняют promo_id FK
- **Code normalization:** все коды uppercased при создании и валидации

**Закрытые баги:**
- BUG-16 (HIGH): промо молча игнорировался при несуществующей practice -- добавлен explicit raise NotFoundError
- BUG-17 (MEDIUM): first_purchase_only проверял только COMPLETED, не PENDING -- исправлено на IN ('pending', 'completed')
- BUG-18 (MEDIUM): status_filter в bookings без Literal -- добавлен Literal constraint

**telegram_id ranges:** 81000-81099

**Аудит:** 5 багов найдены и закрыты (3 реальных + 2 LOW tech debt acknowledged).

**Критерий готовности:** Промокоды работают при покупке. 293 теста (3 skipped), 0 warnings. ✅

---

### 6.8: Data Consistency Semaphores ✅ — [REMOVED 2026-07-07, `9ca5619`]

**Built here (Phase 6.8), then deleted whole in `9ca5619`** ("chore(admin): remove
data-integrity semaphores feature entirely (A3)", operator call). Deleted: this package
(`backend/app/modules/admin/consistency/`), `AdminConsistencyView.vue`,
`test_admin_consistency.py`, `backend/scripts/repair_semaphore_2x.py`, and
`VELO-Data-Consistency-Semaphores.md` (the "Полная документация" this section points to
below no longer exists). `GET /api/v1/admin/consistency` is gone; nothing in the current
codebase runs these checks. **Everything below this line is a historical record of what
was built and later removed — not a description of current behavior.**

**Цель (as built):** Автоматические проверки консистентности данных — 21 семафор по 5 категориям.

**Задачи:**
- [x] GET /api/v1/admin/consistency — запуск всех семафоров
- [x] Категория 1: COUNT=COUNT (4 семафора)
- [x] Категория 2: SUM=0 (2 семафора)
- [x] Категория 3: Computed=Actual (5 семафоров)
- [x] Категория 4: Orphan Detection (4 семафора)
- [x] Категория 5: Business Invariants (6 семафоров)
- [x] structlog алерты при расхождении
- [x] tests/test_admin_consistency.py — 7 тестов (telegram_id range 82xxx)

**Endpoint:**
```
GET /api/v1/admin/consistency  -- admin-only, read-only (get_db_reader)
```

**21 семафор:**

| # | Имя | Категория | Criticality | Описание |
|---|-----|-----------|-------------|----------|
| 1.1 | active_bookings_eq_active_purchases | count_count | critical | Активные bookings == активные purchases |
| 1.2 | cancelled_bookings_eq_cancelled_purchases | count_count | critical | Cancelled bookings == refunded/cancelled purchases |
| 1.3 | master_users_eq_verified_profiles | count_count | warning | Users(role=master) == MasterProfile(status=verified) |
| 1.4 | bookings_all_have_purchase | count_count | critical | Нет bookings без purchase_id |
| 2.1 | global_double_entry_sum_zero | sum_zero | critical | SUM(user+master+company ledger) == 0 |
| 2.2 | purchase_paid_eq_user_debits | sum_zero | critical | SUM(paid_cents) == ABS(user_ledger purchase debits) |
| 3.1 | user_balance_eq_ledger_sum | computed_actual | critical | User.balance_cents == SUM(user_ledger) |
| 3.2 | master_frozen_eq_ledger_sum | computed_actual | critical | MasterProfile.frozen_cents == SUM(frozen master_ledger) |
| 3.3 | master_available_eq_ledger_sum | computed_actual | critical | MasterProfile.available_cents == SUM(available master_ledger) |
| 3.4 | practice_participants_eq_booking_count | computed_actual | warning | Practice.current_participants == COUNT(confirmed/attended bookings) |
| 3.5 | promo_used_count_eq_purchase_count | computed_actual | warning | Promo.used_count == COUNT(non-cancelled purchases) |
| 4.1 | bookings_orphan_practice | orphan_detection | critical | Bookings без practice |
| 4.2 | bookings_orphan_user | orphan_detection | critical | Bookings без user |
| 4.3 | purchases_orphan_user | orphan_detection | critical | Purchases без user |
| 4.4 | master_ledger_orphan_user | orphan_detection | critical | Master ledger без user |
| 5.1 | no_frozen_for_completed_practices | business_invariants | critical | Нет frozen entries для completed practices |
| 5.2 | no_negative_master_available | business_invariants | critical | Нет мастеров с available_cents < 0 |
| 5.3 | no_negative_user_balance | business_invariants | critical | Нет юзеров с balance_cents < 0 |
| 5.4 | attended_must_have_joined_at | business_invariants | warning | Attended bookings имеют joined_at |
| 5.5 | no_over_max_participants | business_invariants | warning | current_participants <= max_participants |
| 5.6 | completed_purchases_have_audit | business_invariants | warning | Completed purchases имеют audit entry |

**Пропущенные семафоры (Phase 7):**
- 4.5: notification_deliveries orphans — таблица не существует до Phase 7.1

**Результат:**
```
backend/app/modules/admin/consistency/
├── __init__.py
├── schemas.py         ← SemaphoreResult, ConsistencyResponse
├── service.py         ← 5 category functions + run_all_semaphores()
└── router.py          ← GET /consistency

backend/app/modules/admin/router.py  ← PATCHED: +consistency_router

backend/tests/
└── test_admin_consistency.py  ← 7 тестов (telegram_id range 82xxx)
```

**Решения, принятые при реализации:**
- **Чистый ORM** -- все 21 запрос через SQLAlchemy ORM, ни строки raw SQL. Subquery + JOIN для computed vs actual
- **Stale nonzero pattern** -- семафоры 3.1-3.5 проверяют два кейса: (a) mismatch через INNER JOIN, (b) stale nonzero через NOT IN subquery (для записей без леджер-строк вообще)
- **Семафор 2.2** -- сравнивает SUM(Purchase.paid_cents) для PENDING+COMPLETED+REFUNDED с ABS(user_ledger debits с reason LIKE 'purchase:%'). REFUNDED включены — их дебет остаётся в леджере, уравновешен кредитом refund
- **Read-only** -- get_db_reader, никаких мутаций. Безопасно запускать в production без риска
- **Alerting** -- structlog.warning() для каждого ALERT. Telegram-алерты отложены до Phase 7
- **Response model** -- ConsistencyResponse: items (list[SemaphoreResult]), total, ok_count, alert_count, run_at

**Закрытые баги:**
- BUG-21 (HIGH): Семафор 2.2 давал ложный ALERT при рефандах — REFUNDED purchases не учитывались в total_paid
- BUG-22 (MEDIUM): Семафоры 3.1-3.3 пропускали stale nonzero балансы без леджер-записей — добавлен stale_nonzero pattern
- BUG-23 (LOW): Неиспользуемые импорты (UUID, and_, case) в service.py — удалены

**telegram_id ranges:** 82000-82999

**Аудит:** 3 бага найдены и закрыты. P-01 (no commit), P-10 (structlog), P-11 (Literal types) пройдены.

**Критерий готовности (at the time):** Семафоры запускаются и показывают OK/ALERT. 300 тестов (3 skipped), 0 warnings. ✅ **Moot since 2026-07-07 — feature removed, no longer applicable.**

---

**Полная документация:** ~~`VELO-Data-Consistency-Semaphores.md`~~ **[deleted 2026-07-07, `9ca5619` — file no longer exists]**

---

## PHASE 7: Notifications

> **⚠ REPLACED `PROMPT №679`, 2026-08-12 — every `app/modules/notifications/` path below is DEAD.**
> The whole module (`models.py`/`processor.py`/`service.py`/`formatters.py`/`template_engine.py`/
> `reminders.py`) was cut out and its tables dropped (`backend/migrations/versions/2026_07_28_
> 9c0d1e2f3a4b_drop_notifications_tables.py`). It was replaced by an outbox architecture:
> `backend/app/core/events/` (emit/relay to an external comms microservice via a Redis Stream) +
> `backend/app/modules/comms_proxy/` (the in-app bell: `GET /notifications`, `/unread-count`,
> `/read-all`, `/{id}/read`) + `backend/app/modules/chats/` (real one-to-one messaging). Phases 7.1–7.4
> below are kept as a HISTORICAL record of what Phase 7 originally built and shipped for weeks — not
> a current file map. Do not go looking for these paths.

### 7.1: Модель Notification ✅

**Цель:** Хранение уведомлений.

> **Из Phase 6.8 (MOOT — Phase 6.8 removed 2026-07-07, `9ca5619`):** ~~После создания таблицы
> notification_deliveries добавить семафор 4.5 (orphan detection) в
> admin/consistency/service.py.~~ `admin/consistency/` no longer exists; there is nothing to
> add this semaphore to. ~~Также добавить Telegram-алерты при ALERT (сейчас только
> structlog).~~ Also moot for the same reason.

**Задачи:**
- [x] app/modules/notifications/models.py
- [x] Notification + NotificationDelivery (двухуровневая архитектура)
- [x] Миграция

**Решения, принятые при реализации:**
- UUID PK вместо autoincrement (консистентность с остальным проектом)
- Двухуровневая архитектура: Notification (что отправить) → NotificationDelivery (кому, каким каналом)
- Target routing: target_type + target_value → user:<uuid>, practice:<uuid>, role:master, all
- action_data JSONB для deep linking (channel-agnostic navigation intent)
- NotificationType — StrEnum с 21 типами (reminders, master_reminders, booking, practice, waitlist, master, payments, feedback, system)
- Priority: 1=urgent, 5=low (default 5)

**Критерий готовности:** Миграция применена. ✅

---

### 7.2: NotificationProcessor ✅

**Цель:** Фоновый воркер для отправки.

**Задачи:**
- [x] app/modules/notifications/processor.py — трёхстадийный pipeline
- [x] app/modules/notifications/service.py — create_notification(), resolve_notification()
- [x] app/modules/notifications/formatters.py — ChannelFormatter Protocol + StubFormatter
- [x] Polling pending notifications (exponential backoff)
- [x] Retry logic (3 попытки, configurable)
- [x] Target resolution (user, practice, role, all)
- [x] Stage 1: Resolution → Stage 2: Delivery → Stage 3: Rollup
- [x] 21 тест (test_notifications.py, telegram_id range 83000-83999)

**Решения, принятые при реализации:**
- Background asyncio.Task в FastAPI lifespan (не отдельный сервис)
- get_session_factory() для сессий вне request context (как webhook_router)
- Exponential backoff: 5s → 10s → 20s → ... → 60s (configurable)
- StubFormatter для всех каналов до Phase 7.3
- ChannelFormatter Protocol — типобезопасный интерфейс без наследования

**Критерий готовности:** Уведомления отправляются автоматически. ✅

---

### 7.3: TelegramFormatter + Templates ✅

**Цель:** Реальная отправка уведомлений через Telegram Bot API + мультиязычные шаблоны.

**Задачи:**
- [x] app/modules/notifications/template_engine.py — SafeDict, YAML loading, render с language fallback
- [x] app/modules/notifications/templates/{en,de,es,ru}.yaml — 18 шаблонов × 4 языка
- [x] app/modules/notifications/formatters.py — TelegramFormatter (aiogram 3.x, send-only)
- [x] Lazy initialization: real token → TelegramFormatter, fake token → StubFormatter
- [x] Template rendering в processor._stage_deliver() перед send()
- [x] Permanent failure handling (bot blocked → immediate failed, no retries)
- [x] User.language нормализация при upsert (language_code "en-US" → "en")
- [x] Admin endpoint: POST /api/v1/admin/templates/reload
- [x] load_templates() в lifespan
- [x] pyproject.toml: +aiogram>=3.13.0, +pyyaml>=6.0.0
- [x] config.py: +telegram_bot_url
- [x] scripts/test_telegram_send.py — ручной тест с 5 реальными аккаунтами
- [x] 34 теста (13 новых Phase 7.3 + 21 existing)

**Решения, принятые при реализации:**
- aiogram Bot без Dispatcher — send-only, нет конфликта event loop с uvicorn
- SafeDict для format_map — отсутствующие переменные не ломают рендеринг
- YAML шаблоны с HTML-тегами (Telegram HTML parse_mode)
- Language fallback: lang → "en" (если нет шаблона для языка)
- Template fallback: если нет шаблона для notification.type → используем DB title/body
- Deep link формат: https://t.me/velo_testbot?startapp={action}__{param}
- Permanent errors (frozenset): "bot was blocked", "user is deactivated", "chat not found" и др.
- language обновляется при повторном логине (on_conflict_do_update)

**Структура файлов Phase 7.3:**
```
backend/app/modules/notifications/
├── template_engine.py          ← SafeDict, load/render, cache
├── templates/
│   ├── en.yaml                 ← English (18 templates)
│   ├── de.yaml                 ← German
│   ├── es.yaml                 ← Spanish
│   └── ru.yaml                 ← Russian
├── formatters.py               ← StubFormatter + TelegramFormatter + registry
├── processor.py                ← Updated: template render + permanent failures
├── models.py                   ← Unchanged
└── service.py                  ← Unchanged
```

**Критерий готовности:** Бот отправляет уведомления в Telegram. 336 passed, 3 skipped. ✅

---

### 7.4: Напоминания ✅

**Цель:** Авто-напоминания о практиках.

**Задачи:**
- [x] app/modules/notifications/reminders.py — 5 публичных функций
- [x] Пользовательские напоминания: 24ч, 1ч, 10мин до практики (при создании booking)
- [x] Мастерские напоминания: 24ч, 1ч, 10мин до практики (при draft → scheduled)
- [x] Отмена напоминаний при cancel_booking (только юзерские)
- [x] Отмена всех напоминаний при cancel_practice (юзерские + мастерские)
- [x] Перепланирование всех напоминаний при изменении scheduled_at
- [x] Интеграция с waitlist (confirm_waitlist → schedule_reminders)
- [x] models.py: +3 enum (MASTER_REMINDER_24H/1H/10MIN)
- [x] templates/{en,de,es,ru}.yaml: +3 master_reminder шаблона × 4 языка (всего 80 шаблонов)
- [x] 17 тестов (test_reminders.py, telegram_id range 84000-84999)

**Решения, принятые при реализации:**
- Без APScheduler/Celery — используется существующий NotificationProcessor (Phase 7.2). Напоминания создаются как Notification с future scheduled_at, процессор подхватывает их при наступлении времени
- 5-минутный буфер (_MIN_LEAD_TIME): не создаём напоминания, если до практики меньше 5 минут
- Раздельные типы для юзера (REMINDER_*) и мастера (MASTER_REMINDER_*) — разные шаблоны, чистая отмена
- action_data["practice_id"] как ключ фильтрации (JSONB astext query)
- expiry_at = practice.scheduled_at — процессор не отправит напоминание после начала практики
- Lazy imports в точках интеграции (bookings/service.py, practices/service.py, waitlist/service.py) — избегаем циклических зависимостей
- Master display_name: `get_master_display_name()` в masters/service.py (NEW-01: extracted из reminders.py, единый источник)
- Priority: 2 (выше дефолтных 5, ниже urgent 1)
- reschedule_reminders_for_practice: batch-load users через `WHERE id IN (...)` вместо N+1 `session.get()` (NEW-06)

**Структура файлов Phase 7.4:**
```
backend/app/modules/notifications/
├── reminders.py             ← NEW: schedule/cancel/reschedule (5 functions)
├── models.py                ← PATCHED: +3 MASTER_REMINDER enum values
├── templates/
│   ├── en.yaml              ← PATCHED: +3 master_reminder templates (20 total)
│   ├── de.yaml              ← PATCHED: +3 master_reminder templates
│   ├── es.yaml              ← PATCHED: +3 master_reminder templates
│   └── ru.yaml              ← PATCHED: +3 master_reminder templates

backend/app/modules/
├── bookings/service.py      ← PATCHED: +schedule_reminders, +cancel_reminders
├── practices/service.py     ← PATCHED: +schedule_master, +reschedule, +cancel_all
├── waitlist/service.py      ← PATCHED: +schedule_reminders

backend/tests/
└── test_reminders.py        ← NEW: 17 tests (84000-84999)
```

**Закрытые баги:**
- BUG-31 (LOW): Неиспользуемые импорты auth_headers, login_user в test_reminders.py — удалены

**Закрытый документационный долг:**
- TODO в models.py header: "Update TS Phase 7.1 to reflect UUID decision" — убран, комментарий обновлён

**telegram_id ranges:** 84000-84999

**Критерий готовности:** Напоминания приходят автоматически. 80 шаблонов загружены на проде. ✅

---

## PHASE 8: Diary/State

### 8.1: Check-ins ✅

**Цель:** Состояние до практики.

**Задачи:**
- [x] app/modules/diary/models.py — Checkin, Mood enum, CheckType enum
- [x] app/modules/diary/schemas.py — CheckinRequest, CheckinResponse, PaginatedCheckinsResponse
- [x] app/modules/diary/service.py — upsert_checkin, list_user_checkins, _validate_checkin_window
- [x] app/modules/diary/router.py — practices_checkin_router, checkins_router
- [x] POST /api/v1/practices/{id}/checkin (upsert semantics)
- [x] GET /api/v1/users/me/checkins (paginated, filters: practice_id, date_from, date_to)
- [x] Миграция: a8b1c2d3e4f5 (create checkins table)
- [x] 13 тестов (test_checkins.py, telegram_id range 85000-85999)

**Решения, принятые при реализации:**
- Insert-once: один чекин на booking, **неизменяемо** — повторный POST отклоняется `409 Conflict`, перезаписи нет (гонка закрыта P-05). Ранее повторный POST перезаписывал mood/comment — это уничтожало исходную точку данных, устранено (см. Бэковый Кодекс v1.8)
- Окно: scheduled_at - checkin_window_hours (24ч) .. scheduled_at (3ч -> 24ч, запрос заказчика 2026-06-03)
- Условие: booking.status == confirmed (только подтверждённые)
- CheckType enum (PRE/POST) — розетка для будущего post-check-in (Phase 9+)
- UniqueConstraint(booking_id, check_type) — один PRE и один POST на booking
- Все FK indexed (practice_id, user_id, booking_id)
- comment: max 1000 chars, nullable, min_length=1 (пустая строка запрещена)

**Критерий готовности:** Юзер может отправить check-in. 368 passed, 3 skipped. ✅

---

### 8.2: Feedbacks ✅

**Цель:** Обратная связь после практики.

**Задачи:**
- [x] Модель Feedback + Rating enum
- [x] FeedbackRequest, FeedbackResponse, PaginatedFeedbacksResponse
- [x] upsert_feedback, list_user_feedbacks, _validate_feedback_window
- [x] practices_feedback_router, feedbacks_router
- [x] POST /api/v1/practices/{id}/feedback (upsert semantics)
- [x] GET /api/v1/users/me/feedbacks (paginated, filters: practice_id, rating, date_from, date_to)
- [x] Миграция: b9c2d3e4f5a6 (create feedbacks table)
- [x] 15 тестов (test_feedbacks.py, telegram_id range 86000-86999)

**Решения, принятые при реализации:**
- Insert-once: один feedback на (practice, user), **неизменяемо** — повторный POST отклоняется `409 Conflict`, перезаписи нет (гонка закрыта P-05). Ранее повторный POST перезаписывал rating/comment — устранено (см. Бэковый Кодекс v1.8)
- Окно: scheduled_at + duration_minutes .. + feedback_window_hours (72ч)
- Условие: booking.status == attended (только реально пришедшие, не confirmed/no_show/cancelled)
- practice.status == completed (обязательно)
- Rating enum: fire, good, confused (StrEnum)
- UniqueConstraint(practice_id, user_id)
- comment: max 1000 chars, nullable, min_length=1

**Критерий готовности:** Юзер может оставить feedback. 383 passed, 3 skipped. ✅

---

### 8.3: Diary entries ✅

**Цель:** Личные записи дневника.

**Задачи:**
- [x] Модель DiaryEntry
- [x] CreateDiaryEntryRequest, UpdateDiaryEntryRequest (clear_* sentinels), DiaryEntryResponse
- [x] create_diary_entry, get_diary_entry, update_diary_entry, delete_diary_entry, list_user_diary_entries
- [x] diary_router: POST, GET list, GET /{id}, PATCH /{id}, DELETE /{id}
- [x] _validate_practice_link (practice exists + user has non-cancelled booking)
- [x] Миграция: c0d1e2f3a4b5 (create diary_entries table + CheckConstraints на checkins/feedbacks)
- [x] 19 тестов (test_diary_entries.py, telegram_id range 87000-87999)

**Решения, принятые при реализации:**
- CRUD: POST /api/v1/diary, GET /api/v1/diary, GET /api/v1/diary/{id}, PATCH /api/v1/diary/{id}, DELETE /api/v1/diary/{id}
- Hard delete — личные данные, без soft delete
- practice_id: nullable FK с ondelete="SET NULL" (запись переживёт удаление практики)
- Если practice_id указан — валидируем: practice exists + user has non-cancelled booking
- title: max 200 chars, nullable
- content: max 10000 chars, required, min_length=1
- mood: nullable, тот же Mood enum (low/mid/high)
- clear_* sentinel-флаги в PATCH: clear_mood, clear_title, clear_practice — для обнуления nullable полей
- P-08: 404 вместо 403 при чужой записи

**Закрытые аудит-находки (применены в 8.3):**
- CRITICAL-6: Убран лишний flush() + refresh() только при `not is_new` в router
- WARNING-9: CheckConstraint на mood/rating на уровне БД (ck_checkin_mood, ck_feedback_rating, ck_diary_entry_mood)
- SUGGESTION-6: ConfigDict(from_attributes=True) вместо dict-style model_config

**Критерий готовности:** Юзер может вести дневник. 402 passed, 3 skipped. ✅

---

### 8.4: Агрегация для мастера ✅

**Цель:** Мастер видит сводку по практике.

**Задачи:**
- [x] GET /api/v1/practices/{id}/insights
- [x] MoodDistribution, RatingDistribution, PracticeInsightsResponse
- [x] get_practice_insights — 5 запросов (practice, participants, mood GROUP BY, rating GROUP BY, comments count)
- [x] practices_insights_router (read-only, get_db_reader)
- [x] 9 тестов (test_insights.py, telegram_id range 88000-88999)

**Решения, принятые при реализации:**
- Доступ: только мастер-владелец практики (practice.master_id == user.id)
- Практика должна быть completed (400 если не completed)
- participants = COUNT(bookings WHERE status == attended), не все записавшиеся
- comments_count = только feedback comments (не checkin)
- Анонимность: никаких user_id, booking_id, текстов комментариев — только числа
- Тест test_insights_no_user_data_exposed проверяет отсутствие утечек
- Без миграции — read-only агрегация по существующим таблицам

**Endpoint:**
```
GET /api/v1/practices/{id}/insights
Response: {
  "practice_id": "uuid",
  "participants": 15,
  "checkins": {"high": 8, "mid": 5, "low": 2},
  "feedbacks": {"fire": 10, "good": 4, "confused": 1},
  "comments_count": 7
}
```

**Закрытые аудит-находки (пост-8.4 патч):**
- WARNING: isnot() → is_not() (deprecated SQLAlchemy method)
- SUGGESTION: comment min_length=1 в CheckinRequest/FeedbackRequest (пустая строка ломала insights count)

**Структура файлов Phase 8:**
```
backend/app/modules/diary/
├── __init__.py
├── models.py          ← Checkin, Feedback, DiaryEntry + Mood, Rating, CheckType enums
├── schemas.py         ← 13 schema classes (request/response/paginated/insights)
├── service.py         ← 10 public functions + 3 validators
└── router.py          ← 6 routers, 10 endpoints

backend/migrations/versions/
├── a8b1c2d3e4f5_create_checkins_table.py       ← Phase 8.1
├── b9c2d3e4f5a6_create_feedbacks_table.py      ← Phase 8.2
└── c0d1e2f3a4b5_create_diary_entries_table.py  ← Phase 8.3 + CheckConstraints

backend/tests/
├── test_checkins.py        ← 13 tests (85000-85999)
├── test_feedbacks.py       ← 15 tests (86000-86999)
├── test_diary_entries.py   ← 19 tests (87000-87999)
└── test_insights.py        ← 9 tests  (88000-88999)
```

**telegram_id ranges:** 85000-85999 (checkins), 86000-86999 (feedbacks), 87000-87999 (diary entries), 88000-88999 (insights)

**Известный техдолг:**
- `_make_verified_master()` дублируется в 15+ тестовых файлах → вынести в tests/helpers.py
- Audit log при diary_entry_updated не фиксирует changed_fields → улучшить data dict

**Критерий готовности:** Мастер видит аналитику по практике. ✅

---

### 8.5: Diary redesign — журнал событий + единая лента ✅

**Цель:** Заменить разрозненные списки (checkins / feedbacks / entries) единой
лентой активности дневника поверх неизменных источников.

**Задачи:**
- [x] app/modules/diary/models.py — `DiaryEvent` (append-only журнал), `DiaryEventKind` (9 видов)
- [x] app/modules/diary/projections.py — единственный писатель журнала (`project_*` / `upsert_*_event`), вызывается из сервисов источников в той же транзакции
- [x] app/modules/diary/schemas.py — `DiaryFeedItem`, `DiaryFeedResponse` (cursor)
- [x] app/modules/diary/service.py — `list_diary_feed` (cursor pagination, newest-first)
- [x] GET /api/v1/diary/feed (cursor: `{ items, next_cursor }`, `next_cursor === null` = конец)
- [x] Миграция: c4d5e6f7a8b9 (create diary_events table)
- [x] 459 passed, 3 skipped

**9 видов событий (`DiaryEventKind`):** booking_confirmed,
booking_cancelled_by_user, practice_rescheduled, practice_cancelled_by_master,
practice_outcome, checkin, feedback, note, dream.

**Snapshot-контракт** (денормализованный слепок в каждом событии — лента
самодостаточна, без JOIN при чтении):
- базовый `_practice_snapshot`: practice_id, practice_title, master_id,
  master_name, scheduled_at, duration_minutes, direction (аватар/verified НЕ
  входят — TD-DIARY-PRACTICE-AVATAR);
- practice_outcome += outcome_status (attended/no_show);
- practice_rescheduled += old_scheduled_at, new_scheduled_at;
- checkin += mood, comment_preview;
- feedback += rating, comment_preview;
- note/dream (entry): entry_type, title, content_preview, mood, practice_id,
  practice_phase.

**Ключевые решения:**
- Источники (Booking/Practice/Checkin/Feedback/DiaryEntry) НЕ меняются —
  журнал тонкий слой поверх. Старые эндпоинты списков сохранены (legacy).
- **Инвариант:** журнал пишется ТОЛЬКО через проекции в момент мутации
  источника; backfill отсутствует by design (см. Бэковый Кодекс §3.10). Seed
  обязан вызывать проекции, иначе лента пуста при наполненных источниках.

**Открытый техдолг:** TD-DIARY-FEED-CURSOR-TIEBREAK (тай-брейк курсора при
равных occurred_at), TD-DIARY-SNAPSHOT-TYPED (типизировать snapshot),
TD-DIARY-CANCEL-COMMENT (причина отмены в snapshot), TD-ASK-MASTER (диалог
юзер↔мастер — отдельная фича/сущность, не строка на брони; вне MVP; чек-ин
клиента мастеру уже отдаётся через attendance, Бэковый Кодекс §3.12).

**Критерий готовности:** Единая лента отдаётся с курсорной пагинацией; события
проецируются при мутации источников. ✅

---

## PHASE 9: Полировка + розетки

### 9.1: AI-саммари розетка

**Цель:** Интерфейс для будущего AI-сервиса.

**Задачи:**
- [ ] app/modules/ai/interface.py — Protocol
- [ ] app/modules/ai/mock.py — Mock implementation
- [ ] GET /api/v1/practices/{id}/ai-summary (mock)

**Критерий готовности:** Розетка готова, mock возвращает placeholder.

---

### 9.2: Library розетка

**Цель:** TODO структура для записей.

**Задачи:**
- [ ] Модель Recording (закомментирована)
- [ ] TODO в коде
- [ ] Документация: что нужно для реализации

**Критерий готовности:** Структура задокументирована.

---

### 9.3: Финальное тестирование

**Цель:** Всё работает вместе.

**Задачи:**
- [ ] E2E тесты основных flow
- [ ] Load testing
- [ ] Security audit
- [ ] Документация API (OpenAPI)

**Основные flow для тестирования:**
1. Регистрация → вход → профиль
2. Создание практики мастером
3. Бронирование юзером
4. Оплата
5. Check-in → практика → feedback
6. Вывод средств мастером

**Критерий готовности:** Все flow работают, тесты проходят.

---

## PHASE FB: Frontend-Backlog эпики + внешнее код-ревью (июнь 2026) ✅

Пост-Phase-9 итерация: фронт построен «целиком по дизайну, бэкенд-заглушки», и этот
блок закрывает P0-заглушки бэкенда + проходит внешнее код-ревью ветки `test`.
Всё LIVE на `test` (564 passed, 12 skipped). Детали контрактов — **Бэковый Кодекс
§2 и §9 (итерация июнь 2026)**.

### Доставленные эпики (P0)

- [x] **E1** — именованные отзывы практики `GET /api/v1/practices/{id}/reviews`
  (+ фильтр `attention`, master-only, P-08).
- [x] **E2** — доход/лента мастера `GET /api/v1/masters/me/income?period` +
  `GET /api/v1/masters/me/transactions`. Миграция `9f1e2d3c4b5a` (`title` +
  `counterparty_id` в `master_ledger`). `income` = валовой забронированный оборот
  за период; `delta_pct` только при `prev_income > 0`.
- [x] **E5** — students CRM `GET /api/v1/masters/me/students` (+`/{id}`).
- [x] **E9** — admin-оверсайт: `GET /admin/metrics/check-in|feedback|return`,
  `GET /admin/revenue`, `GET /admin/practices` (+`/{id}` + roster) + seed-выводы
  (4d) для населения payout. Тот же ledger-слой, что E2.
- [x] **#3** — cross-practice лента отзывов мастера `GET /api/v1/masters/me/reviews?attention=`
  (новое поле `practice_title`; рефайнит E1).

### Внешнее код-ревью ветки `test` (0 critical, 7/10) — закрыто

- [x] **W-1** — явка засчитывается и по PRE-чек-ину (не только Zoom-join) в общем
  ядре `_finalize_practice_core` (оба пути). Разблокировало feedback/E1 при
  выключенном Zoom.
- [x] **W-3** — feedback-метрика ≤100% (числитель привязан к тем же attended-броням).
- [x] **W-2** — докстринги income переписаны под реальную семантику (числа не тронуты).
- [x] **W-4** — громкий security-WARNING при `role_switch_enabled=True` (env-гейт
  невозможен: `app_env` бинарный, TEST сам prod-grade).
- [x] **S-1** — `delta_pct` только при `prev_income > 0`. **S-3** — фоллбэк имени
  мастера в admin revenue → «Мастер».
- W-5/W-6/W-7 и часть S — фронтовые/унаследованы из main (не бэкенд-скоуп).

### Авто-финализация — актуализация

«Auto-complete по длительности» **уже работает** в проде: воркер
`bookings/autofinalize.py` закрывает практики по `scheduled_at + duration + buffer`
(15 мин), а не по 24ч-потолку. Фронт убрал ручную кнопку «Завершить»; бэкенд
финализирует и освобождает frozen сам. Финансовый тайминг (разморозка/комиссия ~в
конце практики) — согласовать перед прод-нагрузкой. Детали — Бэковый Кодекс §9.

---

## 3. Реестр технического долга

Замечания, выявленные при код-ревью. Сгруппированы по моменту, когда их следует закрывать.

### Обозначения

- **Среда:** 🧪 Тест (не влияет на тестовый сервер) / 🚀 Прод (обязательно до продакшена)
- **Статус:** ⬜ Open / ✅ Done

### Закрыто в Phase 0.5

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| TD-001 | `config.py` | `SECRET_KEY` с дефолтом | model_validator: обязателен при `APP_ENV!=development` | ✅ |
| TD-002 | `main.py` | `CORS *` + `allow_credentials=True` | `allow_credentials=not _allow_all` | ✅ |
| TD-003 | `main.py` | Health 200 при деградации | Добавлен `GET /ready` (503) | ✅ |
| TD-004 | `docker-compose.yml` | Postgres/Redis на `0.0.0.0` | Убраны published ports; app на `127.0.0.1` | ✅ |
| TD-005 | `Dockerfile` | Образ от `root` | `USER velo` (UID 1000) | ✅ |
| TD-006 | `config.py` | `database_url` с кредами в дефолте | model_validator: обязателен при `APP_ENV!=development` | ✅ |
| TD-007 | `main.py` | `VeloError` handler не зарегистрирован | `@app.exception_handler(VeloError)` + logging | ✅ |
| TD-008 | `database.py` | `get_db_session()` COMMIT на read-only | Добавлен `get_db_reader()` (rollback) | ✅ |
| TD-009 | `main.py` | Lifespan: init_redis() fail → engine leak | `try/finally` в lifespan | ✅ |

### Закрыто в Phase 0.6

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| TD-010 | `.pre-commit-config.yaml` | `ruff-format` дублирует `black` | Оба удалены: нет pre-commit, нет black. Ruff через `velo lint` | ✅ |
| TD-016 | Разные | Устаревшие комментарии (mypy в Makefile и т.д.) | Makefile удалён целиком. .python-version удалён | ✅ |
| TD-018 | `test_health.py` | Хрупкие патчи (mock engine.connect as async CM) | Патчит `get_engine()`, success-тесты на реальной БД | ✅ |
| TD-019 | `test_auth.py` | Требует запущенный PostgreSQL | Тесты запускаются внутри Docker — БД всегда доступна | ✅ |
| TD-020 | `test_auth.py` | Нет тестов для logout | Добавлены test_logout_success, test_logout_no_token, test_logout_invalid_token, test_logout_inactive_user | ✅ |

### Закрыто в Phase 1.4

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| TD-021 | `auth/service.py` | `_SESSION_TTL` вычисляется при импорте — тесты не могут переопределить | `_get_session_ttl()` вычисляет при каждом вызове | ✅ |

### Закрыто в Phase 2.3

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| TD-031 | `main.py` | CORS: `settings.cors_origins == ["*"]` сравнивает str с list | `_cors_origins = [o.strip() for o in settings.cors_origins.split(",")]` | ✅ |

### Pre-6: Logging hardening — закрыть перед Phase 6

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| TD-011 | 🧪🚀 | `logging.py` | structlog не фильтрует по log level — `LOG_LEVEL=WARNING` не работает | `make_filtering_bound_logger` с уровнем из config | ✅ |
| TD-012 | 🧪🚀 | `logging.py` | `setup_logging()` не идемпотентна — `cache_logger_on_first_use` может закешировать дефолт | Guard-флаг `_configured` | ✅ |

### Косметика — без дедлайна

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| TD-013 | 🧪 | `migrations/env.py` | Engine не dispose-ится если `connect()` упадёт | try/finally вокруг async with | ⬜ |
| TD-014 | 🧪 | Несколько файлов | Версия `0.1.0` захардкожена в 3 местах (main.py, pyproject.toml, ?) | Вынести в одно место, читать из config или `__version__` | ⬜ |
| TD-015 | 🧪 | `config.py` | `postgres_password` дефолт `"velo"` без проверки в проде | Добавить validator (аналогично SECRET_KEY). Сейчас .env генерируется скриптом — риск минимален | ⬜ |
| TD-017 | 🧪 | `alembic.ini` | Placeholder URL в sqlalchemy.url | Убрать или заменить на комментарий (URL берётся из config) | ⬜ |
| TD-022 | 🧪 | `auth/schemas.py` | `balance_cents` в AuthResponse — всегда 0 до реальных платежей, шум | Убрать из AuthResponse или оставить (фронт может показывать баланс) | ⬜ |
| TD-023 | 🧪 | `migrations/` | Downgrade не удаляет тип userrole (неактуально после перехода на String) | Проверить downgrade при следующей миграции | ⬜ |
| TD-024 | ✅ | `users/models.py` | `User` не наследовал `JSONBMixin` для `credentials` | ЗАКРЫТО (onboarding flow): `User` наследует `JSONBMixin`, мутация `set_jsonb("credentials")` в `update_user`. См. Бэковый Кодекс 3.7 |
| PERF-04 | 🚀 | `notifications/service.py` | `_resolve_target_users` для ALL и ROLE загружает все user IDs в память | При росте базы (10k+): batched processing / server-side cursor / stream_scalars | ⬜ |

### Phase 2.2 аудит — backlog

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| TD-025 | 🚀 | Все роутеры | Нет rate limiting на auth и masters endpoints | `slowapi` middleware или custom limiter (Redis-based) | ⬜ |
| TD-026 | 🚀 | `docker-compose.yml` | Redis без пароля — доступ без аутентификации | `requirepass` в Redis + `REDIS_PASSWORD` в .env + config.py | ⬜ |
| TD-027 | 🚀 | `main.py` / `config.py` | CORS `"*"` по умолчанию — в production нужен явный список origins | S-04: `ValueError` в `_apply_env_defaults_and_validate` если `cors_origins == "*"` в production | ✅ |
| TD-028 | 🧪 | `masters/schemas.py` | `documents: list[dict]` — содержимое dict'ов не ограничено | Типизировать при реализации S3/file upload | ⬜ |
| TD-029 | 🧪 | `users/router.py` | 2 DB-сессии на `PATCH /users/me` (reader + writer) | Одна write-сессия или передача user_id вместо объекта | ⬜ |
| TD-030 | 🧪 | `main.py` | Health checks не различают timeout vs connection error | Разные статусы/сообщения для timeout и connection refused | ⬜ |
| TD-032 | 🧪 | `tests/test_*.py` | Cleanup fixtures используют `text()` raw SQL вместо ORM | Переписать на ORM (select/delete/update через модели) | ⬜ |
| TD-033 | 🚀 | `users/models.py`, `masters/models.py` | `balance_user`, `frozen_amount`, `available_amount` в `Numeric(18,2)` (доллары), а `price_cents` в int (центы) | Унифицировано: все суммы в центы (int), миграция `c2d3e4f5a6b7` | ✅ |
| TD-034 | 🧪 | `practices/models.py` | `current_participants` колонка не используется -- capacity считается через COUNT bookings | `recalculate_participants()` в bookings/service.py обновляет кэш после каждого изменения статуса booking/waitlist/refund. Capacity checks по-прежнему через COUNT | ✅ |

### Full Audit 2026-05-20 — backlog (AUDIT-0520-*)

Полный аудит ветки main (оценка 7/10). Отчёт:
`docs/01_refer/ARCHIVES/CODE-AUDIT/PROBKIT-REVIEW/2026-05-20-full-audit.md`.
Находки зарегистрированы, НЕ исправлены в спринте онбординга. Дубликаты с существующим
техдолгом не заводились — вместо этого аннотированы существующие записи (см. ниже).

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| AUDIT-0520-01 🔴 | 🚀 | `payments/stripe.py` | `if stripe_amount is not None and ...` -> при `amount_total=None` проверка суммы пропускается, баланс кредитуется без верификации | `if stripe_amount is None or stripe_amount != payment.amount_cents:` -> mark FAILED | ⬜ |
| AUDIT-0520-02 🔴 | 🚀 | `practices/schemas.py` | `zoom_link` принимает любую строку (только max_length), вкл. `javascript:` -> XSS | `@field_validator("zoom_link")`: требовать `https://` (Create + Update) | ⬜ |
| AUDIT-0520-03 🟡 | 🚀 | `core/middleware.py` | `_extract_client_ip` доверяет первому `X-Forwarded-For` без trusted-proxy check -> подделка IP в audit log | Доверять XFF только от Nginx; trusted proxies в config | ⬜ |
| AUDIT-0520-04 | 🧪 | `core/database.py` | `get_db_reader` без `SET TRANSACTION READ ONLY` (TD-008 жил только в докстринге) | `SET TRANSACTION READ ONLY` в начале reader-сессии | ⬜ |
| AUDIT-0520-05 | 🧪 | `payments/refund.py` | `_get_master_frozen_amount` и `_is_company_promo` дважды грузят один Promo (identity-map смягчает, логика дублирована) | Загрузить Promo один раз, передавать в обе | ⬜ |
| AUDIT-0520-06 | 🧪 | `admin/withdrawals/service.py` | Устаревший count-паттерн (не subquery как B-05/B-09) | Унифицировать на subquery | ⬜ |
| AUDIT-0520-07 | 🧪 | `payments/purchase_router.py` | `Practice` загружается дважды при покупке с промо (FOR UPDATE защищает гонку -> перф-нюанс) | Переиспользовать объект | ⬜ |
| AUDIT-0520-08 | 🧪 | `payments/refund.py` | bulk `update(Waitlist).values(status=...)` не трогает `updated_at` | Добавить `updated_at=func.now()` в bulk values | ⬜ |
| AUDIT-0520-09 | 🧪 | `tests/` | Нет теста на Stripe `amount_total=None` (кейс -01) | Тест: webhook без amount_total -> FAILED, без кредита | ⬜ |
| AUDIT-0520-S | 🧪 | разное | SUGGESTION: rate limiting на топап/покупку (см. TD-025); унификация count (B-05/B-09); вынос recalculate_participants (TD-034); Stripe SDK v9; компонентные тесты фронта (см. Фронтовый Кодекс AUDIT-0520-FE) | По мере касания кода | ⬜ |

> **Не техдолг:** циклические импорты через lazy import, отмеченные аудитом, — осознанное
> решение проекта (Phase 5.3 waitlist, Phase 6.4 purchase: "lazy import для circular prevention").
> **Аннотации существующих записей:** TD-025 (rate limiting) расширяется на топап/покупку.

### Calendar iteration audit 2026-05-22 — backlog

Аудит итерации Календаря (оценка 7/10). Отчёт:
`docs/01_refer/ARCHIVES/CODE-AUDIT/PROBKIT-REVIEW/2026-05-22-calendar-iteration.md`.

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| CAL-C1 🔴 | — | `practices/router.py` | Роутер импортировал приватную `_user_flags_for_practices` сервиса — нарушение layer boundary | Публичная `get_practice_detail()` инкапсулирует флаги+сборку ответа; роутер тонкий | ✅ |
| CAL-W2 🟡 | — | `frontend/stores/calendar.ts` | Граница недели в локальном TZ, сервер фильтрует UTC -> у экстремальных TZ практики у полуночи могли выпасть | Буфер ±1 день на запрос; клиент группирует по `calendarDateInTz` | ✅ |
| CAL-W1 🔴 | 🚀 | `core/config.py` | Возможно затёрт startup-`model_validator` Stripe-ключей при правках config итерации | Сверить с дореитерационным, восстановить валидатор (= Бэковый Кодекс CAL-W1) | ⬜ |
| CAL-W3 | — | `frontend/EditPracticeView.vue` | Edit-форма молча проставляет `meditation/beginner` старым практикам без таксономии | **Won't fix:** БД сносится после каждого обновления кода, таких практик не существует; ветка недостижима. Пересмотреть при импорте практик извне / миграции без сноса | ❎ |
| CAL-TD-STYLE | 🧪 | `frontend/CalendarFilterModal.vue` | «Вид практики» (style) — свободный VInput вместо дропдауна (нет справочника стилей) | Дропдаун, когда появится каталог стилей | ⬜ |
| CAL-S1..S5 | 🧪 | разное | 5 SUGGESTION (см. отчёт) | По мере касания кода | ⬜ |

### Calendar flow 4-7 + публичный профиль мастера — итерация 2026-05-24

Завершён флоу Календаря (Figma node `541:1553`, кадры 4-7 + master profile) поверх
кадров 1-3. Преимущественно фронт + один бэк-эндпоинт + фикс флака тестов.

**Сделано:**
- **Бэк:** публичный профиль мастера `GET /api/v1/masters/{user_id}` (`MasterPublicResponse` —
  только публичные поля: имя, bio, методы, опыт, аватар, счётчики practices/reviews;
  без финансов/контактов; verified-only или 404) + `master_avatar_url` в деталях практики.
  Бэковый Кодекс §3.9. +11 тестов (446 passed total).
- **Бэк (фикс тестов):** root-cause флака доставки уведомлений — фоновый процессор гонялся
  с ручными `_stage_*` в тестах; введён флаг `notification_processor_enabled` (тесты его
  выключают). Бэковый Кодекс §5.2.
- **Фронт:** `MasterPublicView` (кадр 4 + профиль), `BookingConfirmedView` (кадр 5), feedback
  с векторными иконками (кадр 7); аватары на `VAvatar`; иконка hero по `direction`.
  Фронтовый Кодекс §3.6.
- **Отложено:** кадр 6 «вопрос мастеру» — сквозная фича с бэком (маршрутизация в Telegram-бот
  мастера, ответ юзеру). Все «вопросы мастеру» по приложению — заглушки. TD-ASK-MASTER.
  Решение по архитектуре (2026-06-02): это **диалог** юзер↔мастер = отдельная сущность +
  флоу, НЕ строка `master_request` на брони; вне MVP. Чек-ин клиента мастеру уже отдаётся
  через attendance (Бэковый Кодекс §3.12).

**Аудит итерации (2026-05-24):** 0 critical / 0 warning, 3 suggestion. Оценка 9/10.

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| FLOW-S1 | — | `frontend/PracticeDetailView.vue` | Лишний `fetchPractice` в `onPurchased` перед редиректом (вью размонтируется) | Убран; `BookingConfirmedView` грузит сам, detail перезагружается через `onMounted` (роуты без keep-alive) | ✅ |
| FLOW-S3 | — | `backend/masters/schemas.py` | Нет trailing newline (ruff W292); потерян при переносе файла в репо (в исходном файле был) | Добавлен `\n` в конце | ✅ |
| FLOW-S2 | 🧪 | `frontend/BookingConfirmedView.vue` | Статичный текст про Zoom независимо от типа практики | Won't fix сейчас (все практики через Zoom); нейтрализовать/условить при не-Zoom практиках — TD-ZOOM-TEXT | ⬜ |
| FLOW-FLAKE | — | `tests/test_notifications.py` + config/main/conftest | Флак доставки: фоновый процессор vs ручные `_stage_*` (FOR UPDATE SKIP LOCKED) | Флаг `notification_processor_enabled`, тесты выключают | ✅ |
| TD-ASK-MASTER | 🚀 | разное (фронт + будущий бэк) | Вопросы мастеру — сквозная фича, не реализована; точки входа — заглушки. Решение (2026-06-02): это диалог юзер↔мастер = отдельная сущность+флоу, НЕ строка на брони; вне MVP. Чек-ин клиента мастеру уже отдаётся через attendance (§3.12) | Бэк (маршрутизация в бота, треды вопрос/ответ) + подключение фронта | ⬜ |


### Code Review Feb 2026 — исправлено

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| R-01 | `practices/service.py` | update/delete_practice: ForbiddenError вместо NotFoundError | 404 not 403 (P-08), единообразно со всеми модулями | ✅ |
| R-04 | `practices/service.py`, `masters/router.py` | GET /masters/me/practices: голый list без total | PaginatedPracticesResponse с total/limit/offset | ✅ |
| I-04 | `practices/schemas.py` | UpdatePracticeRequest.status содержит `cancelled` и `draft` | Убраны — недостижимы через PATCH. Только `scheduled, live, completed, deleted` | ✅ |
| R-10 | `practices/models.py` | State machine комментарий не отражает Phase 6.5 | Обновлён: cancelled только через cancel_practice() | ✅ |
| L-02 | `core/database.py` | get_session_factory() создаёт новый async_sessionmaker на каждый запрос | Singleton-кэш, сброс в dispose_engine() | ✅ |
| L-04 | `admin/users/router.py`, `service.py` | status filter: str вместо Literal | `Literal["pending", "verified", "rejected"] | None` | ✅ |
| L-07 | `payments/purchase.py` | commission через float: `int(x * rate)` | `paid_cents * commission_percent // 100` (integer math) | ✅ |
| R-07 | `bookings/models.py`, `waitlist/models.py`, `practices/models.py` | Модели без `index=True` на FK-колонках (индексы были в миграциях) | Синхронизация моделей: `index=True` на practice_id, user_id, master_id | ✅ |

### Code Review #2 Feb 2026 — исправлено

15 фиксов в 3 батчах. Все тесты: 355 passed, 3 skipped.

**BATCH 1 — Production blockers (3 фикса):**

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| CRITICAL-05 | `payments/purchase.py` | `create_purchase_for_booking` без FOR UPDATE на practice — concurrent purchases не блокируются | `select(Practice).with_for_update()` перед чтением price_cents | ✅ |
| ERR-01 | `core/middleware.py` | `request.url.path` вместо `scope["path"]` — KeyError в ASGI scope | `scope["path"]` напрямую | ✅ |
| ERR-02 | `core/middleware.py` | AuditLog.trace_id = String(36), а uuid4().hex = 32 символа | `str(uuid4())` — 36 символов с дефисами | ✅ |

**BATCH 2 — High-priority (8 фиксов):**

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| ERR-03 | `auth/service.py` | `json.loads(session_data)` без try/except — corrupted Redis data → 500 | try/except JSONDecodeError + ValueError → delete key, return None | ✅ |
| RACE-06 | `masters/service.py` | Reapplication (rejected→pending) без FOR UPDATE — concurrent set_jsonb overwrites | `select(MasterProfile).with_for_update()` | ✅ |
| ERR-04 | `payments/refund.py` | `scalar_one()` без guard — если purchase/booking не найдена → NoResultFound 500 | `scalar_one_or_none()` + explicit NotFoundError | ✅ |
| CQ-05 | `practices/service.py` | Можно изменить цену практики при наличии active bookings — юзеры уже заплатили | Guard: `_has_active_bookings()` → BadRequestError если `is_free` или `price_cents` меняется | ✅ |
| CQ-02 | `core/config.py` | commission_percent без bounds check — отрицательная или >100% ломает integer math | Validator: `0 <= commission_percent <= 100` при startup | ✅ |
| SEC-01 | `core/middleware.py` | X-Trace-ID header принимается без валидации — injection vector | Regex `^[a-zA-Z0-9._-]+$`, длина ≤36; невалидные → uuid4 | ✅ |
| TEST-FIX | `tests/test_waitlist.py` | FK-ошибка в cleanup + assertion bugs (скрытые за FK-ошибкой) | Порядок cleanup; status 201; `data["waitlist_entry"]["status"] == "converted"` | ✅ |
| TEST-FIX | `tests/test_waitlist.py` | Stale practice от waitlist-тестов ломала practices-тесты | Cleanup теперь корректно удаляет все FK-зависимости | ✅ |

**BATCH 3 — Quick wins + refactoring (4 фикса):**

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| ERR-05 | `promos/service.py`, `admin/promos/service.py` | try/except IntegrityError ВНУТРИ begin_nested — savepoint не откатывается | try/except СНАРУЖИ begin_nested — `__aexit__` видит исключение, rollback savepoint корректен | ✅ |
| SEC-07 | `promos/validation.py` | 8 разных error messages в validate_promo — enumeration attack | Единое сообщение `"Invalid or expired promo code"`, конкретная причина в structlog | ✅ |
| CQ-06 | `core/config.py` | log_level default DEBUG — шумно в prod, может утечь sensitive data | Default INFO; validator: DEBUG запрещён в production | ✅ |
| NEW-01 | `masters/service.py`, `reminders.py`, `waitlist/service.py` | `_get_master_display_name` дублирована в 2 файлах | Extracted в `masters/service.py` как public `get_master_display_name()`, остальные импортируют | ✅ |

**Дополнительные улучшения (в рамках BATCH 2-3):**

| ID | Файл | Улучшение | Статус |
|----|------|-----------|--------|
| NEW-06 | `reminders.py` | `reschedule_reminders_for_practice`: N+1 `session.get(User)` в цикле → batch-load `WHERE id IN (...)` | ✅ |

**Закрытые false positives (не требуют исправления):**

| ID | Причина закрытия |
|----|-----------------|
| CRITICAL-06 | `scalar_one()` в `_get_active_booking_count` — всегда возвращает число (COUNT + COALESCE), NoResultFound невозможен |
| SEC-04 | `json.loads(body.initData)` в webhook_router — тело приходит из Stripe SDK, не от юзера; + уже внутри try/except |
| ERR-06 | `resolve_notification` scalar_one_or_none — уже реализовано корректно, False Positive |
| RACE-04 | `deactivate_promo` без FOR UPDATE — `session.get(..., with_for_update=True)` уже используется |

### F8 Admin Frontend — бэкенд-дополнения (март 2026)

В рамках F8 review (W-1, W-2) добавлены два отсутствующих GET-эндпоинта:

| ID | Эндпоинт | Добавлен в | Описание |
|----|----------|------------|----------|
| W-1 | GET /api/v1/admin/masters/{user_id} | admin/masters/router.py | Полная информация о заявке мастера по ID |
| W-2 | GET /api/v1/admin/reports/{id} | admin/reports/router.py | Полная информация о жалобе по ID |

Без этих эндпоинтов `AdminMasterReviewView` и `AdminReportDetailView` передавали данные через `router.state` (сериализованный объект из списка) — хрупко и не защищено от прямого перехода по URL. Оба эндпоинта добавлены в рамках F8 code review.

**Коммит:** f90288a

---

### Frontend Report Feb 2026 — backlog

| ID | Проблема | Тип | Приоритет | Статус |
|----|----------|-----|-----------|--------|
| A-01 | Нет GET /bookings/{id} (deep link из уведомлений) | Новый эндпоинт | P1 | ✅ bookings/router.py + service.py |
| A-02 | GET /reports/me возвращает list без total (нужна пагинация) | Исправление схемы | P2 | ✅ PaginatedUserReportsResponse |
| A-03 | current_participants в PracticeResponse всегда 0 (нужен computed COUNT) | Исправление логики | P1 | ✅ recalculate_participants() |
| B-03 | Нет cron для экспирации NOTIFIED waitlist записей (зависают навечно) | Инфра | P2 | ⬜ Осознанный tech debt (TD-W01) |
| B-04 | Нет POST /auth/logout-all (инвалидация всех сессий) | Новый эндпоинт | P3 | ✅ W-06: session index + delete_all_sessions |

### Frontend Backlog — реализованные эндпоинты (Feb 2026)

**Задачи:**
- [x] GET /api/v1/bookings/me — пагинированный список бронирований с PracticeSummary
- [x] GET /api/v1/bookings/{id} — детали бронирования с PracticeResponse (A-01)
- [x] GET /api/v1/waitlist/me — пагинированный список waitlist с PracticeSummary
- [x] GET /api/v1/masters/me — профиль мастера (status, display_name, bio, methods, balances)
- [x] GET /api/v1/purchases/me — пагинированный список покупок с PracticeSummary
- [x] GET /api/v1/reports/me — исправлен: PaginatedUserReportsResponse (A-02)
- [x] POST /api/v1/auth/logout-all — инвалидация всех сессий (B-04/W-06)
- [x] recalculate_participants() — listener для current_participants (A-03/TD-034)

**Новые схемы:**
- `PracticeSummary` (id, title, practice_type, status, scheduled_at, duration_minutes, timezone, master_id, master_name)
  <!-- timezone added in CR-01; status added 2026-05-21 to support live/scheduled badge in list-views without a detail GET. Both auto-resolved via model_validate(practice)+from_attributes in all 3 consumers. See Backend Codex 2. -->
- `BookingWithPracticeResponse`, `BookingDetailResponse`, `PaginatedBookingsResponse`
- `WaitlistWithPracticeResponse`, `PaginatedWaitlistResponse`
- `PurchaseWithPracticeResponse`, `PaginatedPurchasesResponse`
- `PaginatedUserReportsResponse`

**Решения, принятые при реализации:**
- `/me` эндпоинты определяются ПЕРЕД `/{id}` чтобы FastAPI не парсил "me" как UUID
- Ответы конструируются вручную (не model_validate) — Booking ORM не имеет `.practice` relationship
- `recalculate_participants()` вызывается из create_booking, cancel_booking, finalize_practice, confirm_waitlist, refund_all_bookings_for_practice — единственный корректный способ обновления кэша
- `_get_active_booking_count` и `_ACTIVE_BOOKING_STATUSES` определены только в bookings/service.py — waitlist/service.py импортирует оттуда (W-04 fix)

**Дополнено 2026-05-21 (флоу ДАШБОРД, экраны 10–18):**
- `PracticeSummary` получил поле `status: PracticeStatus`. Уточнение к решению выше: внешний
  ответ (`BookingWithPracticeResponse` и т.п.) собирается вручную, но вложенный
  `PracticeSummary` строится через `model_validate(practice)` из ORM `Practice` (у которого
  есть и `status`, и `timezone`) — поэтому новое поле подхватилось во всех 3 потребителях
  без правок роутеров и без миграции.
- Фронт реализовал пользовательский флоу дашборда (новые вью PracticeLive/AiSummary/
  MyBookings/BookingDetail, shared PracticeHeroCard/MasterCard/FormShell, метод платформы
  `openLink`). Детали — в Frontend-Спецификации §6 и Фронтовом Кодексе §3.4.
- Подтверждено: `POST /bookings/{id}/join|leave` — действие **владельца брони** (юзера),
  как и зафиксировано в Phase 5.4 выше; Бэковый Кодекс §2 приведён в соответствие.

### Security Audit Feb 2026 — результаты

| ID | Тип | Серьёзность | Описание | Статус |
|----|-----|-------------|----------|--------|
| S-04 | Безопасность | MEDIUM | CORS `*` не валидируется в production | ✅ config.py: ValueError если cors_origins=="*" в production |
| W-04 | Слабость | MEDIUM | Дублирование _get_active_booking_count в waitlist | ✅ Импорт из bookings.service |
| W-02 | Слабость | HIGH | purchase_id без index | ✅ index=True + миграция a7b8c9d0e1f2 |
| W-06 | Слабость | LOW | Нет logout-all | ✅ POST /auth/logout-all + session index |
| W-01 | Слабость | MEDIUM | Нет cron для waitlist expiration | ⬜ Осознанный tech debt |
| S-01 | Безопасность | MEDIUM | Нет rate limiting | ⬜ nginx limit_req при деплое |
| S-03 | Безопасность | LOW | Webhook без IP whitelist | ⬜ nginx при деплое |
| W-03 | Слабость | LOW | purchase_id без FK constraint (circular FK) | ⬜ Осознанное решение |

**Миграции добавленные:**
- `f5a6b7c8d9e0` — H-02: partial unique index для re-booking (Phase 5.1)
- `a7b8c9d0e1f2` — W-02: index на bookings.purchase_id

**Тесты:** 406 passed, 3 skipped, 5 failed (test isolation issue — practices cleanup scope, не связано с F5). 0 warnings.

### F7 Fixes — март 2026

**BUG: `list_master_practices` вызывался с неверным ключевым аргументом**

| ID | Файл | Проблема | Решение | Статус |
|----|------|----------|---------|--------|
| BUG-F7-01 | `masters/router.py` | `list_master_practices(master_id=user.id, ...)` — неверный kwarg; реальная сигнатура `list_master_practices(user, session, ...)` | `list_master_practices(user, session, limit=limit, offset=offset)` | ✅ |

Симптом: `test_list_master_practices` — `TypeError: list_master_practices() got an unexpected keyword argument 'master_id'`. Коммит: вместе с F7 batch1.

**F7 Backend: `payout` в `MasterProfileResponse`**

| Файл | Изменение | Статус |
|------|-----------|--------|
| `masters/schemas.py` | Добавлено `payout: PayoutDetailsResponse \| None = None` в конец `MasterProfileResponse` | ✅ |
| `masters/router.py` | `_make_profile_response()` — извлекает `payout_raw = data.get("payout")`, конструирует `PayoutDetailsResponse` | ✅ |

**Тесты (добавлены в `tests/test_withdrawals.py`):**
- `test_profile_payout_none_when_not_configured` — GET /masters/me возвращает `payout=null` до настройки
- `test_profile_payout_returned_after_update` — GET /masters/me возвращает payout после PATCH /me/payout

**Итоговые тесты после F7:** 411 passed, 3 skipped, 0 failed.

> **Итоговые тесты после F8 (бэкенд):** 402 passed, 3 skipped — незначительное уменьшение счётчика объясняется рефакторингом тестовых фикстур в ходе F8 review-фиксов (коммит f90288a).

### F8 Review — открытый техдолг (Frontend)

| ID | Среда | Файл | Описание | Решение | Статус |
|----|-------|------|----------|---------|--------|
| TD-FE-A11Y | 🧪 | Admin views (5 файлов) | Clickable `<div>` без `role="button"`, `tabindex="0"`, `@keydown` handlers. Затронуто: алертовый баннер, stat cards, action cards, master cards, report cards. Нарушение WCAG 2.1 AA 2.1.1 | Добавить `role="button"`, `tabindex="0"`, `@keydown.enter.stop`/`@keydown.space.prevent` на каждый clickable div в admin-вью | ⬜ |

### Открытый техдолг — F7 Review

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| TD-F7-W5 | 🧪 | `masters/models.py` (Withdrawal) | `payout_details: dict` — содержимое dict не ограничено схемой | Типизировать как `PayoutDetailsResponse` или `PayoutDetailsDict` | ⬜ |

### Открытый техдолг — Frontend F7 Review (перенесён из ревью)

| ID | Среда | Файл | Проблема | Решение | Статус |
|----|-------|------|----------|---------|--------|
| TD-FE-W4 | 🧪 | `MasterProfileView.vue` | `v-show` на форме payout — все DOM-элементы всегда присутствуют; незначительная нагрузка | Заменить на `v-if` если форма не нужна при переходе с анимацией | ⬜ |
| TD-FE-W6 | 🧪 | `MasterFinanceView.vue` | `MIN_WITHDRAWAL_EUROS=50` и `WITHDRAWAL_FEE_EUROS=2` захардкожены на фронте — рассинхронизируются при изменении `config.py` | Либо GET endpoint, возвращающий лимиты, либо задокументировать как осознанное решение и синхронизировать вручную | ⬜ |
| TD-FE-ROLE-SWITCH | 🧪 | `MasterProfileView.vue` / `UserProfileView.vue` | Мастер не имеет точки входа в каталог практик (юзерский интерфейс). `/user/dashboard` редиректит обратно на мастерский, хотя `/user/calendar`, `/user/bookings` и т.д. доступны напрямую | Кнопка «Перейти в интерфейс юзера» в `MasterProfileView`, «Перейти в интерфейс мастера» в `UserProfileView` (только если `role === 'master'`). Режим хранится в Pinia (не sessionStorage), при переключении — редирект на dashboard нужной роли, `beforeEach` уважает выбранный режим | ⬜ |

### Инфраструктура — перед публичным запуском для российской аудитории 🚀

| ID | Среда | Описание | Решение | Статус |
|----|-------|----------|---------|--------|
| TD-RU-PROXY | 🚀 | Hetzner IP (`api.talentir.info`) заблокирован ТСПУ из России. `ERR_CONNECTION_TIMED_OUT` — сервер полностью недоступен без VPN (и в Telegram WebView, и в обычных браузерах). Обнаружено 28.02.2026 | Российский VPS reverse proxy (Timeweb/Selectel, ~300-500₽/мес) или DDoS-Guard CDN (как у prostoex.io — IP 95.129.236.67, DDoS-Guard Ltd, Ростов-на-Дону). DNS `api.talentir.info` → российский IP. Бэкенд и фронт остаются на Hetzner. Не блокирует разработку — тестирование через VPN или из Европы | ⬜ |

### Осознанные решения (НЕ является долгом)

Следующие замечания были рассмотрены и признаны **не требующими исправления**:

- Race condition на `_redis_client` — теоретически возможен, но `init_redis()` вызывается однократно в lifespan до приёма запросов
- `.env` в Docker image — уже исключён через `.dockerignore`
- Dev-зависимости в production image — осознанный выбор: тесты запускаются в том же контейнере через `velo test`. Образ чуть больше, но единая среда (Phase 0.6)

---

### Итерация «Профиль» — реализация 2026-05-29

Реализован раздел «Профиль пользователя» по Figma (`F7PD5isLfLdyc0q1Bd5n5c`,
node `4715-3463`, 7 экранов). Детали бэка — **Бэковый Кодекс §2, §3.11**; фронта —
**Фронтовый Кодекс §3.7**. Кратко:

**Бэк:** profile-поля `phone`/`bio` и настройки `notifications` живут в
`User.credentials` JSONB (schema-on-read, без миграций, как `onboarding_completed`).
Новые эндпоинты: `GET /api/v1/bookings/me/stats` (`UserStatsResponse` — ORM
COUNT+SUM по attended-броням) и `DELETE /api/v1/users/me` (MVP-семантика: сброс
онбординга, НЕ удаление — `is_active` и данные не трогаются; контракт оставлен под
будущее реальное удаление). `notifications` — вложенный объект с частичным
key-by-key merge (отдельная ветка в `update_user`, не плоский `_JSONB_CREDENTIAL_FIELDS`).

**Фронт:** новые вью `UserProfileView` (переработан: две стат-карточки),
`LanguageTimezoneView`, `EditProfileView` (+ модалка удаления), `NotificationsView`;
новый примитив `VSwitch`; новые роуты `user-language-timezone`/`user-edit-profile`/
`user-notifications`. Язык — заглушка (i18n нет). Экран G (Поддержка) — отложен.

**Аудит итерации (2026-05-29):**
- **W-1** (бэк, `update_practice` не ре-валидировал `style` против сохранённого
  `direction` при PATCH без direction -> битая таксономия в JSONB) — ✅ устранено
  (+ закрыт **S-5**: `_validate_style_for_direction` переиспользована в service).
  **W-4** — добавлены 3 теста.
- **W-2** (фронт, текст модала удаления «восстановить невозможно» противоречил
  реальному поведению) — ✅ исправлен на честный.
- **S-1** (`bio` без `.trimEnd()`), **S-2** (язык-строка выглядела кликабельной) — ✅.
- **W-3** (replay-окно initData) и **S-3** (banker's rounding в `hours_attended`) —
  ⬜ осознанно не код (W-3 — threat model; S-3 — Decimal при финансовых расчётах).

**Тесты:** 446 -> 480 passed, 3 skipped.

---

### Frontend-Backlog эпики + внешнее ревью — реализация 2026-06-20

Закрыт весь P0 фронт-бэклога и пройдено внешнее код-ревью ветки `test` (0 critical,
7/10). Детали — **Бэковый Кодекс §2, §9 (итерация июнь 2026)** и раздел
**PHASE FB** выше. Кратко:

**Доставлено:** E1 (отзывы практики), E2 (доход/лента, миграция `9f1e2d3c4b5a`),
E5 (students CRM), E9 (admin metrics/revenue/practices + seed-выводы), #3
(cross-practice отзывы мастера), **E7** (период-статы мастера/админа +
`core/periods.py`), **E3** (серии: recurrence + карточка + отмена с охватом, без
миграций). Все LIVE на `test`. Детали E3/E7 — PHASE 4 (блок-цитата E3) и Бэковый
Кодекс §2 / §3.13 / §9.

**Ревью №1 — закрыто кодом:** W-1 (явка по PRE-чек-ину в обоих путях финализации),
W-3 (feedback-метрика ≤100%), W-2 (докстринги income — семантика, числа не тронуты),
W-4 (security-WARNING на `role_switch_enabled`), S-1 (`delta_pct` при `prev>0`),
S-3 (имя мастера → «Мастер» в admin revenue). W-5/W-6/W-7 + часть S — фронт/main,
не бэкенд.

**Ревью №2 (аудит E3, F8) — закрыто/решено:** W-1 (вырожденный `until_date` -> 400
на ПУБЛИКАЦИИ), W-3 (один diary-timestamp при bulk-отмене), W-2 (тест cancel
completed-root), S-1 (публичные хелперы diary), S-1c (единый `display_name`). S-2
(блок switch->admin) и S-3 (`new_masters` по дате регистрации) — отклонены с
обоснованием (Бэковый Кодекс §9). Поздний ре-флаг W-1 — ложный (фикс на слое
публикации, полнее схемной проверки). W-5 — pre-prod, W-6/W-7 — задокументированный
MVP-компромисс (всё фронт, Фронтовый Кодекс §10).

**Открыто (бэкенд):** TD-ASK-MASTER → теперь часть E4 (messaging, P1); E8
notifications contract+delivery (P1/P2); E11 one-offs; P2-хвост. (E7 period-stats и
E3 recurrence — ✅ доставлены, см. «Доставлено» выше.) TD-NOTIF-RACE (3 класса
нотификаций под skip) — без изменений.

**Авто-финализация:** работает по `end + buffer` (15 мин), не по 24ч — supersedes
блок «24ч» от 2026-05-31. Финансовый тайминг разморозки — согласовать перед
прод-нагрузкой.

**Тесты:** 480 -> 564 -> 615 passed, 12 skipped.

---

**Конец документа**
