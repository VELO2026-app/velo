# ТЗ: Кураторские группы («Группы для Мастеров») и роль Мастера-Куратора

**Редакция:** 3 от 2026-08-22. Все решения владельца внесены (раздел 11); открытых вопросов
нет, осталась одна ставка с дефолтом (Q-NOTIF).
**База:** `VELO2026-app/velo`, ветка `test` @ `7446684` (единственная ветка: репозиторий
Компании новый, `main` ещё не заведён).
**Банд на базе:** 982 бэк-теста (`tests/*.py`, подсчёт `def test_`), ~2355 фронт-спеков (grep `it(`/`test(`).
**Место в репо:** `docs/tz-curator-groups.md`, коммитит владелец.
**Статус:** не хэндоффер. Нарезка на хэндофферы (P1..P5) -- раздел 8; диспетчер заполняет
файлы/строки/базу поставки сам, здесь их нет намеренно.

Правила чтения: `->` и `--` вместо стрелок и тире. Решения владельца помечены
**[РЕШЕНИЕ ...]** и не обсуждаются при сборке. **[СТАВКА ...]** -- мой дефолт, который
владелец может перебить одной строкой. Утверждения о существующем коде сделаны по телу
функций, файл указан рядом.

---

## 0. Резюме

Вводится сущность **кураторская группа** (`CuratorGroup`) -- школа / сообщество. У группы
один владелец -- **Мастер-Куратор**. Куратором становится **любой verified-мастер, создав
группу**: никакой выдачи, флага или роли нет **[РЕШЕНИЕ Q-GRANT=Б]**. В группе два вида
участников: **мастера** (verified-мастера, вступают по инвайт-ссылке, могут отказаться и
выйти) и **ученики** (любые пользователи, вступают по второй инвайт-ссылке, могут выйти).
Куратор удаляет любых участников и может **передать группу** одному из мастеров-участников;
передача вступает в силу только после его согласия **[РЕШЕНИЕ Q-TRANSFER=Б]**. У группы есть
своя **страница**: шапка, мастера-участники, их предстоящие практики, ученики (только
куратору). Отдельной фазой после v1 -- аудитория практики «кураторские группы»: мастер
закрывает практику на 1..N групп, в которых состоит **[РЕШЕНИЕ Q-P5=А]**. Финансы не
трогаются вообще. Уведомлений в v1 нет. Новая `UserRole` не заводится.

Терминология (фиксируется, чтобы не путать с существующими «Мои группы» мастера):

| Термин | В коде | Что это |
|---|---|---|
| Кураторская группа, группа | `CuratorGroup`, таблица `curator_group` | Школа/сообщество с одним куратором |
| Куратор | `curator_group.curator_user_id` | Verified-мастер, владелец группы; нигде больше не хранится |
| Мастер-участник | `curator_group_member.kind = "master"` | Verified-мастер в группе |
| Ученик-участник | `curator_group_member.kind = "student"` | Любой пользователь в группе |
| Инвайт-ссылка | `curator_group_invite.kind` ∈ {master, student} | Многоразовая ссылка на вступление |
| Предложение передачи | строка `curator_group_transfer` | Ожидающее согласия предложение стать куратором |
| Активная группа | предикат `_active_group_clause` (5.4) | Группа, чей куратор сейчас verified |
| «Состоит сейчас» (для мастера) | предикат `_master_in_group_clause` (8.5) | Куратор ИЛИ видимый (verified) мастер-участник |
| Группы учеников мастера | существующие `master_group` и т.д. | НЕ трогаются |

---

## 1. Цель и не-цели

**Цель.** Куратор собирает под одной вывеской мастеров и учеников; ученики видят
мастеров школы и их практики в одном месте; мастера вступают и выходят по своей воле; группа
переживает смену владельца; мастер школы может провести практику только для своих (P5).

**Не-цели (явно вне забора):**
- Любые деньги: доля куратора, комиссии школы, изменения в `*_ledger`, промокоды. Все
  практики сейчас бесплатные -- дальше в ТЗ слово «цена» не встречается.
- Четвёртая роль или capability: `UserRole` остаётся {user, master, admin};
  `derive_allowed_roles` (`users/schemas.py`), политика свитча, гарды зон не меняются; в
  `MasterProfile.data` ничего не добавляется.
- Админская выдача/отзыв кураторства и админское удаление группы **[РЕШЕНИЕ Q-GRANT=Б,
  Q-ADMINDEL=нет]**. Рычаг модерации у админа один и существующий: `revoke_master` -- он
  делает неактивными все группы этого куратора (I-6).
- Write-действия куратора над мастерами: куратор не создаёт, не правит и не отменяет чужие
  практики и профили.
- Приватная статистика мастеров куратору (посещаемость, отзывы, insights): куратор видит
  только то, что видно любому пользователю через `GET /masters/{user_id}`.
- Уведомления (comms-типы) в v1 **[СТАВКА Q-NOTIF]**, чат/объявления группы, публичный
  каталог школ, бейдж школы в публичном профиле мастера.
- Персональные (адресные) приглашения с состоянием pending/declined **[РЕШЕНИЕ Q-INV=А]**.
- Список учеников группы мастерам-участникам **[РЕШЕНИЕ Q-ROSTER=А]**.
- Смешанная аудитория «мои ученики + школа» одной практикой: `audience_kind` -- одно
  значение (8.5).
- Макеты на новые экраны не рисуются: P3 и P5-фронт идут на реюзе DS
  **[РЕШЕНИЕ Q-MOCK=без макетов]**.

---

## 2. Основа -- что уже есть и на что опираемся

Факты по телу кода на базе:

- **Роли.** `User.role` -- одна колонка (`users/models.py`); MASTER-capability =
  verified `MasterProfile` (`users/service.py::user_has_master_capability`);
  `get_current_master` (`auth/dependencies.py`) = role==master + профиль существует +
  `data.account.status == "verified"`, 403 с кодами `master_profile_not_found` /
  `master_profile_not_verified`. `get_current_admin` -- role==admin.
- **Ревок сохраняет данные.** `revoke_master` (`admin/masters/service.py`) переводит
  `account.status -> "suspended"`, `role -> user`, строки не удаляет; ре-грант -- через
  `make_master`/re-verify. На это опирается I-6: группа «замораживается» статусом куратора и
  оживает сама.
- **Группы учеников мастера** (P1-P6, №590-611): `masters/groups_models.py`
  (`master_group` UNIQUE(master_id,name); `master_group_membership`
  UNIQUE(group_id,student); `group_invite` UNIQUE(group_id), сырой токен;
  `master_student` tag/block). Инвайт: `get_or_create_group_invite` (create-or-return,
  `secrets.token_urlsafe(32)`, 503 `bot_url_not_configured` без `telegram_bot_url`,
  ссылка `<bot_url>?startapp=group_invite__<token>`); `join_group_by_token` (404 на
  неизвестный токен без раскрытия причины, 403 при `blocked_at`, идемпотентное
  повторное вступление, `begin_nested` + `IntegrityError` на гонке). Удаление группы
  заблокировано 409, если группа -- аудитория практики (ruling владельца 2026-07-25; для
  групп учеников остаётся в силе).
- **Аудитория практики** (`practices/audience_service.py`): единый предикат
  `viewer_audience_clause` / `assert_viewer_can_access_practice`, три `_*_clause`,
  fail-closed на неизвестный `audience_kind`, owner-bypass. Вызывается из фида
  (`listing_service.list_public_practices`), `create_booking`, `join_waitlist`,
  `confirm_waitlist`, stranger-gate детали; чек-ин -- только `assert_viewer_not_blocked`
  (политика B, H-R2-8). Коды гейта: `blocked_by_master`, `not_a_student`, `not_in_audience`.
