# Защита ветки `deploy-machine` (FE-222)

> Состояние на 20.11.2026: у репозитория `VELO2026-app/velo` нет ни одного ruleset (`GET /rulesets` → `[]`), классической защиты `deploy-machine` тоже нет (404). Включены все три способа мержа: merge, squash, rebase. Ruleset применяет админ репозитория (`VeloApp2026` или `inzoddwetrust`), у `sstark21` права только write. Применять его можно после решения владельца по разделу «Прямые пуши бэка» и после согласования с Zodd.

## Обязательные проверки

| Проверка (точное имя) | Workflow | Что значит |
| --- | --- | --- |
| `CI — gate` | `.github/workflows/ci.yml`, джоб `gate` | Сводный джоб. Ждёт все остальные джобы `ci.yml`: `scope`, lint, format, typecheck, три шарда vitest и `test — merge + coverage ratchet`, `test — @velo/ui`, build с бюджетом бандла, `e2e — Playwright smoke`, `e2e-stack` (sweep на настоящем бэке), матрицу редакций, `image`, `generated.ts drift`. Зелёный, если `scope` прошёл, а каждый остальной джоб прошёл или пропущен по размеру PR. |
| `bundle budget guard` | `.github/workflows/bundle-budget.yml` | Правило меток бюджета бандла: поднятый бюджет требует метку `bundle-growth`, поднятый потолок — `bundle-ceiling`. Сам размер проверяет build внутри гейта. |

Обе проверки отвечают на любом PR в `deploy-machine`:

- у `ci.yml` и `bundle-budget.yml` нет фильтра путей, оба запускаются на `opened`, `synchronize` и `reopened`;
- гейт объявлен с `if: always()` и стоит под одним именем. Он запускается после успеха, падения, пропуска и отмены остальных джобов;
- пропуск по размеру PR (только `docs/**` или только `backend/**`) гейт засчитывает как пройденный. Падение выше по цепочке всегда видно как падение: `test` → `test-report`, `matrix-plan` / `matrix` → `matrix-gate`, `scope` проверяется отдельно.

### Почему не отдельные джобы

Пропущенный джоб иногда отчитывается не под тем именем, под которым он проходит:

