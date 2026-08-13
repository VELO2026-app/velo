# T-26 — student notification preferences: recon record

> **Read-only reconnaissance, no code changed.** Run as `PROMPT №699` by Orchestrator-85,
> lean-graded by Navigator-44 and cross-checked by Navigator-43, 2026-08-13.
> Measured against `test` @ `37c8ad18` (velo) and `3ae63aa` (comms, read-only clone at
> `D:/02_Projects/comms`).
> ⚠ **Every figure and every `file:line` here was true at the moment it was measured. Re-derive
> before acting on one** — this document exists so the board does not have to carry the detail,
> not so the detail can go unchecked.
> The board (`Agent-Velo/DS-build-plan.md`, section E) keeps only what must be known BEFORE
> acting and points here.

## 1 · Why this task exists

A student has four notification switches. They save, they survive relogin, and they silence
nothing. **The user mutes and is not muted.**

The store is `credentials["notifications"]` — a JSONB sandbox, **not a column**
(`backend/app/modules/users/schemas.py:35-40`, `_NOTIFICATION_DEFAULTS`, four keys all
defaulting to `True`). The code is honest about it: the comment at `schemas.py:30-34` marks push
delivery as *not wired yet*.

## 2 · The velo side, end to end (MEASURED)

**Writes — one path only:** `NotificationSettingsUpdate` (`users/schemas.py:57-67`) →
`UserUpdate.notifications` (`:595`) → key-by-key merge onto the JSONB blob
(`users/service.py:99`, `:160-168`, `None` skipped) → `PATCH /api/v1/users/me`
(`users/router.py:106`). The **only production writer** is
`frontend/src/views/user/NotificationsView.vue:88`.

**Reads — one path only:** `UserResponse.notifications` (`users/schemas.py:455-469`,
schema-on-read with defaults merged under the stored bools) → `generated.ts:1564`, where the
field is declared **non-optional** → `NotificationsView.vue:70-76` paints the switches.

**Consumers at delivery time: ZERO.** Nothing outside `users/` reads the blob.
The negative check and what it would have missed: a grep for the three named keys across
`backend/` returned 35 hits — 12 the definition, 18 tests, and **5 false positives** where the
substring `practice_reminders` lives inside the function name `cancel_practice_reminders`
(`core/events/reminders.py:187`, `practices/cancel_service.py:154,195`,
`practices/service.py:1607,1642`). Adjudicated by reading each matched line.

**The structural reason there cannot be a consumer:** velo does not decide delivery at all.
Every notification leaves through `emit_notification` (`core/events/notify.py:60`), which writes
an outbox row with `type` / `target` / `channels` and **consults no user preference of any kind**
(`notify.py:98-114`). The mute decision is taken inside comms, twice — at resolve time
(`comms app/engine/service.py:254-273`) and again as a late-mute re-check at deliver time
(`:390-422`).

**Conclusion (MEASURED): the four toggles are a write-only store.**

## 3 · The proxy as it exists today (MEASURED)

`backend/app/modules/comms_proxy/` is two files; `router.py` exposes six routes under
`/api/v1/notifications` (`:57`). **The prefs endpoint is NOT absent** — it is live, deployed, and
already has a production frontend consumer.

| velo route | forwards to comms | repacked? |
|---|---|---|
| `GET ""` (`:84`) | `GET /api/v1/recipients/{uid}/inbox` | no |
| `GET /unread-count` (`:99`) | `…/inbox/unread-count` | no |
| `POST /read-all` (`:110`) | `…/inbox/read-all` | no |
| `POST /{delivery_id}/read` (`:121`) | `…/inbox/{id}/read` | no |
| `GET /prefs` (`:197`) | `GET /api/v1/recipients/{uid}/preferences` | **yes — `schedule` only** |
| `PUT /prefs` (`:209`) | `PATCH …/preferences` | **yes — `schedule` only** |