- **Целевые группы практики** (`practices/schemas.py`, `practices/service.py`):
  `audience_kind="groups"` идёт в паре со списком `group_ids` (1..N), `model_validator`
  режет контрадикции 422; `_owned_group_ids_or_400` проверяет владение каждой группой;
  `_set_practice_audience_groups` ЗАМЕНЯЕТ набор целиком; `PracticeResponse.audience_group_names`
  -- имена целевых групп; `POST /practices/{id}/audience-preview` (owner Q15, №613) считает
  `count_stranded_active_bookings` для предлагаемой аудитории. Серии (`series_service.py`,
  C1): каждый ребёнок получает `audience_kind` родителя и свою копию строк целевых групп.
- **Публичный фид** `list_public_practices` принимает `master_id`, фильтрует
  `scheduled|live` + будущее, применяет аудиторию и блок. Публичный профиль мастера --
  `MasterPublicResponse` (граница изоляции: без финансов и контактов, только verified,
  иначе 404).
- **Диплинки.** `useAuth.ts::parseStartParam` знает 4 kind'а
  (`open_practice__`, `zoom__`, `master_onboarding__`, `group_invite__`); маршрут
  `group-join` (`/groups/join/:token`) -- standalone, без гарда, вступление молчаливое
  (toast и на дашборд).
- **Навигация.** `MASTER_TABS`/`USER_TABS` (`router/tabs.ts`); строка «Мои группы» на
  `MasterDashboardView`; секция «Аккаунт» в `UserProfileView` (`VMenuRow`).
- **Comms -- отдельный стек.** Типы уведомлений -- `comms-profile/types.yaml` (18 типов),
  деплой -- ритуал оператора на VPS (`comms-profile/README.md`). Новый тип = работа на той
  стороне границы.
- **Запаркованное владельцем** (`docs/owner-parked-roadmap.md`): Q14 «согласие перед
  добавлением в группу». Для кураторских групп согласие -- единственный путь (I-5).

---

## 3. Доменная модель (v1; таблица P5 -- в 8.5)

### 3.1. Таблицы (миграции Alembic, аддитивные, четыре таблицы)

```
curator_group
  id                uuid PK (UUIDMixin)
  curator_user_id   uuid FK users.id ON DELETE CASCADE, NOT NULL
  name              varchar(100) NOT NULL
  description       text NULL              -- пустое/пробелы -> NULL (как у master_group)
  created_at        timestamptz server_default now()
  updated_at        timestamptz onupdate now()
  UNIQUE (curator_user_id, name)           -- uq_curator_group_curator_name

curator_group_member
  id                uuid PK
  group_id          uuid FK curator_group.id ON DELETE CASCADE, NOT NULL
  user_id           uuid FK users.id ON DELETE CASCADE, NOT NULL
  kind              varchar(10) NOT NULL   -- 'master' | 'student'
  joined_at         timestamptz server_default now()
  UNIQUE (group_id, user_id)               -- uq_curator_group_member_group_user
                                           -- ОДНО отношение на пару, kind в нём

curator_group_invite
  id                uuid PK
  group_id          uuid FK curator_group.id ON DELETE CASCADE, NOT NULL
  kind              varchar(10) NOT NULL   -- 'master' | 'student'
  token             varchar(64) NOT NULL UNIQUE
  created_at        timestamptz server_default now()
  UNIQUE (group_id, kind)                  -- одна живая ссылка на вид

curator_group_transfer
  id                uuid PK
  group_id          uuid FK curator_group.id ON DELETE CASCADE, NOT NULL, UNIQUE
                                           -- не более одного ожидающего предложения
  to_user_id        uuid FK users.id ON DELETE CASCADE, NOT NULL
  requested_at      timestamptz server_default now()
```

Куратор **не** хранится строкой в `curator_group_member`: его отношение выводится из
`curator_group.curator_user_id`. Предложение передачи -- отдельная строка, а не пара
nullable-колонок на группе: «нет предложения» = нет строки, отмена = `DELETE`, нет
состояния «половина пары NULL».

Модуль: новый `app/modules/curator_groups/` (`models.py -> schemas.py -> service.py ->
router.py`; админский read-only список -- `admin_router.py`/`admin_service.py` там же либо
в `admin/` по соседству с другими списками -- решает исполнитель P4). Все Pydantic-схемы с
префиксом `CuratorGroup*` (защита от OpenAPI-коллизий при регене `generated.ts` -- уроки
`RenameGroupRequest`).

### 3.2. Инварианты

- **I-1.** У группы ровно один куратор. Смена -- только через предложение передачи, принятое
  получателем (3.5). Куратором становится любой verified-мастер, создав группу.
- **I-2.** Пара (группа, пользователь) имеет не более одного отношения: `curator`
  (выведено) | `master` | `student`. Куратор не может быть участником своей группы.
- **I-3.** `kind=master` строка создаётся только для пользователя с MASTER-capability
  (verified `MasterProfile`) **на момент вступления**; текущий `role` не важен (мастер в
  режиме юзера тоже вступает как мастер).
- **I-4.** Отображение мастера-участника требует, чтобы он был verified **сейчас**:
  suspended-мастер из ростера и счётчиков исчезает, строка остаётся, повторная верификация
  возвращает его автоматически **[РЕШЕНИЕ Q-SUSP=А]**.
- **I-5.** Единственный путь в группу -- вступление самого человека по ссылке. Куратор не
  может добавить никого по id. Выход и удаление -- в любой момент, без подтверждения другой
  стороны; с P5 перед ними показывается advisory, но действие не блокируется
  **[РЕШЕНИЕ Q-ADV=да]**.
- **I-6.** Группа **активна**, только если её куратор сейчас verified. Неактивная группа для
  всех, кроме админского списка, -- 404; строки (членства, инвайты, предложение передачи,
  целевые строки P5) сохраняются; ре-верификация куратора возвращает всё как было.
- **I-7.** Количество групп у куратора не ограничено; имя уникально в пределах куратора
  **[РЕШЕНИЕ Q-MULTI=А]**.
- **I-8.** Группа ничего не меняет ни в группах учеников мастеров (`master_group*`), ни в
  выведенных «Учениках» мастера, ни в бронях, ни в деньгах.
- **I-9.** Блок учеником куратора (`master_student(master=curator).blocked_at`) закрывает
  вступление по любой ссылке группы -- та же дисциплина, что у `join_group_by_token`.
- **I-10.** Не более одного ожидающего предложения передачи на группу (UNIQUE group_id).
  Получатель -- только видимый (I-4) мастер-участник этой же группы **[РЕШЕНИЕ Q-TR1=ок]**.
- **I-11.** Удаление группы куратором никогда не блокируется чужими практиками: практики,
  нацеленные на группу, переходят в fail-closed (8.5), не мешая действию
  **[РЕШЕНИЕ Q-DEL=разрешено]**. Ruling 2026-07-25 для групп учеников не затронут.

### 3.3. Кто может стать куратором

Любой verified-мастер: первая созданная группа делает его куратором. Зависимость на всех
кураторских эндпоинтах -- существующий `get_current_master`; «моя ли группа» проверяется по
`curator_user_id` (чужая -> 404, P-08). Отдельной `get_current_curator`, флага `is_curator`,
админских grant/revoke -- нет и не закладывается.

### 3.4. Перечисление состояний

Полный список состояний, которые код встретит, и что каждое даёт на выходе.

**Куратор (статус его `MasterProfile`):**

