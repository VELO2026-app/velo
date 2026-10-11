# Нагрузочные тесты VELO — раннбук владельца

Цель — только сервер `dev` (`https://api.zxcvbnm.beer`). Сценарии запускаются
с Mac из клона репозитория, на сервер не едут. Любой другой адрес сценарий
отвергает до первого запроса.

Порядок на сегодня и примерное время:

| шаг | что | время |
|---|---|---|
| 1 | k6 на Mac | 5 мин |
| 2 | профиль посева на `dev` (сегодня!) | 10 мин |
| 3 | прогрев: 2000 входов | ~25 мин (4 запуска) |
| 7 | **тест 3 — до 00:00 UTC** | 5 мин |
| 8 | тест 4 — гонка за места | 3 мин |
| 4 + 6 | тест 1 — излом, с цифрами сервера (тест 6) | до 30 мин |
| 5 | тест 2 — рабочая нагрузка | 15 мин |
| 9 | тест 5 — час | 60 мин |
| 10 | уборка | 1 мин |

Тест 3 стоит раньше остальных из-за часов: см. шаг 7.

---

## 1. k6 на Mac (закреплённая версия v2.3.0)

Версия закреплена: v2.3.0, опубликована 2026-09-21. Не ставьте через `brew` —
он поставит последнюю.

```
uname -m
```

Если `arm64` (Apple Silicon):

```
cd ~/Downloads
curl -LO https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-macos-arm64.zip
shasum -a 256 k6-v2.3.0-macos-arm64.zip
```

Сумма обязана быть
`b2417a3038edc5fe81dc178a889237724b595c5c9cfed875822008e46e862c7d`. Не совпала —
дальше не идти.

```
unzip k6-v2.3.0-macos-arm64.zip
sudo mv k6-v2.3.0-macos-arm64/k6 /usr/local/bin/k6
k6 version
```

Если `x86_64` (Intel): то же с `k6-v2.3.0-macos-amd64.zip`, сумма
`c83bb16f54f0676afa4ea235fd757f3892d307dbd1bd201450de83af31986654`.

`k6 version` должен напечатать `k6 v2.3.0`.

## 2. Профиль посева на `dev` — СЕГОДНЯ

Профиль `backend/scripts/seed_profiles/11102026-loadtest.json` едет в образе.
Сервер `dev` следит за веткой `dev`, поставка идёт в `test`:

1. после выката поставки в `test` перенесите её в ветку `dev`;
2. на сервере `dev`: `velo update`;
3. там же: `velo seed --profile 11102026-loadtest` (без `--reset`).

**Сеять сегодня**, в тот же UTC-день, что и тест 3: практики «start 1..3» стоят
на 00:00 UTC следующего дня, окно чек-ина — весь UTC-день посева.

Профиль даёт 11 мастеров, 100 практик ленты (без лимита мест), 3 копии гонки
(«race 1..3», по 20 мест) и 3 копии «начала» («start 1..3»). Копии одноразовые:
каждый прогон теста 3 или 4 тратит одну, сценарий сам берёт первую нетронутую.

## 3. Прогрев: входы учеников и файл сессий

Все команды на Mac — из каталога `loadtest/` клона.

```
cd loadtest
umask 077
export BASE_URL=https://api.zxcvbnm.beer
read -s BOT_TOKEN
```

После `read -s` вставьте токен бота `dev` и нажмите Enter. На экране он не
появится и в историю шелла не попадёт. Затем:

```
export BOT_TOKEN
k6 run 00-warmup.js
```

Один запуск — не больше 500 входов, около 6 минут, темп ~86 в минуту (лимит
сервера 100 в минуту с одного IP). Повторяйте `k6 run 00-warmup.js`, пока в конце
не будет строки `missing: 0` — это 4 запуска.

Повторный запуск не плодит сессий: живые проверяются через `GET /users/me`,
входят только недостающие.

**Файл `.state/sessions.json` — секрет:** токены на 30 дней. Он в `.gitignore`,
никуда не пересылается, на шаге 10 удаляется. Токен бота нигде не сохраняется.

Цифра для отчёта «стоимость входа» — строка `login_duration` (med и p95) в
выводе прогрева и в `results/00-warmup-summary.json`.

## 4. Тест 1 — излом (и тест 6 параллельно)

Сначала запустите на сервере сбор цифр (шаг 6, пункты «до теста» и «во время
пика»), потом на Mac:

```
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/01-break.html k6 run --out csv=results/01-break.csv.gz 01-break.js
```