**"Passthrough" stated precisely, because the queue line's condition depends on it.** It is
**not byte-for-byte**: `comms_request` parses the response as JSON (`core/comms.py:150`) and
FastAPI re-serialises it. **Structural** identity holds for the four inbox routes. `/prefs` is
deliberately repacked at exactly one key — `_quiet_to_delivery` / `_delivery_to_quiet`
(`comms_proxy/router.py:166-194`) swap `schedule.from` / `schedule.to`, because comms stores a
QUIET window while the velo UI speaks a DELIVERY window. `categories` and `timezone` pass
through untouched. Error bodies are repacked too (`core/comms.py:125-147`): only
`{400,404,409,422}` are forwarded and only `detail` survives; 401/403 map to 502 so a bad
service token cannot log out every user; 5xx → 502, timeout → 504.

Sibling forwarder, outside T-26 but sharing the client and trust model: `chats/router.py` calls
`comms_request` at six sites (`:279,568,615,636,651,667`).

## 4 · The comms contract, read from the source (MEASURED)

`GET` / `PATCH /api/v1/recipients/{recipient_id}/preferences` (`comms app/api/prefs.py:95-99`),
service-token auth. **Comms performs no per-recipient authorization** (`prefs.py:66-73`) — the
product proxy owns that check, and velo honours it by stamping the id server-side and rejecting a
client-supplied `recipient_id` with 400 (`comms_proxy/router.py:62-68`).

```
GET  -> {"categories": {"<cat>": bool, ...},   # true = ENABLED, alphabetical
         "schedule": {"from":"HH:MM","to":"HH:MM","days":[...]} | null,
         "timezone": "<IANA>" | null}          # READ-ONLY, sync-owned
        404 when the recipient has never been synced
PATCH  {"categories"?: {...}, "schedule"?: {...} | null}  -> returns the full GET form
```

Three claims the board carried, verified per item:

1. **`categories` is PARTIAL — CONFIRMED.** `prefs.py:247-256` iterates only the keys present in
   the body. Unlisted categories are untouched. An unknown category raises `ValidationError`
   (`audience/prefs.py:71-78`) and the PATCH is one transaction, so a bad key rolls back the
   valid toggles beside it.
2. **`schedule` is a FULL replace, `null` clears — CONFIRMED, with a THIRD state the board did
   not name.** Presence is read via `model_fields_set` (`prefs.py:258`): omitted = untouched,
   `null` = clear, object = full replace. `ScheduleIn` requires all three fields with
   `extra="forbid"` (`:136-144`); partial window / `from == to` / empty `days` / days outside
   ISO 1..7 / sub-minute times all → 422.
3. **Unknown body keys → 422, `timezone` included — CONFIRMED.** `PreferencesPatch` sets
   `extra="forbid"` (`prefs.py:171`); comms' own `ValidationError` maps to 422 at
   `app/api/errors.py:54-63`. Velo mirrors the rule independently (`comms_proxy/router.py:157`)
   and rejects before the seam is reached (`backend/tests/test_comms_t1.py:398-408`, which
   asserts `seam.assert_not_awaited()`).

**The category vocabulary is OURS.** Comms hardcodes none — `registry.registered_categories()`
is built from the product profile (`audience/prefs.py:16-21`), and the profile is
`velo/comms-profile/types.yaml`. Derived from it: **22 type keys, 18 carrying a category, 4
carrying none** (`master.verified`, `master.rejected`, `master.application_received`,
`system.announcement` — non-mutable by mechanism, since a category-less type bypasses the gate).

| category | types | reaches a student? |
|---|---|---|
| `bookings` | 7 | yes |
| `reminders` | 5 (incl. `prompt.leave_review`, `prompt.leave_feedback`) | yes |
| `finance` | 3 | yes |
| `msg_participants` | 2 | yes |
| `msg_support` | 1 | **no — master-only in velo** |

> ⚠ A first pass over `types.yaml` returned all 22 keys as "category-less", because the pattern
> matched every key line whether or not a `category:` followed. Re-derived by reading the line
> after each key. Recorded because the shape of that error will recur on this file.

## 5 · THE MAPPING — the decision-relevant finding

**Not 1:1, not many:1. Three different relations at once, and one toggle has no comms dimension
at all.**