| `account.status` | Эффективно | Что видит |
|---|---|---|
| verified | куратор своих групп | кураторские эндпоинты 200; группы активны |
| suspended | не мастер | `get_current_master` -> 403 `master_profile_not_verified`; все его группы неактивны (404 участникам, пропадают из `mine`) |
| pending / rejected | не мастер | то же; групп у него быть не может (создание требует verified) -- кроме случая «был verified, создал, потом rejected/suspended» -- обрабатывается как suspended |
| нет профиля | не мастер | 403 `master_profile_not_found`; групп нет |

**Группа:** существует и активна / существует и неактивна (I-6) / удалена (hard, каскад
членств, инвайтов, предложения передачи, целевых строк P5). Неактивна и удалена для
участников неразличимы (404) -- намеренно, как `_get_custom_group_or_404`.

**Отношение пользователя к группе:** нет / curator (выведено) / master / student.
Для `master` дополнительно: verified (показан) / не verified (скрыт, I-4).

**Инвайт (на вид `kind`):** нет строки / есть строка. Открытие ссылки:

| Кто открыл | Ссылка master | Ссылка student |
|---|---|---|
| не залогинен | App.vue-гейт: сначала вход, потом посадка (как у `group-join`) | то же |
| токен неизвестен / отозван / группа неактивна / удалена | 404 `invite_not_found` | 404 |
| куратор этой группы | 409 `own_group` | 409 `own_group` |
| уже master-участник | 200, `already_member`, отношение master | 200, `already_member`, отношение master (не понижается) |
| уже student-участник | **повышение** до master, 200 | 200, `already_member` |
| заблокирован куратором (I-9) | 403 `blocked_by_curator` | 403 `blocked_by_curator` |
| verified-мастер (любой текущий role) | вступает как master | вступает как student |
| pending / rejected / suspended мастер | 403 `master_required` | вступает как student |
| обычный пользователь | 403 `master_required` | вступает как student |

**Предложение передачи (на группу):** нет / ожидает (to_user_id). Переходы:

| Событие | Результат |
|---|---|
| куратор предлагает видимому мастеру-участнику | строка создана, 200 |
| куратор предлагает при существующем предложении | 409 `transfer_pending` (сначала отменить; молчаливой перезаписи нет) |
| куратор предлагает не-участнику / ученику / скрытому (suspended) мастеру / себе | 404 `transfer_target_not_member` |
| куратор отменяет | строка удалена, 204; нет строки -> 204 |
| получатель принимает | см. 3.5; 200 со страницей группы, `viewer.relation = curator` |
| получатель отклоняет | строка удалена, 204; нет строки -> 204 |
| принять/отклонить не получатель (в т.ч. куратор) | 404 `transfer_not_found` |
| получатель вышел или удалён куратором | строка удалена в той же транзакции (`leave` / `remove_member` -- единственные две точки) |
| получатель suspended (revoke_master) | строка остаётся; принять -> 403 `master_required`; куратор видит «в тени» и может отменить |
| куратор suspended | группа неактивна -> получателю 404; после ре-верификации предложение живо |
| группа удалена | строка удалена каскадом |
| у получателя уже есть своя группа с таким же именем | принять -> 409 `curator_group_name_taken`; получатель переименовывает свою или отклоняет |

**Удаление участника / выход:** участник есть -> 204; участника нет -> 204 (идемпотентно);
куратор пытается «выйти» -> 409 `curator_cannot_leave` (выход куратора = передача или удаление).

**Страница группы для viewer:** curator / master / student -> 200 с `viewer.relation`; никто
-> 404; группа неактивна -> 404 (кроме админского списка).

### 3.5. Передача группы -- что происходит при принятии (одна транзакция)

1. Проверки: строка `curator_group_transfer` есть и `to_user_id == caller`; группа активна;
   caller -- verified-мастер сейчас; у caller нет своей группы с тем же `name`.
2. `curator_group.curator_user_id := caller`.
3. Удаляется member-строка caller'а (I-2: куратор не участник).
4. Прежний куратор получает member-строку `kind=master`, `joined_at = now()`
   **[РЕШЕНИЕ Q-TR2=ок]** -- остаётся учителем школы и может выйти обычным путём.
5. Строка предложения удаляется.
6. Инвайт-ссылки и членства не меняются: токены те же **[РЕШЕНИЕ Q-TR3=ок]**.
7. Ответ -- `CuratorGroupPageResponse` для нового куратора.

Передача НЕ меняет ничего в практиках прежнего и нового куратора (они принадлежат мастерам,
не группе); практики, нацеленные на группу (P5), остаются доступны: оба «состоят сейчас».

---

## 4. Матрица прав

| Действие | Ученик-участник | Мастер-участник | Куратор | Админ | Посторонний |
|---|---|---|---|---|---|
| Список «мои группы» | свои | свои | свои + кураторские | -- | пусто |
| Страница группы (шапка, счётчики) | ✓ | ✓ | ✓ | список групп (P4) | 404 |
| Ростер мастеров (публичный subset) | ✓ | ✓ | ✓ | -- | 404 |
| Ростер учеников | ✗ (счётчик) | ✗ (счётчик) | ✓ | -- | 404 |
| Практики мастеров группы (фид) | ✓ (с учётом аудитории/блока) | ✓ | ✓ | -- | 404 |
| Выйти из группы | ✓ | ✓ | 409 | -- | 204 (идемпотентно) |
| Создать группу | -- | любой verified-мастер | ✓ | ✗ | ✗ |
| Переименовать / удалить группу | ✗ | ✗ | ✓ | ✗ | ✗ |
| Инвайт-ссылки: получить / отозвать | ✗ | ✗ | ✓ | ✗ | ✗ |
| Удалить участника (любого вида) | ✗ | ✗ | ✓ | ✗ | ✗ |
| Предложить передачу / отменить | ✗ | ✗ | ✓ | ✗ | ✗ |
| Принять / отклонить передачу | ✗ | ✓ (только адресат) | ✗ | ✗ | ✗ |
| Закрыть свою практику на группу (P5) | -- | ✓ (свои группы) | ✓ (свои группы) | ✗ | ✗ |

Посторонний = любой аутентифицированный без отношения к группе. Неаутентифицированных в
API нет (все эндпоинты за `get_current_user` и выше).

---

## 5. Контракт бэка (v1; дополнения P5 -- в 8.5)

### 5.1. Auth-зависимости

- Кураторские эндпоинты (`/masters/me/curator-groups/...`) -- `get_current_master` + проверка
  владения группой в сервисе (чужая/нет -> 404).
- Участник-эндпоинты (`/curator-groups/...`) -- `get_current_user` (read) /
  `get_current_user_write` (mutations).
- Админ -- `get_current_admin`.
- Сессии: `get_db_reader` на GET, `get_db_session` на мутациях; сервис не коммитит (P-01),
  роутер `flush()`.

### 5.2. Эндпоинты

**Куратор** (все за `get_current_master`; `{id}` -- только своя группа, иначе 404)