Живые графики открываются в браузере на `http://localhost:5665`.

Ступени: 50, 100, 200, 400, 800, 1600 одновременных учеников. Каждая длится
4,5 минуты: 30 с разгон, 60 с на установление (не судится), 3 минуты замер.
Сценарий **сам останавливается** на первой ступени, где p95 > 500 мс или ошибок
сервера больше 1 %, через 90 с её замера. Это и есть излом.

В конце печатается таблица по ступеням, строка `break point` и строка
`STEADY_VUS ... (60 %)` — это число нужно для тестов 2 и 5.

Остановка по порогу печатается как `thresholds ... crossed ... stopping test
prematurely`. **Это штатный исход**, а не поломка.

## 5. Тест 2 — рабочая нагрузка, 15 минут

Подставьте число из строки `STEADY_VUS` теста 1 (пример: при изломе 400 —
`STEADY_VUS=240`):

```
STEADY_VUS=240 K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/02-steady.html k6 run --out csv=results/02-steady.csv.gz 02-steady.js
```

Без `STEADY_VUS` сценарий отказывается стартовать.

## 6. Цифры с сервера (тест 6 и «до/после» каждого теста)

Всё ниже — **только чтение**. Команды выполняются в ssh-сессии на сервере
`dev`.

### 6.1. В `velo db connect` — до и после КАЖДОГО теста

Откройте `velo db connect` и вставьте блок целиком:

```
SELECT now() AS at,
       (SELECT deadlocks FROM pg_stat_database WHERE datname = 'velo') AS deadlocks,
       (SELECT count(*) FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS outbox_pending,
       (SELECT count(*) FROM outbox_events WHERE dead_lettered_at IS NOT NULL) AS outbox_dead,
       (SELECT count(*) FROM outbox_events) AS outbox_total;
```

Строку результата перепишите или скопируйте в заметку с пометкой «до теста N»
или «после теста N».

### 6.2. Узкое место — объём леджера мастеров (до теста 2 и после теста 5)

В той же сессии `velo db connect`:

```
SELECT u.telegram_id, count(ml.id) AS ledger_rows
FROM users u
LEFT JOIN master_ledger ml ON ml.user_id = u.id
WHERE u.telegram_id BETWEEN 600901 AND 600911
GROUP BY u.telegram_id
ORDER BY u.telegram_id;
```

### 6.3. Во время пика теста 1 и всё время теста 5 — CPU и память

Во втором ssh-окне перед стартом теста один раз выполните:

```
nproc; free -m
```

Затем запустите сбор:

```
while true; do docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' velo-app velo-postgres velo-redis comms-app comms-worker comms-consumer comms-postgres comms-redis | sed "s/^/$(date -u +%H:%M:%S),/"; sleep 5; done | tee /tmp/loadtest-stats-$(date -u +%H%M).csv
```

Остановка — Ctrl+C после теста. Файл `/tmp/loadtest-stats-<время>.csv` передайте
Диспетчеру (scp тем же адресом, каким вы заходите по ssh).

`docker stats` считает CPU от одного ядра: 250 % — это 2,5 ядра из `nproc`.

### 6.4. Во время пика теста 1 — соединения Postgres

В третьем окне, в `velo db connect`:

```
SHOW max_connections;
SELECT now(), state, count(*) FROM pg_stat_activity WHERE datname = 'velo' GROUP BY state ORDER BY state \watch 5
```

Перед Ctrl+C скопируйте самые большие значения с экрана.

### 6.5. Сразу после тестов 1 и 4 — отказы по исчерпанию пула

```
docker logs velo-app --since 30m 2>&1 | grep -c "QueuePool limit"
docker logs velo-app --since 30m 2>&1 | grep -c "unhandled_exception"
```

Первое число — запросы, не дождавшиеся соединения с базой за 30 с (ответ 500).
Второе — все необработанные 500 за то же время. Это и есть разделение «отказ
пула» и «прочие 500»; ошибки данных проверяет SQL шага 8.

## 7. Тест 3 — пик перед началом практики — ДО 00:00 UTC

> **ТЕСТ 3 ГОНЯЕТСЯ ДО 00:00 UTC ДНЯ ПОСЕВА — ЭТО 02:00 ПО АМСТЕРДАМУ.**
> В 00:00 UTC практики «start 1..3» начинаются, окно чек-ина закрывается, и
> повторить тест 3 на этом стенде будет нельзя до переустановки: посев не
> пересоздаёт уже существующие практики.