| velo toggle | comms category | relation |
|---|---|---|
| `push` | **NONE** | **no axis exists** |
| `practice_reminders` | `reminders` | 1:1 by name, **wider in fact** — the category also carries the two post-practice prompts |
| `master_messages` | `msg_participants` | 2:1 collapse ↓ |
| `support_messages` | `msg_participants` | 2:1 collapse ↑ |

**`push` names a CHANNEL, and comms preferences have no channel dimension.**

> ⚠ **CORRECTED 2026-08-13 at `№700`, by the executor against its own `№699` wording, and
> re-derived by Navigator-44.** This section first read *"there is no `push` channel to switch
> off"*. **That is false: comms defines `DeliveryChannel.PUSH = "push"`
> (`app/engine/constants.py:80`), alongside `TELEGRAM`, `EMAIL` and `IN_APP`.** What is true is
> narrower and is the load-bearing half: velo never requests it — `DEFAULT_CHANNELS =
> ["in_app", "telegram"]` (`core/events/notify.py:51`) — and **the preference model has no
> channel axis at all.** The wrong sentence would have sent the next reader looking for a switch
> in the wrong place.

Measured per file rather than by basename, because a first pass collapsed two files both named
`constants.py` under one label: `app/api/prefs.py`, `app/audience/{__init__,models,prefs,
quiet_hours,sync}.py` → **0** hits for `channel`; control `app/engine/constants.py` → **6**.
The preference model is (recipient × category) plus one quiet window.
**No new CATEGORY can fix `push`; the missing axis is CHANNEL, and it is not ours to add.**

**The two message toggles collide.** Comms assigns the category by thread SIDE, not by who wrote
(`comms app/notifier.py:193-234`): the **client** gets `msg.participant_message` →
`msg_participants`; the **assignee** gets `msg.support_message` → `msg_support`. A student is
the client of every thread they are in (`chats/router.py:24-29`, `chats/models.py:47-51`), so
both a master's message and a future support agent's message arrive in the SAME category.
**Flipping either toggle off would silence both.** The master screen already had to relabel its
rows after finding its old labels "said the opposite of what the toggles do"
(`MasterNotificationsView.vue:145-153`).

Compounding it: **`support_messages` names a feature that does not exist on the velo side** —
`chats/router.py:21-22`, "this proxy has no section threads"; support chat is blocked on comms
building `POST /sections`.

**Categories with no student toggle:** `bookings` (7 types) and `finance` (3 types). A student
today cannot mute booking confirmations, practice cancellations, waitlist offers or wallet
events, and no switch on the screen claims otherwise.

## 6 · Identity (MEASURED)