```
GET    /api/v1/masters/me/curator-groups
       -> {items:[{id,name,description,masters_count,students_count,
                   transfer:{to_user_id,to_display_name,requested_at}|null,created_at}]}
POST   /api/v1/masters/me/curator-groups            {name, description?}  -> 201 CuratorGroupResponse
       409 curator_group_name_taken | 422 на пустое/длинное имя (StringConstraints, P-11)
PATCH  /api/v1/masters/me/curator-groups/{id}       {name, description?}  -> 200
       partial-семантика description через model_dump(exclude_unset=True) -- по прецеденту
       RenameGroupRequest; 404 не моя / нет; 409 имя занято
DELETE /api/v1/masters/me/curator-groups/{id}       -> 204; каскад членств, инвайтов, передачи,
       целевых строк P5; никогда не 409 (I-11); 404 нет
GET    /api/v1/masters/me/curator-groups/{id}/members?kind=master|student&search&limit&offset
       -> {items:[{user_id,name,avatar_url,kind,joined_at,is_visible}],total,limit,offset}
       is_visible=false у suspended-мастера (I-4): куратор видит, что человек «в тени»
DELETE /api/v1/masters/me/curator-groups/{id}/members/{user_id} -> 204 (идемпотентно);
       если user_id -- адресат ожидающей передачи, предложение удаляется тут же
POST   /api/v1/masters/me/curator-groups/{id}/invites   {kind}  -> 200 {kind, invite_url}
       create-or-return; 503 bot_url_not_configured (тот же код, что у group invite)
DELETE /api/v1/masters/me/curator-groups/{id}/invites/{kind}    -> 204 (ротация: следующий
       POST чеканит новый токен; старая ссылка -> 404)
POST   /api/v1/masters/me/curator-groups/{id}/transfer  {to_user_id}
       -> 200 {to_user_id,to_display_name,requested_at}
       409 transfer_pending | 404 transfer_target_not_member (не участник / ученик /
       скрытый мастер / сам куратор -- неразличимо)
DELETE /api/v1/masters/me/curator-groups/{id}/transfer  -> 204 (отмена; идемпотентно)
```

**Участник / любой пользователь** (`get_current_user`)

```
GET    /api/v1/curator-groups/mine
       -> {items:[{id,name,description,curator:{user_id,display_name,avatar_url},
                   masters_count,students_count,relation: curator|master|student,
                   transfer_offered: bool}]}
       только активные группы (I-6); порядок: кураторские, затем по joined_at;
       transfer_offered=true, если caller -- адресат ожидающей передачи
GET    /api/v1/curator-groups/{id}
       -> CuratorGroupPageResponse {id,name,description,curator:{...},
          masters_count,students_count,viewer:{relation},
          transfer:{to_user_id,to_display_name,requested_at}|null,created_at}
       transfer заполнен ТОЛЬКО для куратора и для адресата, остальным null;
       404 если нет отношения / неактивна / нет
GET    /api/v1/curator-groups/{id}/masters?limit&offset
       -> {items:[{user_id,display_name,avatar_url,methods,experience_years,
                   practices_count,is_curator}],total,limit,offset}
       куратор первым с is_curator=true; затем verified master-участники по joined_at;
       поля -- ровно subset MasterPublicResponse (граница изоляции переиспользуется,
       не переизобретается); 404 как выше
GET    /api/v1/curator-groups/{id}/practices?limit&offset
       -> PaginatedPracticesResponse (та же форма, что /practices)
       = list_public_practices с master_ids = {куратор} ∪ {verified master-участники},
       дефолтный фид (scheduled|live, будущее), viewer_audience_clause применяется как есть
       -> чужая закрытая практика и практики заблокировавшего тебя мастера не видны; 404 как выше
DELETE /api/v1/curator-groups/{id}/membership   -> 204 (выход; идемпотентно); 409 curator_cannot_leave
       если caller -- адресат ожидающей передачи, предложение удаляется тут же
POST   /api/v1/curator-groups/{id}/transfer/accept   -> 200 CuratorGroupPageResponse (3.5)
       404 transfer_not_found (нет предложения / не адресат / группа неактивна -- неразличимо)
       403 master_required (адресат не verified сейчас) | 409 curator_group_name_taken
POST   /api/v1/curator-groups/{id}/transfer/decline  -> 204 (идемпотентно; не адресат -> 204)
GET    /api/v1/curator-groups/invites/{token}
       -> {group:{id,name,description,curator_name,masters_count,students_count},
           kind, can_join: bool, reason: null|already_member|own_group|master_required|blocked_by_curator,
           relation: null|master|student}
       404 invite_not_found (неизвестный/отозванный токен, неактивная/удалённая группа -- неразличимо)
POST   /api/v1/curator-groups/join   {token}  -> 200 {group_id, relation, already_member: bool}
       повторно валидирует ВСЁ, что показывал preview (preview -- подсказка, join -- гейт);
       коды: 404 invite_not_found | 403 master_required | 403 blocked_by_curator | 409 own_group
```

**Админ** (P4, read-only) **[РЕШЕНИЕ Q-ADMINLIST=А]**

```
GET    /api/v1/admin/curator-groups?limit&offset
       -> {items:[{id,name,curator:{user_id,display_name},masters_count,students_count,
                   is_active,created_at}],total,limit,offset}
       неактивные группы ВКЛЮЧЕНЫ (единственное место, где они видны)
```
`AdminMasterListItem` получает `curator_groups_count: int` (батч-COUNT по page'у master_ids,
по прецеденту `practices_count` в `admin/users/service.py::list_masters`; без миграции).

`list_public_practices` получает параметр `master_ids: list[UUID] | None` рядом с
существующим `master_id` (оба опциональны; публичный роут `master_ids` наружу не
выставляет -- это внутренний параметр для эндпоинта группы). Пустое множество `master_ids`
(группа без verified-мастеров) -> пустая страница, без обращения к БД.

### 5.3. Коды ошибок (machine codes, фронт маппит в русский текст)

`curator_group_name_taken`, `curator_cannot_leave`, `invite_not_found`, `master_required`,
`blocked_by_curator`, `own_group`, `transfer_pending`, `transfer_target_not_member`,
`transfer_not_found`. Повторно используются: `master_profile_not_found`,
`master_profile_not_verified`, `bot_url_not_configured`; в P5 -- `not_in_audience`.
404 -- всегда без раскрытия причины (P-08).

### 5.4. Точки врезки в существующее (v1)

| Где | Что | Зачем |
|---|---|---|
| `practices/listing_service.py` | `master_ids` | фид группы без дублирования фильтров и аудитории |
| `admin/users/service.py`, `admin/users/schemas.py` | `curator_groups_count` (P4) | бейдж «Куратор» в админке |
| `useAuth.ts::parseStartParam` | kind `curator_group_invite__` | посадка по ссылке |
| `revoke_master`, `verify_master`, `make_master` | **ничего** | активность группы выводится из статуса через `_active_group_clause`, код ревока не трогаем |
| `derive_allowed_roles`, свитч ролей, гарды зон, `MasterProfile.data` | **ничего** | не-цель |
| `auth/dependencies.py` | **ничего** | `get_current_master` достаточно |

Предикат `_active_group_clause()`: `EXISTS master_profiles mp WHERE mp.user_id =
curator_group.curator_user_id AND mp.data->'account'->>'status' = 'verified'`. Одна
функция, используется во всех участник-чтениях, в `join`/`preview`, в `transfer/accept` и
(P5) в предикате аудитории. Кураторские эндпоинты её не вызывают: `get_current_master` уже
гарантирует, что куратор verified, а владение проверено по `curator_user_id`.

Ростер/счётчик мастеров: `curator_group_member.kind='master'` JOIN `master_profiles` с
`status='verified'`. Счётчик учеников: все `kind='student'` строки. Фильтр `is_active`
пользователя -- повторить ровно то, что делает прецедент `list_group_members`
(`masters/groups_service.py`), не больше (раздел 12).

Точки удаления предложения передачи при уходе адресата -- ровно две: `remove_member` и
`leave`. Обе делают это одним `DELETE` внутри своей транзакции; третьей копии этой логики
быть не должно.

### 5.5. Три оси двойников по каждому входу (v1)