Сначала подготовка — запись 300 учеников, около 30 с:

```
k6 run 03a-start-prepare.js
```

В конце должно быть `now has 300 participants (need 300)`.

Затем, сразу, сам пик — 300 учеников за 60 с делают чек-ин и вход:

```
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/03-start.html k6 run --out csv=results/03-start.csv.gz 03b-start-burst.js
```

До и после — блок 6.1. Строки `start_no_url` и `start_no_booking` должны быть
нулевыми.

## 8. Тест 4 — гонка за места

```
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/04-race.html k6 run --out csv=results/04-race.csv.gz 04-race.js
```

500 учеников открывают соединение, ждут общий момент (60 с) и одновременно
бронируют практику на 20 мест. До и после — блок 6.1; сразу после — 6.5.

Сразу после теста в `velo db connect` вставьте блок целиком:

```
SELECT p.title, p.max_participants, p.current_participants,
       count(b.id) FILTER (WHERE b.status IN ('pending', 'confirmed')) AS active_bookings,
       count(DISTINCT b.user_id) FILTER (WHERE b.status IN ('pending', 'confirmed')) AS distinct_students,
       count(b.id) AS all_booking_rows
FROM practices p
LEFT JOIN bookings b ON b.practice_id = p.id
WHERE p.title LIKE '[load] race %'
GROUP BY p.title, p.max_participants, p.current_participants
ORDER BY p.title;

SELECT p.title, count(pu.id) AS purchases
FROM practices p
LEFT JOIN purchases pu ON pu.practice_id = p.id
WHERE p.title LIKE '[load] race %'
GROUP BY p.title
ORDER BY p.title;
```

У израсходованной копии ожидается: `active_bookings = 20`,
`distinct_students = 20`, `all_booking_rows = 20`, `purchases = 20`.

## 9. Тест 5 — час под рабочей нагрузкой

`STEADY_VUS` — то же число, что в тесте 2. Сбор 6.3 должен идти весь час.

```
STEADY_VUS=240 K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/05-hour.html k6 run --out csv=results/05-hour.csv.gz 05-hour.js
```

До и после — блоки 6.1 и 6.2.

## 10. После тестов

```
rm .state/sessions.json
```

Каталог `results/` целиком передайте Диспетчеру. В нём нет ни токенов, ни
`setup_data`. Затем — переустановка `dev`, когда решите (сброс посева на базе с
бронями нагрузки падает, BE-119).

---

## Если что-то пошло не так

| сообщение | что значит | что делать |
|---|---|---|
| `REFUSED: BASE_URL ...` | адрес не `https://api.zxcvbnm.beer` (ровно так, без `/` в конце) | `export BASE_URL=https://api.zxcvbnm.beer` |
| `REFUSED: no sessions` / `needs N sessions` | прогрев не закончен | шаг 3 до `missing: 0` |
| `401 ... sessions file no longer matches` | Redis сброшен или стенд переустановлен | удалить `.state/sessions.json`, шаг 3 заново |
| `REFUSED: no "[load] feed" practices` | профиль не засеян на `dev` | шаг 2 |
| `REFUSED: no unused "[load] start N"` | после 00:00 UTC или все три копии потрачены | тест 3 на этом стенде больше не идёт |
| `REFUSED: no unused "[load] race N"` | все три копии гонки потрачены | тест 4 больше не идёт |
| `warmup: rate limited` | 100 входов в минуту с IP исчерпаны | подождать минуту, `k6 run 00-warmup.js` снова |

## Необязательно (сегодня не делаем)

**«Один мастер — худший случай».** Каждая бронь берёт строку мастера на
блокировку и пересчитывает весь его леджер. Поэтому если вся лента принадлежит
одному мастеру, брони выстраиваются в одну очередь. Прогон требует варианта
профиля, где все 100 практик ленты у одного мастера; в эту поставку он не
входит.

## Что где

| файл | что |
|---|---|
| `00-warmup.js` | входы учеников, файл сессий, стоимость входа |
| `01-break.js` | тест 1, излом по ступеням |
| `02-steady.js` / `05-hour.js` | тесты 2 и 5, постоянная нагрузка |
| `03a-start-prepare.js` / `03b-start-burst.js` | тест 3 |
| `04-race.js` | тест 4 |
| `lib/` | общий код: охрана адреса, `initData`, классификация ошибок, смесь «живой ученик» |
| `REPORT.md` | шаблон отчёта для инвестора (заполняет Диспетчер) |