**The velo `User.id` UUID IS the comms `recipient_id`** — no surrogate, no mapping table
(`core/events/sync.py:67-68`; comms agrees at `app/audience/sync.py:92-94`, "shared id-space,
Model B"). The proxy stamps it server-side from the session
(`comms_proxy/router.py:76`).

Established by a `user_upserted` outbox event (`sync.py:62-91`) emitted from two sites:
`auth/service.py:314` — **on every login**, not only creation, so the idempotent snapshot
self-heals projection drift — and `users/service.py:209-210` on a PATCH touching
`language`/`timezone`/`email`.

Reaching the settings screen requires an authenticated session, so the event is always emitted.
**ASSUMED, and not certifiable from this repo (`FLEET-CONVENTIONS §2.16` — the repo is not the
machine): that the outbox relay is running on the stand.** The contract models the failure
honestly: an unsynced recipient yields 404, forwarded verbatim (`comms_proxy/router.py:203`),
and the master screen already degrades on it (`MasterNotificationsView.vue:241-247`).

## 7 · Storage: no direction needs a migration (MEASURED)

`ls backend/migrations/versions/ab*` → empty. **The `ab…` prefix has never been used**; 53
migration files, non-hex prefixes in use are `t24m…` (2), `hr30…` (1), `t2a…` (1).

Because `credentials` is already JSONB and schema-on-read (`users/schemas.py:10-17`, the pattern
chosen precisely so preference keys need no DDL), **every candidate direction is DDL-free.** A
one-shot data migration to strip orphaned sub-objects would be a *choice*, not a requirement.

**The expensive consequence is a contract break, not a migration.** `generated.ts:1564` declares
`notifications: NotificationSettings` **non-optional**. Removing the field from `UserResponse`
regenerates that file (autogen, no-touch, owned by the deploy bot) and breaks the type across
**15 frontend files** that actually supply it. That is a `vue-tsc` cost, not an `alembic` one.

> ⚠ **THE COUNT WAS 18 IN `№699` AND IT WAS WRONG — corrected at `№700` by the executor against
> its own figure.** 18 was files containing the string `notifications:`, which swept in
> `generated.ts`, `MasterShell.vue` and `NotificationsView.vue`. **15 files supply the field**, in
> three forms: 7 × `notifications: {} as UserResponse['notifications']`, 7 × a full literal, and
> 1 × `notifications: null` (`ChatThreadScreen.test.ts:66`). **The `as UserResponse[…]` form
> breaks twice** — TS2339 on the indexed access on top of the excess-property error — so those
> seven are rewritten, not merely trimmed.

### 7a · THE DEPLOY TYPECHECKS, AND THE REGEN LANDS BEFORE IT IN THE SAME RUN

**MEASURED at `№700`, and it decides the commit ordering.** Inside one `velo update`:
pytest against the live DB (`scripts/velo-manage.sh:1318`) → fetch `openapi.json` (`:1356`) →
regenerate `generated.ts` (`:1363`) → **velo-bot commits and pushes it** (`:1387-1421`) → then
the frontend image build.

`scripts/velo-manage.sh` invokes `vue-tsc` **zero** times — and that zero is a FALSE ALL-CLEAR if
read alone (control: `npm run` appears 3 times in the same file). **The typecheck lives in
`frontend/Dockerfile:40`: `RUN npm run build`, and `npm run build` = `vue-tsc --noEmit && vite
build`** (`frontend/package.json`). The Dockerfile says so itself at `:10-11` — *"if tests fail,
image is not built. This is the gate for `velo update`."* `npm run test` is `vitest run` alone and
strips types, so **only the build step catches a type error.**

**Consequence: a commit that leaves the fixtures stale does not merely go red on origin — it
FAILS THE DEPLOY at the frontend image build, after the backend has migrated and after the bot
has already pushed a commit.** Conversely a commit that retires the field AND fixes all 15
fixtures is red locally (`generated.ts` still declares it) and **GREEN on the server**, because
the regen has already landed by the time `vue-tsc` runs. The running container only changes on a
successful build, so a failed build leaves testers on the working stand either way.

## 8 · Test surface (MEASURED)

Toggles: `backend/tests/test_users.py:600-720` · `test_master_notifications.py:300-460` ·
`frontend/src/views/user/NotificationsView.test.ts` (9 `it()`).
Proxy seam: `test_comms_t1.py:306-338` (session-derived id, client-supplied id → 400, seam never
awaited) · `:340-408` (quiet↔delivery both ways, unknown key → 422 before the seam) · `:410-490`
(unconfigured → 502, timeout → 504) · `MasterNotificationsView.test.ts` (20 `it()`).

**What has ever executed: the backend half, only on the deploy.** The local gate is down and was
proven by live traceback, not repeated from a note: `python -c "import app.core.config"` from
`backend/` raises `ValidationError … redis_password … extra_forbidden`. The key is present at
`backend/.env:32`; `config.py` declares no such field. `conftest.py` imports through it, so **no
backend test in this repo can execute locally.** The 1053-green figure is from the stand and is
**ASSUMED here** — not read off the box during this recon.

Gaps any build must close: a seam test for whichever mapping is chosen · **a test for the
two-toggles-one-category collision, which nothing anywhere asserts today** · a test for whatever
`push` becomes · a 404 test for the student screen when the recipient is unsynced · and, if the
local store is retired, the 18 fixtures in the same change or `vue-tsc` fails.

## 9 · Corrections made during this recon

Three premises in the recon prompt were wrong and were corrected by the executor:

1. `backend/app/main.py:82` is the **import**; the mount is `main.py:301`.
2. The `NOT wired yet` comment spans `users/schemas.py:30-34`, not `:32-34`.
3. **The prefs endpoint is not absent.** It is live, mounted, deployed, and consumed in
   production by `MasterNotificationsView.vue:227,252,284` via the hand-written
   `frontend/src/api/notifications.ts` (last touched `df77e4e4`, 2026-08-07).

Two further items found at lean-grade:

4. **A mis-pathed citation inside a piece of evidence.** The channel control was offered as
   `app/core/constants.py:71`. That file exists (121 lines) but returns **0** for `channel`;
   `DeliveryChannel` is at **`app/engine/constants.py:71`**, where the control fires at 6. Run as
   written the control does **not** fire and the zero it vouches for is unearned. The finding
   survives on the corrected path. *(Re-derived independently. A wrong path inside evidence
   propagates further than a wrong number, because the next reader runs it.)*
5. **"The client is always a student" is FALSE, and a mapping that assumes it will mis-address a
   real case.** `POST /chats` (`chats/router.py:380`) gates the **target** — `master_id` must be
   a verified master (`:403`, 404 otherwise) — and rejects self-chat (`:396`). **Nothing gates
   the caller's role**, and `_create_or_get_thread(session, client_id=user.id, …)` (`:410`) makes
   the CALLER the client unconditionally. So a master who opens a chat with another master is the
   client of that thread and is pinged with `msg.participant_message`. *"The student is always
   the client" is safe; its converse is not.*

> Method note kept because the shape will recur: a per-file probe written as
> `grep -c … || echo 'NO FILE'` cannot tell **0 matches** from **no file** — `grep -c` exits 1 on
> zero matches and 2 on a missing file, so the fallback fires for both. Caught by reading the
> output instead of the number.

## 10 · The fork — UNRESOLVED, the owner's to rule

The question is **not** "where should truth live". That was answered for the master on
2026-08-07, and its execution left the store below orphaned. The live question is **what the
four rows on the student screen should BECOME**, given that two of them cannot mean what they
say under any implementation.

- **A — migrate the student screen to comms, as the master's was.** The mute becomes real for
  what can be expressed; `push` is dropped or redefined; the two message rows become one;
  `bookings` and `finance` remain unmutable with no row. Contract break across 15 files.
  **RULED BY THE OWNER 2026-08-13 — this is the option that was taken**, with `push` redefined as
  silence-everything rather than deleted. B and C below are kept as the record of what was
  weighed, not as live alternatives.
- **B — keep four rows and map them.** Preserves the approved screen, but the 2:1 collision has
  only two honest resolutions: both rows write one category (the screen then lies — flipping one
  moves the other, the exact defect the master screen had to relabel to escape), or one row stays
  a stub that silences nothing (today's defect, preserved deliberately).
- **C — grow the profile, then migrate.** `comms-profile/types.yaml` is ours and comms builds its
  vocabulary from it, so a new category is a velo edit. But `msg.participant_message` is a
  comms-native type whose category is fixed by the dispatch plan §6b — splitting the two message
  rows is not unilateral. And **`push` still has no home**, because the missing dimension is
  CHANNEL.

## 11 · The blocker that survives any ruling

**`credentials["master_notifications"]` is an orphaned store the API still serves.** It is still
written by `PATCH /users/me` (`users/service.py:170-197`) and still returned by `GET /users/me`
(`users/schemas.py:473-522`), but **no client writes it any more**: grepping `frontend/src` for
`master_notifications` returns 18 files, all either `generated.ts` type declarations or test
fixtures set to `null`; the control on the four-key path fires at exactly one production site,
`NotificationsView.vue:88`. Four of the master's keys (`new_checkin`, `new_feedback`,
`ai_summary`, `monthly_report`) are not persisted anywhere at all —
`MasterNotificationsView.vue:264-268` returns early without saving.

**It reached that state through exactly the migration T-26 is contemplating.** A ruling that does
not account for it will produce the same result twice.