| Вход | ПОВТОР | ПУСТОТА | НЕХВАТКА |
|---|---|---|---|
| create group | то же имя у того же куратора -> 409 (UNIQUE + pre-check + IntegrityError-backstop, как `create_group`) | имя «» / пробелы -> 422; description пробелы -> NULL | не verified-мастер -> 403 `master_profile_not_verified` |
| patch group | имя = своё же -> 200 без изменений; имя другой своей группы -> 409 | description «» при `provided` -> NULL; не прислан -> не трогаем | 404 чужая/нет |
| delete group | второй delete -> 404 | группа с 0 участников -> 204 | 404 чужая |
| members list | один user не может быть в двух kind (UNIQUE) | 0 строк -> `total=0` | suspended master -> `is_visible=false`, не 404 |
| remove member | второй -> 204 | -- | не участник -> 204; куратор сам себя -> 204 без эффекта (он не строка) |
| invite create | повтор -> та же ссылка; после DELETE -> новая | bot_url пуст -> 503 | группа чужая -> 404 |
| preview / join | повторный join -> 200 `already_member` | группа без мастеров -> can_join всё равно true | токен чужой/битый/отозванный/от неактивной группы -> 404; не мастер по master-ссылке -> 403 |
| leave | повтор -> 204 | -- | нет отношения -> 204; куратор -> 409 |
| transfer offer | второе предложение -> 409 `transfer_pending`; то же лицо повторно -> тоже 409 | группа без мастеров -> любое to_user_id -> 404 | адресат не участник/скрыт/ученик/сам -> 404 |
| transfer cancel | второй -> 204 | нет предложения -> 204 | 404 чужая группа |
| transfer accept | второй accept -> 404 (строки нет; caller уже куратор) | -- | не адресат -> 404; адресат не verified -> 403; коллизия имени -> 409; группа неактивна -> 404 |
| transfer decline | второй -> 204 | нет предложения -> 204 | не адресат -> 204 (ничего не раскрываем) |
| page / masters / practices | -- | 0 мастеров -> пустой ростер и пустой фид; 0 практик -> пустая страница | нет отношения / неактивна -> 404 |
| mine | -- | 0 групп -> `items: []` | неактивные группы в выдачу не попадают |
| admin list | -- | 0 групп -> `total=0` | неактивные включены с `is_active=false` |

---

## 6. Фронт (v1; P5-фронт -- в 8.5)

DS-first, honest-stub, без фейк-данных, без макетов **[РЕШЕНИЕ Q-MOCK]**: визуальный язык --
существующие `MasterGroupsView` / `MasterGroupDetailView` / `GroupJoinView` (`VHeader`,
`VListRow`, `VMenuRow`, `VEmptyState`, `VCard`, header-меню «⋯» по G2).

### 6.1. Диплинк

`<bot_url>?startapp=curator_group_invite__<token>` -> `parseStartParam` -> маршрут
`curator-group-join` (`/curator-groups/join/:token`). Один kind на оба вида ссылок: вид
отдаёт сервер в preview. Старые kind'ы не трогаются.

### 6.2. Маршруты и экраны

| Маршрут | Имя | Зона | Экран |
|---|---|---|---|
| `/curator-groups/join/:token` | `curator-group-join` | standalone (как `group-join`) | `CuratorGroupJoinView`: preview -> карточка группы (имя, куратор с аватаром, описание, счётчики, подпись «как мастер» / «как ученик») -> «Вступить» / «Отказаться». Отказ = `router.replace({name:'root'})`, серверного состояния не создаёт. Состояния: загрузка / transient-ошибка с «Повторить» (дисциплина W11) / 404 «Приглашение недействительно» / 403 master_required «Ссылка для верифицированных мастеров» / 403 blocked / 409 own_group «Это ваша группа» / already_member «Вы уже в группе» + «Открыть группу». Успех -> страница группы в зоне по текущему `role` |
| `/user/groups` | `user-curator-groups` | user | список `GET /curator-groups/mine` с чипом отношения и чипом «Предложение кураторства» при `transfer_offered`; пусто -> честный `VEmptyState` («Вступить можно по ссылке от куратора») |
| `/user/groups/:id` | `user-curator-group` | user | страница группы (6.3) |
| `/master/curator-groups` | `master-curator-groups` | master | тот же список; секции «Я куратор» и «Я участник»; «+» в шапке виден **всегда** (любой verified-мастер может создать). Пусто в обеих -> `VEmptyState` с подсказкой «Создайте группу или вступите по ссылке» |
| `/master/curator-groups/new` | `master-curator-group-create` | master | форма имя + описание (по образцу `MasterGroupCreateView`) |
| `/master/curator-groups/:id` | `master-curator-group` | master | страница группы с управлением, если `viewer.relation === 'curator'` |

Точки входа: строка «Мои группы» в «Аккаунт» `UserProfileView` -> `user-curator-groups`
(в user-зоне другого понятия «группы» нет); строка «Группы мастеров» на `MasterDashboardView`
под существующей «Мои группы» -> `master-curator-groups` **[РЕШЕНИЕ Q-NAME=А]**.
Админ (P4): `AdminCuratorGroupsView` (`admin-curator-groups`), вход со страницы
`admin-masters`; бейдж «Куратор» в `AdminMastersView` по `curator_groups_count > 0`.
Табы не меняются.

### 6.3. Страница группы -- одна реализация, поведение по `viewer.relation`

Один компонент страницы, смонтирован в обеих зонах (две тонкие обёртки или один view на два
маршрута -- по Фронтовому Кодексу, решает исполнитель). Данные: `GET /curator-groups/{id}`
+ `/masters` + `/practices` (+ `/masters/me/curator-groups/{id}/members?kind=student` для
куратора).

| Блок | student | master | curator |
|---|---|---|---|
| Шапка: имя, описание, куратор, счётчики мастеров/учеников | ✓ | ✓ | ✓ + «⋯»: Редактировать / Пригласить мастера / Пригласить ученика / Передать группу / Удалить группу |
| Баннер передачи | -- | «Вам предлагают стать куратором» + «Принять» / «Отклонить» (только адресату, по `transfer`) | «Предложение отправлено <имя>» + «Отменить» |
| Действие в шапке | «Покинуть группу» (confirm) | «Покинуть группу» (confirm) | -- |
| Мастера (карточки, tap -> `user-master-public`) | ✓ | ✓ | ✓ + удалить из группы (confirm) |
| Практики (карточки `CalendarPracticeCard`, tap -> `practice-detail`; в master-зоне тот же `/user/practices/:id` -- маршруты `/user/*` мастеру доступны) | ✓ | ✓ | ✓ |
| Ученики | счётчик | счётчик | список + удалить (confirm) |
| Пустые состояния | «Мастеров пока нет» / «Ближайших практик нет» | то же | то же + подсказка «Поделитесь ссылкой» |

Диалог инвайта: `POST .../invites {kind}` -> лист с ссылкой, кнопки «Скопировать» (B2-клипборд,
как в `admin-master-invite`) и «Отозвать ссылку» (`DELETE`, с confirm «старая ссылка перестанет
работать»). 503 `bot_url_not_configured` -> честный тост, без фейковой ссылки.

Диалог передачи: «Передать группу» -> выбор из видимых мастеров-участников (тот же ростер;
ученики и скрытые не предлагаются) -> confirm «После согласия <имя> станет куратором, вы
останетесь мастером-участником» -> `POST .../transfer`. При ожидающем предложении пункт
меню заменяется баннером с «Отменить». Принятие адресатом -> ответ сервера подменяет
страницу: `viewer.relation` становится `curator`, «⋯» появляется без перезагрузки.

Удаление группы: confirm с числами «N мастеров, M учеников потеряют доступ к странице»
(в P5 добавляется третье число, 8.5).

### 6.4. Типы и тесты