- reusable workflow: запущенный sweep — это `e2e-stack / e2e-stack — sweep on a real backend`, пропущенный — просто `e2e-stack` (видно на PR #160, только docs);
- матрицы: `matrix — ${{ matrix.cell }}` и `test — vitest shard ${{ matrix.shard }}/3` в пропущенном виде, `matrix — golden/ai` в запущенном;
- у `visual — base vs head` имя с выражением, поэтому он остаётся информационным (`docs/agents/e2e.md`).

Если сделать обязательным «запущенное» имя, PR, который этот джоб пропускает, навсегда повиснет в «Expected». Гейт этой ловушки избегает: у него одно имя, и он запускается всегда. Ещё одна причина: переименование или новый джоб не требуют правки ruleset. Новый джоб нужно добавить в `needs` гейта, иначе упадёт `.github/scripts/ci-gate.test.mjs` в джобе `scope`.

### Что не обязательно и почему

- `visual — base vs head` информационный по решению владельца, и его имя нестабильно (см. выше).
- `backend -- pytest (full suite, backend image)` (`backend-tests.yml`) запускается только при изменениях бэка (`paths`). Если сделать его обязательным, он повиснет на любом фронтовом PR. Если Zodd захочет сделать его обязательным, нужен тот же приём, что у гейта: workflow без `paths`, решение о запуске внутри джоба.
- `pridem check -- the repository as the deploy machine reads it` (`primer-check.yml`) запускается на каждом PR в `deploy-machine`, так что технически может быть обязательным. Это проверка бэка и деплой-машины, решение за Zodd. Чтобы добавить её, допишите имя в `required_status_checks`.

## Ruleset

Два ruleset, потому что обход (`bypass_actors`) задаётся на весь ruleset, а не на отдельное правило. Запреты на удаление и force-push не обходит никто. Обход для PR и проверок есть только там, где он нужен.

**A. Ветка** — [`deploy-machine-ruleset-branch.json`](deploy-machine-ruleset-branch.json), обходов нет:

- `deletion` — ветку нельзя удалить;
- `non_fast_forward` — нельзя сделать force-push.

Ни админ, ни ключ записи машины этого не обходят. Если в аварии нужно переписать историю, админ временно выключает ruleset A (команда ниже).

**B. Мерж** — [`deploy-machine-ruleset-gate.json`](deploy-machine-ruleset-gate.json):

- `pull_request` — изменения идут через PR, одобрение не требуется (`required_approving_review_count: 0`), разрешён только merge-коммит (`allowed_merge_methods: ["merge"]`, как сейчас). Squash и rebase в кнопке мержа пропадут.
- `required_status_checks` — `CI — gate` и `bundle budget guard` от GitHub Actions (`integration_id: 15368`: проверку с тем же именем от другого приложения GitHub не засчитает). `strict_required_status_checks_policy: false` — ветке PR не обязательно быть на вершине `deploy-machine`. Оркестратор и так делает update-branch перед мержем, а строгий режим выстраивал бы все мержи в очередь.
- `bypass_actors`:
  - роль Repository admin (`RepositoryRole` 5) и владельцы организации (`OrganizationAdmin`) в режиме `pull_request`. Они могут влить PR с красной проверкой, явно отметив обход в кнопке мержа (это пишется в журнал), но напрямую пушить не могут. Это аварийный выход для варианта (a), см. ниже;
  - deploy key (`DeployKey`, `always`). Машина на сервере роли test при расхождении типов коммитит `generated.ts` от имени `velo-types` (`primer.yaml`, `types.commit_as`) поверх выкаченного коммита и обычным push отправляет его в ветку сервера ключом записи (`pridem/steps/types.py`, DM-63). Без этого исключения push отклонится, и шаг `types` останется несделанным (`incomplete`).

**Остаточный риск обхода через deploy key.** Обход действует для любого deploy key с правом записи, а не только для коммитов `velo-types`. Машина пушит один коммит с одним путём (`types.out`), без `--force`; что ещё может пройти этим ключом мимо гейта, решает машина, а не этот ruleset. Force-push и удаление ключ сделать не может: они в ruleset A. Чтобы закрыть риск совсем, машина должна отправлять `generated.ts` через PR, а не push -- это вопрос к Праймеру, не к этому ruleset.

`sstark21` (write) и агенты фронта в исключения не входят: им PR с красным гейтом не влить.

## Прямые пуши бэка: решение владельца

С 01.11 в `deploy-machine` было 50 прямых коммитов от `inzoddwetrust`, 2 от `velo-bot` и 2 от `sstark21` (02–03.11, до перехода фронта на PR). Через PR влито 45 мержей: 40 от фронта, 5 от бэка. Обязательные проверки в ruleset действуют на любое обновление ветки, а не только на PR: пуш коммита, у которого нет зелёного `CI — gate`, будет отклонён. Значит, прямые пуши без исключения перестанут работать.

| | (a) бэк на PR | (b) бэк в исключениях (bypass) | (c) проверки только для PR, прямой пуш остаётся |
| --- | --- | --- | --- |
| Как задать | A и B как есть (админ в B в режиме `pull_request`) | A как есть; в B у админа режим `always` (команда ниже) | в ruleset нет «только для PR»: правило проверок действует и на пуш. Можно только дать в B обход роли Write, тогда красный PR сможет влить и фронт. Защиты нет |
| Бэк | PR → гейт ~3 мин на PR только с `backend/**` (scope, drift, sweep) → мерж. `backend-tests` (~5–8 мин) идёт параллельно, но не обязателен | пушит как сейчас (fast-forward); CI запускается на пуше уже после факта | как сейчас |
| Фронт | только через зелёный гейт | только через зелёный гейт | на деле не защищён |
| Поломка API бэком | ловит sweep на PR бэка до мержа | доходит до ветки. Дальше sweep краснеет на **каждом** фронтовом PR (PR собирается вместе с текущим бэком), и очередь фронта стоит, пока бэк не починит | то же, что (b) |
| force-push и удаление | запрещены всем (ruleset A) | запрещены всем (ruleset A): обход админа в B их не касается | запрещены всем (ruleset A) |
| Цена для бэка | привычка к PR и ~3 мин ожидания на коммит; аварийный мерж — с отметкой обхода | нет | нет |

**Рекомендация: (a).** Sweep запускается на бэковых изменениях как раз затем, чтобы переименованное поле не сломало экран. При (b) и (c) поломку бэка увидит первый же фронтовый PR, и блокироваться будет он, а не виновный коммит. Если Zodd не готов перейти на PR сразу, можно начать с (b) и переключиться на (a) позже: ruleset A не меняется, в B меняется только режим обхода админа (команды `PUT` ниже).

## Команды для админа

Выполняются из корня репозитория, под учёткой админа (`gh auth status` должен показать `VeloApp2026` или `inzoddwetrust`).

Ruleset A (одинаков для обоих вариантов):

```sh
gh api --method POST repos/VELO2026-app/velo/rulesets --input docs/ci/deploy-machine-ruleset-branch.json
```

Ruleset B, вариант (a):

```sh
gh api --method POST repos/VELO2026-app/velo/rulesets --input docs/ci/deploy-machine-ruleset-gate.json
```

Ruleset B, вариант (b) (админ пушит напрямую):

```sh
jq '(.bypass_actors[] | select(.actor_type == "RepositoryRole" or .actor_type == "OrganizationAdmin") | .bypass_mode) = "always"' \
  docs/ci/deploy-machine-ruleset-gate.json \
  | gh api --method POST repos/VELO2026-app/velo/rulesets --input -
```

Проверить, что применилось:

```sh
gh api repos/VELO2026-app/velo/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
gh api repos/VELO2026-app/velo/rules/branches/deploy-machine --jq '.[].type'
# deletion, non_fast_forward, pull_request, required_status_checks
```

Сменить вариант ruleset B (ID из первой команды выше; `<ID_B>` — тот, что `PR only, required checks`):

```sh
# (b) -> (a): обход админа только через PR
gh api --method PUT repos/VELO2026-app/velo/rulesets/<ID_B> --input docs/ci/deploy-machine-ruleset-gate.json

# (a) -> (b): обход админа всегда
jq '(.bypass_actors[] | select(.actor_type == "RepositoryRole" or .actor_type == "OrganizationAdmin") | .bypass_mode) = "always"' \
  docs/ci/deploy-machine-ruleset-gate.json \
  | gh api --method PUT repos/VELO2026-app/velo/rulesets/<ID_B> --input -
```

Отключить ruleset в аварии, не удаляя (`<ID>` — A или B):

```sh
gh api --method PUT repos/VELO2026-app/velo/rulesets/<ID> -f enforcement=disabled
```

## Проверка после применения

1. Открыть черновой PR из ветки фронта с намеренно красным джобом (например, сломать формат одного файла). В кнопке мержа должно быть «Required statuses must pass», `gh pr merge` от `sstark21` должен отказать. Закрыть PR, удалить ветку.
2. PR только с `docs/**`: `CI — gate` и `bundle budget guard` зелёные за минуту, мерж доступен.
3. `git push --force` в `deploy-machine` отклоняется у всех, админа включительно (ruleset A).
4. Вариант (a): прямой `git push` в `deploy-machine` отклоняется и у админа.

## Что изменится в работе

- Стопки PR: CI не запускается на PR в ветку, отличную от `test` и `deploy-machine`. После смены базы на `deploy-machine` нужен новый пуш или update-branch, иначе гейт так и не появится. Скрипт `merge-stack.sh` оркестратора уже делает update-branch.
- Скрипты мержа оркестратора ждут `CI — gate`. `e2e-stack` больше не считается информационным.
- `visual` по-прежнему информационный.
- Красный экран в sweep отправляется в карантин только с задачей (`docs/testing.md`, правило 22).