`api/curatorGroups.ts` -- типизированные обёртки поверх `api.*`, hand-written с тем же
дисклеймером, что в `api/groups.ts` (сходятся при регене `generated.ts`; в `api/types.ts`
руками не добавлять). Стор не заводится, пока нет второго потребителя (прецедент groups).
Vitest-спеки на каждый новый view по образцу `MasterGroupsView.test.ts` /
`GroupJoinView.test.ts`; `parseStartParam` -- спека на новый kind в `useAuth.test.ts`.

---

## 7. Сквозное

**Уведомления.** В v1 новых comms-типов нет **[СТАВКА Q-NOTIF]**: comms -- отдельный стек,
новый тип -- работа на той стороне границы и операторский ритуал деплоя. Предложение
передачи и вступления видны только при следующем открытии приложения (раздел 10).
Кандидаты на фазу 2, по ценности: `curator_group.transfer_offered` (адресату),
`curator_group.practice_published` (ученикам группы: новая практика мастера школы),
`curator_group.member_joined` (куратору), `curator_group.member_removed` (участнику).
Фиксируются здесь, не в коде. Если владелец перебьёт ставку -- `transfer_offered` входит в P4
как outbox-событие в существующий relay плюс тип в `comms-profile`.

**Сиды.** Профиль `velo seed --profile <name>` (`backend/scripts/seed_profiles/*.json`)
расширяется секцией `curator_groups: [{curator, name, description, masters:[keys],
students:[keys]}]` -- чтобы показ проходил без ручной подготовки (P4); в P5 -- плюс практика
с `audience: curator_groups`.

**Документация.** Разделы в Бэковом и Фронтовом Кодексах по образцу записей о Master GROUPS;
этот файл -- источник, Кодексы -- краткая выжимка со ссылкой.

---

## 8. Фазы и `done-when`

Каждая фаза -- один хэндоффер; забор фазы = её таблица. Порядок жёсткий: P1 -> P2 -> P3
-> P4 -> P5 **[РЕШЕНИЕ Q-P5=А]**.

### 8.1. P1 -- бэк: группы, участники, страница

| # | Item | done-when |
|---|---|---|
| 1 | Миграция: 4 таблицы (3.1) | `alembic upgrade head` и `downgrade -1` проходят; DDL совпадает с 3.1 включая имена constraint'ов |
| 2 | CRUD групп куратора (`get_current_master` + владение) | ПОВТОР/ПУСТОТА/НЕХВАТКА по строкам create/patch/delete (5.5) покрыты; чужая группа -> 404 на всех мутациях |
| 3 | Members list / remove | `is_visible=false` у suspended-мастера подтверждён тестом, который суспендит через `revoke_master`, а не руками в JSONB |
| 4 | `GET /curator-groups/mine`, `/{id}`, `/{id}/masters`, `/{id}/practices`, leave | посторонний -> 404 на всех четырёх; suspended куратор -> 404 на всех четырёх + группа пропадает из `mine`; ре-верификация возвращает 200 без изменения строк; фид не показывает практику заблокировавшего viewer мастера; куратор в ростере первый с `is_curator=true` |
| 5 | `master_ids` в `list_public_practices` | существующий `master_id` и все фасеты байт-идентичны (регресс через существующие тесты фида без правок) |

### 8.2. P2 -- бэк: инвайты, вступление, передача

| # | Item | done-when |
|---|---|---|
| 1 | invites create/delete | повтор -> та же ссылка; после DELETE -> новая, старый токен -> 404; 503 без bot_url |
| 2 | preview | каждая ячейка таблицы «Инвайт» (3.4) -- отдельный тест, включая повышение student->master и непонижение master |
| 3 | join | join без preview даёт те же коды; гонка двух одновременных join одного пользователя -> одна строка (`begin_nested` + `IntegrityError`, как `join_group_by_token`) |
| 4 | I-9 блок | заблокированный куратором -> 403 на обеих ссылках |
| 5 | transfer offer / cancel / accept / decline | каждая строка таблицы «Предложение передачи» (3.4) -- отдельный тест; после accept: `curator_user_id` новый, у нового нет member-строки, у прежнего есть `kind=master`, инвайт-токены не изменились, предложение удалено -- всё в одном тесте на состояние БД |
| 6 | авто-снятие предложения | `remove_member` адресата и `leave` адресата удаляют предложение; suspended адресат -- предложение остаётся, accept -> 403 |

### 8.3. P3 -- фронт

| # | Item | done-when |
|---|---|---|
| 1 | `parseStartParam` + маршрут `curator-group-join` + `CuratorGroupJoinView` | все состояния 6.2 отрисованы по коду ответа; `vue-tsc`, `vite build`, Vitest зелёные |
| 2 | user-зона: строка «Мои группы», список, страница | страница показывает ростер мастеров и фид; «Покинуть» убирает группу из списка без перезагрузки |
| 3 | master-зона: строка «Группы мастеров», список, создание, страница с управлением | «⋯» доступно только куратору; инвайт-лист с копированием и отзывом; удаление участника и группы с confirm; «+» виден любому verified-мастеру |
| 4 | передача на фронте | пункт «Передать группу» -> выбор из ростера -> баннер с «Отменить»; у адресата баннер «Принять / Отклонить»; после принятия страница переключается в режим куратора без перезагрузки; чип в списке `mine` |
| 5 | `api/curatorGroups.ts` | hand-written типы совпадают с ответами P1/P2 по именам полей 1:1 |

### 8.4. P4 -- сквозное

| # | Item | done-when |
|---|---|---|
| 1 | Сид-профиль с кураторской группой | `velo seed --profile <name>` поднимает куратора, 2+ мастеров, 3+ учеников, 2+ предстоящих практик; страница группы на показе не пустая |
| 2 | `GET /admin/curator-groups` + `AdminCuratorGroupsView` + `curator_groups_count` и бейдж в `AdminMastersView` | список показывает неактивные группы с пометкой; тап -> профиль куратора в админке; бейдж появляется после создания первой группы |
| 3 | Записи в Кодексах | ссылка на этот файл; таблица эндпоинтов и кодов совпадает с 5.2/5.3 |

### 8.5. P5 -- аудитория «кураторские группы» (контракт)

**Смысл.** Сегодня мастер выбирает аудиторию практики: все / мои ученики / мои группы
учеников. Добавляется четвёртый вариант: **«кураторские группы»** -- 1..N групп, в которых
мастер сейчас состоит (как участник или как куратор). Множественность ровно та же, что у
`group_ids`: состоит в А и Б, выбрал А -- видят участники А; выбрал А и Б -- видит любой,
кто хотя бы в одной; ноль групп -- варианта в форме нет.

**Модель.** `AudienceKind.CURATOR_GROUPS = "curator_groups"`.

```
practice_audience_curator_group
  id           uuid PK
  practice_id  uuid FK practices.id ON DELETE CASCADE, NOT NULL
  group_id     uuid FK curator_group.id ON DELETE CASCADE, NOT NULL
  UNIQUE (practice_id, group_id)           -- uq_practice_audience_curator_group
```
Зеркало `practice_audience_group` (FK по имени таблицы, без импорта модуля -- тот же
приём против цикла импортов).

**Схемы.** `CreatePracticeRequest` / `UpdatePracticeRequest` / `AudiencePreviewRequest`
получают `curator_group_ids: list[UUID]` с теми же правилами, что `group_ids`: обязателен и
непуст при `audience_kind="curator_groups"`, запрещён при любом другом; `group_ids` и
`curator_group_ids` никогда не присылаются вместе (422 на контрадикцию через тот же
`model_validator`). PATCH-семантика -- зеркало `group_ids` в `UpdatePracticeRequest` (по
телу: «не прислан = не меняем», проверка контрадикции только при явной паре).
`PracticeResponse` получает `audience_curator_group_names: list[str] | None` (зеркало
`audience_group_names`) и `audience_unavailable: bool` -- true, когда
`audience_kind="curator_groups"` и ни одна целевая группа не проходит `_master_in_group_clause`
для мастера практики (практику не видит никто, кроме мастера и уже забронировавших).

**Валидация при create/patch.** `_member_curator_group_ids_or_400` (зеркало
`_owned_group_ids_or_400`): каждая группа активна И мастер в ней «состоит сейчас»; иначе 400
тем же текстом-образцом (`curator_group_ids must be groups you belong to`).
`_set_practice_audience_curator_groups` ЗАМЕНЯЕТ набор целиком (зеркало
`_set_practice_audience_groups`).

**Предикат** (`audience_service.py`, четвёртый `_*_clause`, тот же стиль):

```
_master_in_group_clause(master_id)  -- коррелирован к curator_group:
    curator_group.curator_user_id = master_id
    OR EXISTS curator_group_member m WHERE m.group_id = curator_group.id
         AND m.user_id = master_id AND m.kind = 'master'
         AND EXISTS master_profiles mp WHERE mp.user_id = master_id
               AND mp.data->'account'->>'status' = 'verified'
_viewer_in_group_clause(user_id)    -- куратор ИЛИ любая member-строка (любого kind)
_is_curator_group_audience_clause(user_id):
    EXISTS practice_audience_curator_group pacg JOIN curator_group cg
    WHERE pacg.practice_id = Practice.id
      AND _active_group_clause(cg)
      AND _viewer_in_group_clause(user_id)
      AND _master_in_group_clause(Practice.master_id)
```
Условие на мастера -- ядро решения **[РЕШЕНИЕ 2026-08-22]**: удалённый из школы или
вышедший мастер не продолжает показывать школе свою практику. Блок (`_blocked_clause`)
применяется как ко всем kind'ам. `viewer_audience_clause` и
`assert_viewer_can_access_practice` получают четвёртую ветку; код ошибки -- существующий
`not_in_audience` (смысл тот же: «не участник целевых групп», текст на фронте уже есть).
Fail-closed на неизвестный kind не трогается. Все вызывающие гейт (фид, `create_booking`,
`join_waitlist`, `confirm_waitlist`, stranger-gate детали) получают поведение автоматически --
новых вызовов не добавляется. Чек-ин -- политика B без изменений: CONFIRMED-бронь проходит,
блок -- нет.

**Серии.** `series_service` копирует строки `practice_audience_curator_group` в каждого
ребёнка тем же приёмом, что строки `practice_audience_group` (C1): серия с `curator_groups`
без копий была бы публичной у детей -- тот же класс дыры, который C1 закрыл.

**`audience-preview`.** Принимает `curator_group_ids`; `count_stranded_active_bookings`
считает по новому предикату -- те же цифры «кого отрежет сужение», что и для `groups`.

**Fail-closed и предупреждение.** Мастер вышел / удалён / группа удалена или неактивна, а
практика «для группы» предстоит: практика видна только мастеру и тем, у кого есть
CONFIRMED-бронь (grandfather H-R2-8, без изменений); `audience_unavailable=true`; в
master-зоне на карточке и в деталях -- предупреждение «Группа недоступна -- смените
аудиторию» с переходом в редактирование. Никакого авто-расширения аудитории и никаких
блокировок действий **[РЕШЕНИЕ 2026-08-22; Q-DEL=разрешено]**.

**Advisory перед действиями** **[РЕШЕНИЕ Q-ADV=да]** (read-only, действие не блокируется):

```
GET /api/v1/curator-groups/{id}/leave-preview
    -> {upcoming_practices_targeting_group: int}   -- СВОИ предстоящие практики caller'а на эту группу
GET /api/v1/masters/me/curator-groups/{id}/members/{user_id}/remove-preview
    -> {upcoming_practices_targeting_group: int}   -- предстоящие практики этого участника на эту группу
GET /api/v1/masters/me/curator-groups/{id}/delete-preview
    -> {masters_count, students_count, upcoming_practices_targeting_group: int}  -- всех мастеров
```
«Предстоящие» = `scheduled|live`, `scheduled_at` в будущем (как дефолтный фид).

**Перечисление состояний P5** (практика с `audience_kind="curator_groups"`, целевые группы T):

| Состояние | Кто видит / может бронировать |
|---|---|
| мастер «состоит сейчас» хотя бы в одной активной g ∈ T | куратор и участники таких g (минус заблокированные мастером); все остальные -- нет |
| мастер ни в одной g ∈ T (вышел / удалён / suspended) ИЛИ все g неактивны / удалены | только мастер + CONFIRMED-брони; `audience_unavailable=true` |
| viewer -- участник g ∈ T, но заблокирован мастером | нет (`blocked_by_master`) |
| viewer держит CONFIRMED-бронь, потом вышел из g | бронь жива (R2-симметрия); чек-ин проходит; новую бронь на другую такую практику не получит |
| серия: ребёнок создан после изменения T у родителя | правило наследования -- зеркало существующего для `groups` (по телу `series_service`), новых правил нет |
| PATCH снимает `curator_groups` -> `public` | строки T удаляются (замена набора пустым), `audience_unavailable=false` |

**Три оси P5:**

| Вход | ПОВТОР | ПУСТОТА | НЕХВАТКА |
|---|---|---|---|
| create/patch с `curator_group_ids` | один id дважды -> набор из одного (UNIQUE; дедуп в сервисе) | `[]` при kind=curator_groups -> 422; kind=public с непустым списком -> 422 | id чужой/неактивной группы -> 400 |
| предикат | viewer состоит в двух целевых -> один проход, не два (EXISTS) | T пуст (строки удалены каскадом) -> никто, кроме мастера | мастер вышел -> никто, кроме мастера и броней |
| advisories | -- | 0 практик -> `0`, не 404 | чужая группа -> 404; не участник -> 404 |
| `audience_unavailable` | -- | kind != curator_groups -> всегда false | -- |

**Фронт P5.** Четвёртый вариант в существующем селекторе аудитории `CreatePracticeView` /
`EditPracticeView`: чипы-мультивыбор по `GET /curator-groups/mine` (только группы с
`relation` ∈ {curator, master}); ноль таких групп -> вариант не показывается. Бейдж
«Для группы» на карточке практики (по `audience_kind`, рядом с существующим бейджем
«Бесплатно»). В master-зоне -- предупреждение по `audience_unavailable` на карточке
`MasterPracticesView` и в `MasterPracticeDetailView` с CTA в редактирование. Confirm-диалоги
«Покинуть группу», «Удалить участника», «Удалить группу» получают строку из advisory:
«N предстоящих практик для этой группы станут скрыты» (0 -> строка не показывается).
`api/curatorGroups.ts` -- три advisory; `api/practices.ts` -- поле `curator_group_ids`.

**Таблица работ P5:**

| # | Item | done-when |
|---|---|---|
| 1 | Миграция `practice_audience_curator_group` + `AudienceKind.CURATOR_GROUPS` | upgrade/downgrade проходят; существующие тесты `audience_service` не правятся и зелёные |
| 2 | Схемы + валидация + замена набора | все ячейки «Три оси P5» строка 1 покрыты; `group_ids` с `curator_group_ids` вместе -> 422 |
| 3 | Предикат + гейт | каждая строка «Перечисление состояний P5» -- отдельный тест, и каждый прогоняется через ВСЕ вызывающие (фид, booking, waitlist join, waitlist confirm, detail) -- не через один; чек-ин с CONFIRMED после выхода -> 200, строка Checkin создана |
| 4 | Серии | ребёнок `curator_groups`-серии имеет свои строки T; тест-двойник «ребёнок без строк виден постороннему» падает до правки и зелен после |
| 5 | `audience-preview` | принимает `curator_group_ids`; цифра stranded совпадает с ручным подсчётом в тесте |
| 6 | `audience_unavailable` + `audience_curator_group_names` | true после leave / remove / delete group / revoke_master мастера; false после PATCH на public |
| 7 | Три advisory | чужая группа -> 404; цифры совпадают с фидом мастера |
| 8 | Фронт (селектор, бейдж, предупреждение, advisory в confirm) | `vue-tsc`/`vite build`/Vitest зелёные; вариант скрыт при нуле групп; предупреждение исчезает после смены аудитории без перезагрузки |
| 9 | Сид: практика с `audience: curator_groups` | на показе страница группы содержит практику с бейджем «Для группы», посторонний её в календаре не видит |

---

## 9. Тест-план

**Диапазоны `telegram_id`.** Свободны 65xxx-69xxx: проверено перебором всех пятизначных
литералов 50000-99999 по `tests/*.py` (занято: 50, 55-64, 70, 73-99); вычисляемых баз
(`BASE + i`) в этом диапазоне не найдено. Назначение:

| Файл | Диапазон |
|---|---|
| `test_curator_groups.py` (P1 #2-3) | 66000-66199 (админ 66190) |
| `test_curator_group_page.py` (P1 #4-5) | 66200-66399 |
| `test_curator_invites.py` (P2 #1-4) | 67000-67199 |
| `test_curator_transfer.py` (P2 #5-6) | 67200-67399 |
| `test_curator_audience.py` (P5 #1-7) | 68000-68399 |
| `test_admin_curator_groups.py` (P4) | 69000-69099 |

Каждый файл чистит только свой поддиапазон (урок TD-TGID-56XXX). Хелперы -- `tests/helpers.py`
(`login_user`, `auth_headers`, `cleanup_range`); verified-мастер -- через тот же путь, что в
`test_master_students.py::_make_verified_master`, suspended -- через `revoke_master`, не через
ручную правку JSONB (иначе тест проверяет не то состояние, которое бывает в проде).

**Правило приёмки «нет X» в паре с «есть Y».** Каждый тест «посторонний получает 404» идёт в
паре с «участник получает 200 и непустой ростер» на тех же данных; «после accept у нового
куратора нет member-строки» -- в паре с «у прежнего куратора есть `kind=master`»; в P5
каждое «не видит» -- в паре с «участник целевой группы видит и бронирует» на той же практике.

---

## 10. Кандидаты в KNOWN CEILING (маркер ставится в коде на последствие, шесть пунктов)

1. **Многоразовая ссылка вместо адресного приглашения** **[РЕШЕНИЕ Q-INV=А]**. Механика:
   любой, кому переслали ссылку, вступает; защита -- отзыв ссылки и удаление участника.
   Триггер расконсервации: первый случай нежелательного вступления ИЛИ запрос куратора
   «пригласить конкретного мастера». Форма фикса: таблица адресных приглашений со статусами
   + comms-тип. Отвергнуто: проверка «только если куратор заранее указал user_id» -- это и
   есть адресное приглашение, половинки не бывает.
2. **Suspended мастер-участник скрыт, но не удалён** **[РЕШЕНИЕ Q-SUSP=А]**. Триггер: владелец
   требует явного исключения при ревоке. Форма: удаление строки в `revoke_master` с записью
   в advisory. Отвергнуто: отдельный статус членства -- вторая копия факта «verified»,
   разъедется.
3. **Предложение передачи и вступления без уведомления** **[СТАВКА Q-NOTIF]**. Адресат узнаёт
   о предложении, только открыв приложение. Триггер: появление comms-типов из раздела 7.
   Форма: outbox-событие в существующий relay + тип в `comms-profile`. Отвергнуто: свой push
   -- запаркован владельцем (`docs/owner-parked-roadmap.md`).
4. **Адресат передачи -- только мастер-участник той же группы** **[РЕШЕНИЕ Q-TR1=ок]**.
   Триггер: запрос «передать мастеру, которого нет в группе». Форма: снять проверку
   членства, оставить «verified сейчас». Отвергнуто: передача любому мастеру платформы по
   user_id -- адресат получает предложение от незнакомца без контекста.
5. **Одна аудитория на практику** (P5): «мои ученики + школа» одной практикой нельзя.
   Триггер: такой запрос от мастера. Форма: список kind'ов вместо одного значения с OR
   между ветками предиката. Отвергнуто: булевы флаги на практике -- плодят комбинации,
   которые предикат должен знать поимённо.
6. **Осиротевшая практика «для группы» не расширяется и не блокирует действий** (P5,
   **[РЕШЕНИЕ 2026-08-22]**). Триггер: владелец меняет решение. Форма: либо 409-guard по
   образцу ruling'а 2026-07-25, либо авто-перевод в public с уведомлением. Отвергнуто
   сейчас: оба -- первое даёт участнику вето на действия куратора, второе молча открывает то,
   что мастер закрывал.

---

## 11. Решения владельца и ставки

**Решения (внесены):** Q-INV=А, Q-GRANT=Б, Q-MULTI=А, Q-ROSTER=А, Q-SUSP=А, Q-TRANSFER=Б,
Q-NAME=А, Q-ADMINLIST=А, Q-MORE=А, Q-P5=А (отдельная фаза после P4), P5-эдж = fail-closed +
предупреждение, Q-DEL=удаление группы не блокируется, Q-ADV=advisory перед выходом/удалением,
Q-TR1..TR3=ок, Q-MOCK=без макетов, Q-ADMINDEL=админ группы не удаляет, место файла
`docs/tz-curator-groups.md`.

**Ставка с дефолтом (молчание = принято):**

| Q | Вопрос | Ставка | Альтернатива |
|---|---|---|---|
| Q-NOTIF | Уведомление адресату передачи в v1 | нет; `curator_group.transfer_offered` -- первый кандидат фазы 2 | тип в `comms-profile` + outbox-событие в P4; зависимость от стороны comms и ритуала деплоя |

---

## 12. Чего я не смог установить и почему

- **Макеты.** Решено: не будут (Q-MOCK). 6.2-6.3 и 8.5 описывают состав и данные экранов;
  визуал -- реюз DS.
- **Фильтр `is_active` в ростерах.** Не читал тело `list_group_members` целиком; правило в 5.4
  («повторить прецедент») -- по принципу «не изобретать, чего нет в прецеденте», а не по
  проверенному факту.
- **`full_cleanup_range` vs `cleanup_range`.** Какой из двух хелперов нужен новым файлам --
  зависит от того, какие таблицы они засевают; решается в хэндоффере по телу `tests/helpers.py`.
- **Наследование аудитории у детей серии после PATCH родителя.** В 8.5 зафиксировано как
  «зеркало существующего для `groups`» без пересказа: тело этой ветки `series_service` /
  `service.py` (строки про INHERITS/REFUSED) я читал фрагментами, формулировать правило по
  фрагментам не стал. Исполнитель P5 сверяет по телу и повторяет один в один.
- **Аудит действий.** Тело `core/audit.py` не читал; кураторские действия -- обычные
  мастерские мутации, structlog (P-10) по прецеденту `groups_service`; отдельного аудита в ТЗ
  не требуется, и это не утверждение о том, что его там нет.
- **Кто ведёт comms.** В документах проекта эта сторона названа именем «Zod» (36 файлов);
  владелец его не опознал. Для ТЗ важен только факт отдельного стека; имя в документе не
  используется.
