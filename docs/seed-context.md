# VELO seed_practices_v2 — Complete Project Context (v2.3)

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> ACTIVELY MISLEADING overall — NOT rewritten this round; no specific line-level correction
> was in scope for this pass, and none of this pass's four named contradictions touch this
> file. This document is dated 2026-05-27 (v2.3) and describes `seed_practices.py` /
> `seed_practices.json` / `install_velo.sh` state as of that date; two months of subsequent
> commits are UNVERIFIED against it. Do not treat any command, file path, module import, or
> "DONE" checklist item below as current without re-confirming against the live repo first —
> this document's own text warns of exactly this drift (§"Verify, don't trust, uploaded
> files").

> **⚠ NEWER LAYER, added `PROMPT №679`, 2026-08-12 — a THIRD seed command this document does not
> otherwise know about: `velo seed-demo`.** Everything below this note is about `seed`/
> `seed-practices` only. `seed-demo` (`backend/scripts/seed_demo.py`, added in commit `330a4d70`)
> is a separate, newer script with different properties: **non-interactive** (`--master-tg
> <telegram_id> [--extra-masters N]`, no prompts); creates **ONLY masters** (a real master + up to
> 99 synthetic ones) and their published practices — no ordinary users, no bookings; goes through
> the real service paths so it **emits proper outbox events** (unlike `seed`, which writes bare-ORM
> and is invisible to the comms/chat system); and **refuses to run outside `VELO_ROLE=test`** (a
> hard role gate in `scripts/velo-manage.sh`, not a convention). Built for the T-15 e2e checklist,
> to give a test stand a living master catalog to walk through. Not a replacement for `seed` or
> `seed-practices` — a third, narrower tool.

Handoff document. Contains everything needed to continue work at any
later point: for yourself a month from now, for a new AI chat, for
the backend developer, for any participant.

Full read ≈ 15 minutes. Structure:
- what and why we built;
- what's in the deliverable set and where each file goes;
- how to use it;
- how it works internally (in case anything needs editing);
- what the backend developer must do once before the script runs;
- technical decisions and the reasoning behind each;
- limitations, edge cases, known risks;
- troubleshooting common failures;
- history of key decisions;
- how to resume work in a new AI chat;
- quick reference;
- final file tree and deliverables checklist.

> **Read me first:** the section **"CURRENT STATE — v2.3"** directly below
> is the freshest layer (then v2.2, then v2.1, then the numbered sections).
> Where they conflict, **the newest layer wins.** The numbered sections
> remain valid for design rationale and deep internals.

---

## CURRENT STATE — v2.3 (updated 2026-05-27)

> **This is the freshest layer — read it first.** It supersedes v2.2 / v2.1
> and the numbered sections wherever they conflict. The big change this round
> is architectural: **the schedule is now GENERATED from templates, not listed
> by hand in JSON.** Also: mood/rating became an integer score, `style` is now
> validated, and the diary material moved into JSON.

### Status: HYBRID GENERATOR DEPLOYED AND VERIFIED IN-APP ✅

Re-seeded on the VPS via `velo seed-practices --reset --yes` and confirmed:
**11 service masters + 132 practices (≈45 completed / ≈87 scheduled) + 5
test-users fully populated**, no errors, committed. In-app the calendar is
densely filled (today and surrounding days), all 8 direction filters work,
and the test-user diary feed is rich. Repo commits this round:
`ba27415` (mood/rating→score fix) and `49769b8` (hybrid generator + richer
material). Backend developer's commit `8f0c6cc` introduced the score
migration + style validation we adapted to.

### What changed since v2.2 (three things)

**1. Backend changed the data model — we adapted (commit `ba27415`).**
The backend developer migrated mood/rating from enum strings to an **integer
1..10 score** (migration `d5e6f7a8b9c0`: `checkins.mood`, `feedbacks.rating`,
`diary_entries.mood` are now `Integer` with CHECK `BETWEEN 1 AND 10`). He also
added a **`style` validator** against the new `settings.practice_allowed_styles`
(`["hatha","kundalini","vinyasa","yin"]` — placeholder list until the client
gives the real catalog). Our adaptation:
- `seed_practices.py`: `MOOD_SCORES=(2,6,9)` / `RATING_SCORES=(9,6,2)` (the
  same low/confused=2, mid/good=6, high/fire=9 mapping the backend used).
- `_validate_practice_for_orm_insert` also checks `style ∈ practice_allowed_styles`
  now (mirror of the new Pydantic validator), for the past-practice ORM path.
- `seed_practices.json` `style` values are the 4 allowed placeholders
  (semantically rough — "women's circle"→"hatha" etc. — to be replaced when
  the real style catalog lands).

**2. Hybrid schedule generator — the main architectural change (commit `49769b8`).**
JSON no longer lists practices with explicit dates. Instead:
- **`practice_templates`** (20 entries): describe WHAT a master teaches —
  title/direction/difficulty/style/duration/description — **with no dates**.
  Covers all 8 directions, 3 types (live / one_on_one / series), 3
  difficulties, 4 styles.
- **`schedule`** section: `timezone`, `days_back: 14`, `days_forward: 14`,
  `slots_past` (3/day: 08:00/12:00/19:00), `slots_future` (6/day:
  08/10/12/17/19/21).
- **`expand_schedule(templates, schedule, now)`** in `seed_practices.py`
  round-robins templates across the `[-days_back; +days_forward]` window into
  concrete practices: sets `scheduled_at`, a **stable key**
  `v2-{YYYY-MM-DD}-{HHMM}-{template_key}`, and an **auto status** (end ≤ now →
  completed; start ≤ now < end → live; else scheduled). The result is placed
  under `data["practices"]`, so the **entire downstream pipeline (cmd_seed,
  cmd_clean, test-user seeding) is unchanged.**
- Asymmetric density (past 3/day, future 6/day): keeps history rich enough to
  fill the diary while making the upcoming calendar dense and "alive".
- **This closes the v2.2 "future improvement"**: dates are now relative to
  "today", so a re-seed is always in the visible window — no JSON date edits.

**3. Diary material moved to JSON; bigger volumes.**
- `diary_templates` (32: 24 note + 8 dream, `mood` as 1..10 / null),
  `checkin_comments` (10), `feedback_comments` (10) now live in JSON and flow
  into the seeder as a `pools` argument (no more module-level hardcode in `.py`).
- Per-user volumes raised: diary 28, attended 14, check-ins 12, feedbacks 12,
  upcoming 4, cancelled 2 → ~80+ feed cards per test-user.

### `velo seed-practices` now works on THIS VPS

The wrapper command was missing because `/opt/velo/scripts/manage.sh` is a
**generated artifact** that `velo update` does NOT regenerate (only the
installer writes it). The repo's `scripts/install_velo.sh` already contains
the `seed-practices)` branch (so a fresh install picks it up automatically),
but the running server was stale. Fix applied **manually on the VPS**: inserted
the `seed-practices)` branch into `manage.sh` (backup at `manage.sh.bak`). This
is a one-off catch-up — NOT a change outside the repo, since the repo source
already has it. ⚠️ Systemic note for the backend dev: `velo update` not
regenerating `manage.sh` means future command changes won't reach live servers
automatically — consider adding `create_management_script` to the `update)`
branch.

### Commands on THIS server (now via the wrapper)

```bash
velo seed-practices --dry-run          # preview, writes nothing
velo seed-practices --reset --yes      # wipe own data + re-seed (no prompt)
velo seed-practices --clean --yes      # wipe own data only
# direct form still works:
docker compose exec app python scripts/seed_practices.py --dry-run
```

### Verified working (in-app, by the operator) — v2.3

- Calendar densely populated around today (6 practices/day forward, 3/day
  past); week navigation backward also filled.
- All 8 direction filters work, no 422.
- Test-user diary feed: 28 personal note/dream entries, 14 attended-practice
  history items with check-ins (mood score) and feedbacks (rating score),
  4 upcoming + 2 cancelled bookings.

### Still open / nice-to-have (v2.3)

- **`style` is placeholder** (`hatha/kundalini/vinyasa/yin`) stretched over all
  directions — replace `practice_allowed_styles` (config.py) + JSON `style`
  values + frontend `STYLE_OPTIONS` when the real catalog arrives.
- Dedicated direction icons (`DIRECTION_ICON` falls back to a neutral glyph).
- `velo update` should regenerate `manage.sh` (see systemic note above).
- All 5 test-users book the SAME first 14 completed practices (so those show
  participants=5, others 0). Fine for a demo; randomize spread later if wanted.
- All seeded practices are `is_free` (ledger amounts = 0). Add paid ones if
  payment flows need demo data.

---

## CURRENT STATE — v2.2 (updated 2026-05-26, later same day)

> **This is the freshest layer — read it first.** It supersedes v2.1 and the
> numbered sections wherever they conflict. v2.1 (just below) remains valid
> for the test-user mechanics; the numbered sections for deep design.

### Status: FULLY WORKING, VERIFIED IN-APP ✅

After v2.1 the seed ran, but the operator saw an empty calendar + a 422
error. Both are now fixed and **visually confirmed in the app**: practices
of the new masters show on the calendar (27–31 May), the direction filters
(all 8) work without errors, masters appear in the catalog, and the
test-user diary is populated. Nothing was broken; no data was lost.

### Three fixes made in this round (and the root lesson)

**The root cause behind everything in this round:** the set of allowed
practice *directions* lived in **THREE independent places**, and расширять
only one of them silently broke the others. The single source of truth is
`settings.practice_allowed_directions` (in `config.py`). The three places:

1. **Backend create-validator** — `practices/schemas.py` `CreatePracticeRequest`
   reads `settings` ✅ (was already correct after v2.1's config edit).
2. **Frontend** — a *hand-maintained* literal union + label maps, NOT
   generated from OpenAPI. Must be edited by hand.
3. **Backend list/filter-validator** — `practices/router.py` query params had
   their own hardcoded `Literal[...]`, unrelated to `settings`. This is what
   threw the 422.

What we changed:

**Fix A — dates (the "empty calendar").** The practices were seeded for
18–24 May, i.e. the week *before* "today" (26 May), so they fell outside the
calendar's default current-week window (and 12 of 14 were `completed`, which
the public feed never shows). `seed_practices.json` was re-shaped to a
**mix**: 7 `completed` on 20–24 May (history → feeds the test-user diary) +
7 `scheduled` on 27–31 May (future → visible on the calendar). All 5 new
directions were deliberately placed on the visible (scheduled) practices.
Applied via `--reset`. **If you re-seed on a later date, the dates will be in
the past again — bump them, or consider making the dates relative to "today"
in the script (noted as a future improvement).**

**Fix B — frontend directions (Claude Code commit `7b87d96`).** Added the 5
new directions to the UI in **four** files (Claude Code found the 4th, which
we couldn't see from chat):
- `frontend/src/api/types.ts` — extended the **hand-maintained**
  `PracticeDirection` literal union (3 → 8). ⚠️ This type is NOT regenerated
  from OpenAPI (`velo update` rewrites `generated.ts` but leaves this one);
  **it must be kept in sync with `config.py` by hand** whenever directions
  change.
- `frontend/src/utils/practiceOptions.ts` — `DIRECTION_OPTIONS` (master form).
- `frontend/src/utils/displayHelpers.ts` — `DIRECTION_LABEL` (card + filter
  labels). `DIRECTION_ICON` left as-is (new directions fall back to a default
  icon — fine until dedicated SVGs exist).
- `frontend/src/components/shared/CalendarFilterModal.vue` — `DIRECTION_CHIPS`.

**Fix C — backend list-filter validator (Claude Code commit `98f95de`).**
`practices/router.py` had hardcoded `Literal[...]` for the `direction`,
`difficulty`, AND `practice_type` query params. Replaced all three with
`Annotated[list[str] | None, AfterValidator(_validate_*)]`, where the
validators read `settings.practice_allowed_*` — same source of truth as the
create-validator. Now any future расширение of `config.py` works on BOTH
create and list automatically, with no router edits. Closed/by-design
vocabularies (`duration_bucket`, `time_of_day`, `status_filter`, `sort_by`,
`sort_order`) were intentionally left as Literals.

### Checklist of "places to touch when adding a new practice direction"

So this never bites again. To add a direction (e.g. `ecstatic_dance`):
1. `backend/app/core/config.py` → `practice_allowed_directions` (the source
   of truth; no migration needed — directions are schema-on-read JSONB).
2. `frontend/src/api/types.ts` → `PracticeDirection` union (hand-maintained).
3. `frontend/src/utils/practiceOptions.ts` → `DIRECTION_OPTIONS` (+ RU label).
4. `frontend/src/utils/displayHelpers.ts` → `DIRECTION_LABEL` (+ optionally
   `DIRECTION_ICON`).
5. `frontend/src/components/shared/CalendarFilterModal.vue` → `DIRECTION_CHIPS`.
- Backend `router.py` and `schemas.py` need **no** change (they read settings).
- Then `velo update`. Difficulty/practice_type follow the same pattern now.

### What's verified working (in-app, by the operator)

- Calendar 27–31 May shows the new masters' practices (Tantra, Somatic,
  Women's circle, Men's circle, Kundalini, Breathwork).
- Direction filters: all 8 chips, filtering by a new one (e.g. Kundalini)
  returns the right practice with no 422.
- Masters appear in the catalog (it's derived from visible practices).
- Test-user diary: history (20–24 May), check-ins, feedbacks, personal
  entries, + 1 upcoming + 1 cancelled booking.

### Commands unchanged from v2.1

Direct invocation (`velo seed-practices` wrapper still not on this VPS):
```bash
cd /opt/velo/repo
docker compose exec app python scripts/seed_practices.py --dry-run
docker compose exec app python scripts/seed_practices.py            # or --reset
```

### Future improvements (nice-to-have, not blocking)

- Make seed dates **relative to today** in the script (e.g. last-5-days =
  completed, next-5-days = scheduled) so a re-seed is always in the visible
  window without editing JSON.
- Dedicated icons for the 5 new directions (`DIRECTION_ICON` in
  `displayHelpers.ts`) — currently fall back to the meditation icon.
- Re-install `velo` on the VPS so `velo seed-practices` works (optional).
- The marker-erasure edge case on UI-edited diary entries (see v2.1 caveat).

---

## CURRENT STATE — v2.1 (updated 2026-05-26)

### Status: DEPLOYED AND RUNNING ✅

Everything is live on the server and has been run successfully:

- `seed_practices.py` and `seed_practices.json` are in the repo and on the
  VPS; the `config.py` edit is applied; the seeder completed with
  `Seed завершён, изменения зафиксированы.`
- Seeded result: **11 service masters + 14 practices + 5 test users**.
  Each test user received ~41 timeline-feed cards:
  12 personal diary entries + 7 attended bookings (×2 events each:
  `booking_confirmed` + `practice_outcome`) + 6 check-ins + 6 feedbacks
  + 1 upcoming booking + 1 cancelled booking (×2 events).
- The v2.0 "backend must do" blocker (5 missing `direction` values) is
  **RESOLVED** — see "What changed" below. Sections §3.4, §6 and the §14
  checklist that still describe it as *pending* are superseded by this.

### What's new since v2.0 (this session)

1. **NEW capability: test users / user-side seeding.** v2.0 only created
   masters and their practices (the "supply" side). v2.1 also populates the
   **user side** — real Telegram accounts get a filled timeline feed
   (diary, bookings, check-ins, feedbacks, one upcoming + one cancelled
   booking). This is the headline addition; full detail below.
2. **FIXED import bug.** The original `seed_practices.py` imported
   `from app.modules.audit.models import AuditLog`, but in the live repo
   `AuditLog` lives in **`app.core.audit`** (confirmed against the working
   sibling `seed.py`). The seeder crashed at import until this was fixed.
   Lesson: the uploaded files had drifted from the live repo; always verify
   import paths against the running container.
3. **`config.py` directions: DONE by us, no backend dev needed.** Adding
   the 5 directions (`somatic`, `tantra`, `womens_circle`, `mens_circle`,
   `kundalini`) to `practice_allowed_directions` turned out to be a 1-line
   config change with **no DB migration** (directions are schema-on-read
   JSONB validated against this list — confirmed in the config.py comment
   itself). We edited it directly via Claude Code and redeployed.
4. **`velo seed-practices` wrapper is NOT on this server.** The
   `install_velo.sh` patch (v2.0) has not been re-installed here, so
   `velo` only knows `seed` (the old destructive seeder). Run our seeder via
   **direct `docker compose exec`** (see commands below). The wrapper is
   optional sugar; the script itself works fine without it.

### Test users — user-side seeding (the v2.1 feature)

**Purpose.** Let a real person log into the app via Telegram and see a
populated timeline feed (~40 cards to scroll), to test every feed category.

**Who they are.** Real Telegram accounts. The operator lists their numeric
`telegram_id`s in the JSON. The script **find-or-creates** each by
`telegram_id`:
- if the account already exists → its **role is NOT changed** and its
  existing data is NOT overwritten; only a marker key is added;
- if it does not exist → created as `UserRole.USER`.
Role does not matter — masters are separate (the 11 service masters). If a
tester wants to see the master side, they use the in-app role-switch.

**JSON shape.** A new top-level `test_users` array in
`seed_practices.json`. The file currently holds 5 real tester IDs:
`526738615, 231944851, 792933976, 936933042, 1051790788`. Each entry:

```jsonc
{
  "telegram_id": 526738615,     // real numeric Telegram user_id; null → entry skipped
  "key": "tester-1",            // label only (goes into credentials.seed.test_user_key)
  "first_name": "Тестер 1",     // used ONLY when creating a new account
  "language": "ru",             // used ONLY when creating a new account
  "diary_entries": 12,          // all volume fields optional; omit → defaults
  "attended_bookings": 7,       // historical attended bookings (on completed practices)
  "checkins": 6,                // ≤ attended_bookings
  "feedbacks": 6,               // ≤ attended_bookings
  "upcoming_bookings": 1,       // confirmed bookings on scheduled practices
  "cancelled_bookings": 1       // booked-then-cancelled (on a different scheduled practice)
}
```

Defaults (in `seed_practices.py`, `TEST_USER_DEFAULTS`): the values shown
above, tuned to ≈41 feed cards. Entries with `telegram_id: null` are
skipped with a warning (they're templates).

**What gets created per user (and how).**
- *Attended bookings* on `completed` practices: reuses
  `create_seed_booking(session, user, practice)` from the sibling
  `seed.py` (creates `Booking` + `Purchase` + zero-amount double-entry
  ledger with `reason="seed:..."`), then `project_seed_booking_events(...,
  outcome_status="attended")` for the feed cards.
- *Check-ins / feedbacks*: direct ORM insert (the service validation
  windows reject historical records) + manual projection
  `upsert_checkin_event` / `upsert_feedback_event`. Backdated via
  `created_at` before the projection reads it.
- *Upcoming booking*: `create_seed_booking` on a `scheduled` practice +
  `project_seed_booking_events(..., outcome_status=None)`.
- *Cancelled booking*: `create_seed_booking`, flip `status=CANCELLED` +
  `cancelled_at`, then project `booking_confirmed` + `booking_cancelled`.
- *Personal diary entries* (`note`/`dream`): own templates
  (`SEED_V2_DIARY_TEMPLATES`, 14 of them) + `upsert_entry_event`.
- After each user: `recalculate_participants(practice_id, session)` per
  touched practice (COUNT-based; cancelled bookings correctly do NOT count
  — confirmed in the run log: the cancel-target practice stayed at
  `current_participants=0`).

**Markers (for cleanup).**
- Test-user account → `User.credentials.seed.source == "seed_practices_v2"`
  (`User.data` does **not** exist in this codebase; `credentials` is the
  only JSONB sandbox, and `onboarding_completed` already lives there — we
  don't touch it).
- Personal diary entry → `DiaryEvent.snapshot.seed.source` (the `DiaryEntry`
  row itself has no JSONB field; it is recovered via `DiaryEvent.source_id`).
- Practice-linked rows (bookings/checkins/feedbacks/purchases) → identified
  at cleanup by the **intersection** `user_id ∈ test_users AND practice_id ∈
  our seed practices`, so a real account's own data on *other* practices is
  never touched.

**Cleanup (`--clean` / `--reset`) for test users.** Removes only our
seed rows in FK-safe order (diary events → diary entries → checkins →
feedbacks → audit(by purchase target) → company_ledger(by purchase ref) →
user_ledger(by `practice=` reason, scoped) → purchases → bookings),
then runs the existing master cleanup. **The test-user accounts themselves
are never deleted**, nor is any of their genuine non-seed data. Optional
`unmark_users` (off by default) can also strip the `credentials.seed` key.

**Idempotency.** Re-running plain `seed` changes nothing: existing bookings
make `create_seed_booking` return `None` (skip), cancelled bookings are
guarded by `_has_any_booking`, diary entries are deduped by
`(user_id, title, entry_type)`. To re-shape data (change volumes/templates),
use `--reset`.

**Known caveat (from Claude Code verify #3).** If a tester later *edits* a
seeded **personal diary entry** through the app UI, the service calls
`upsert_entry_event`, which overwrites that `DiaryEvent.snapshot` wholesale
— erasing the `seed` marker on that one event. Such an edited entry could
then survive `--clean` (it's found only by marker). Practice-linked cards
(booking/checkin/feedback) are unaffected — they're cleaned by the
practice_id intersection, not the marker. Low impact; a title-based
fallback in `--clean` could close it if it ever matters.

### Commands on THIS server

`velo seed-practices` is **not** available here — use direct invocation
(run from the repo dir, e.g. `cd /opt/velo/repo`):

```bash
# 1. Optional one-time sanity: confirm directions aren't overridden via env
docker compose exec app printenv | grep PRACTICE_ALLOWED_DIRECTIONS   # expect empty

# 2. Preview (writes nothing)
docker compose exec app python scripts/seed_practices.py --dry-run

# 3. Real seed
docker compose exec app python scripts/seed_practices.py

# Re-shape (wipe own data + re-seed) / wipe only
docker compose exec app python scripts/seed_practices.py --reset
docker compose exec app python scripts/seed_practices.py --clean
```

New stdout marker for test users: `±` = existing account, marked + seeded;
`+` = new account created; `·` = already fully seeded; `?` = dry-run plan.

### Working with Claude Code (repo access)

This work used **Claude Code** (which has direct read/write access to the
live repo) as the bridge between this chat and the real codebase. Pattern
that worked well, reuse it:

1. **Read-only recon first.** Before writing code against unfamiliar
   internals, send Claude Code a *read-only* prompt ("don't change code,
   answer with file:line citations") to confirm exact signatures, model
   fields, enum values, and import paths. We did three such recon passes;
   they're the reason the new logic was correct on the first real run.
2. **Verify, don't trust, uploaded files.** The files attached in chat had
   **drifted** from the live repo (the `AuditLog` path, and the `velo`
   wrapper version). Always have Claude Code confirm against the running
   code. A cheap one-shot guard: `docker compose exec app python -c "import
   …"` listing every module path the script uses.
3. **Direct edits for trivial, verified changes.** The `config.py`
   one-liner was applied straight in the repo via Claude Code, then pushed
   + `velo update`. For larger logic, edits were authored in chat, the file
   downloaded, committed, pushed, and deployed.
4. **Deploy loop:** edit (in repo via Claude Code, or download from chat) →
   commit → push → `velo update` on the VPS (rebuilds, runs tests, restarts;
   emits a health-checked report) → run the seeder. If something fails,
   capture the stdout/traceback and bring it back to chat.
5. **Be careful editing the import block.** When fixing the `AuditLog` path,
   a `str_replace` on the import block accidentally dropped the
   `dispose_engine, get_session_factory` import (still used later) — caught
   and restored before deploy. After editing imports, re-`py_compile` and
   grep that nothing used-elsewhere was removed.
6. **Getting real Telegram IDs.** Test users need real numeric Telegram
   `user_id`s (not @usernames). The tester can get theirs from **@userinfobot**
   in Telegram. They go into `test_users[].telegram_id`; entries left `null`
   are skipped with a warning.

### Continuing in a new chat (v2.1)

Attach: **this document**, the current `seed_practices.py`,
`seed_practices.json`, and (if touching validation) `config.py`. State the
task. Then have Claude Code re-confirm any internals before editing — the
"verify against live repo" habit above is what keeps deploys to one cycle.

---

## 1. What and why

The VELO project has an existing `backend/scripts/seed.py` script
with the management command `velo seed`. It is destructive by design:
`velo seed --reset` calls `wipe_all_data`, which deletes every domain
table (users, master_profiles, practices, bookings, purchases,
ledger, and so on). This was acceptable while the test stand was
used by a single developer.

Real users now use that stand too, and the destructive reset is no
longer acceptable. In parallel, the team needs a reliable way to
manage the morning-practice schedule content (visible cards on the
frontend, UI testing), while the full master flow through the UI is
not yet ready.

**Solution:** a new, separate management command `seed_practices`
that creates service-only master accounts and seeds their practices
from an editable JSON file. It has a `--reset` mode that wipes
**only its own data** — real users and other (non-service) masters
are never touched.

---

## 2. What we built — short summary

Three new files, plus one minor change in an existing one:

| File | Purpose |
|---|---|
| `backend/scripts/seed_practices.json` | Source data: 11 masters + 14 practices for week 18–24 May 2026. Edited by hand. |
| `backend/scripts/seed_practices.py` | The script itself, 790 lines. Four modes, idempotency, defensive checks. |
| `scripts/install_velo.sh` (patch) | Added a `velo seed-practices` branch in the embedded `manage.sh` heredoc, plus 4 lines in the help block. |
| `backend/app/core/config.py` (backend's edit) | Backend adds 5 new values to `practice_allowed_directions`. **Without this, the script will not run.** |

Counts:
- 11 service-only masters, with Telegram IDs `10001..10011`;
- 14 practices: 12 with status `completed` (Monday 18 → Saturday 23), 2 with status `scheduled` (Sunday 24);
- 8 `direction` values in use: existing `meditation/yoga/breathwork` plus the 5 new ones `somatic/womens_circle/mens_circle/tantra/kundalini`.

> **v2.1 note:** a fourth file role was added — a `test_users` section in
> the JSON drives **user-side seeding** (real Telegram accounts get a full
> timeline feed). The `config.py` edit below is **already applied**. See
> "CURRENT STATE — v2.1" at the top for the authoritative current picture.

---

## 3. Files — where each one goes

### 3.1 `backend/scripts/seed_practices.json`

The content source. Placed in `backend/scripts/` next to the old
`seed.py`. Structure:

```
{
  "_comment": "...explanatory block...",
  "masters": [
    {
      "key": "ira-kosobukina",           ← unique slug; idempotency key
      "telegram_id": 10001,              ← range 10001..10011
      "first_name": "Ира",
      "last_name": "Кособукина",
      "display_name": "Ира Кособукина",
      "methods": ["yoga", "meditation", "breathwork", ...],
      "bio": [
        "first paragraph",
        "",                              ← empty string = paragraph break
        "second paragraph"
      ]
    },
    ... 10 more masters
  ],
  "practices": [
    {
      "key": "2026-05-18-08-ira-kosobukina",  ← unique slug
      "master": "ira-kosobukina",             ← reference into masters[].key
      "title": "Телесная + дыхательная практика",
      "practice_type": "live",
      "direction": "somatic",
      "difficulty": "medium",
      "style": "телесная + дыхательная",  ← optional, free-text
      "scheduled_at": "2026-05-18T08:00:00+03:00",
      "duration_minutes": 60,
      "timezone": "Europe/Moscow",
      "status": "completed",              ← completed | scheduled | live | cancelled | draft | deleted
      "is_free": true,
      "price_cents": 0,
      "max_participants": 100,
      "zoom_link": null,                  ← fill in when available
      "description": ["...", "", "..."],
      "what_to_prepare": "Удобная одежда, коврик",
      "contraindications": null
    },
    ... 13 more practices
  ]
}
```

**Required practice fields:** `key`, `master`, `title`,
`practice_type`, `direction`, `difficulty`, `scheduled_at`, `status`.
Everything else has defaults (`duration_minutes=60`,
`timezone=Europe/Moscow`, `is_free=true`, `price_cents=0`,
`currency=eur`) or is optional.

### 3.2 `backend/scripts/seed_practices.py`

The script itself. Goes in the same directory. Runs inside the
`app` container via `docker compose exec`, or via `velo seed-practices`
once `manage.sh` is regenerated.

### 3.3 `scripts/install_velo.sh`

This is the VPS installer. We added 13 new lines (the
`seed-practices)` branch inside the `manage.sh` heredoc, plus 4
lines in the help block). The change takes effect at the next
`velo install` on the VPS — after that the short command
`velo seed-practices` becomes available.

### 3.4 Edit to `backend/app/core/config.py` — owned by the backend developer

Five new values need to be added to `practice_allowed_directions`:

```python
practice_allowed_directions: list[str] = [
    "meditation",
    "yoga",
    "breathwork",
    # new values ↓
    "somatic",
    "womens_circle",
    "mens_circle",
    "tantra",
    "kundalini",
]
```

No database migration is required — this is a config field consumed
by the Pydantic validator `CreatePracticeRequest.direction_must_be_valid`.

**Without this edit** the script will fail the pre-flight check
**before** writing anything to the database, with a clear message
indicating which values are missing from `config.py`.

---

## 4. How to use

### 4.1 Direct invocation (works on any stand immediately)

```bash
docker compose exec app python scripts/seed_practices.py            # seed
docker compose exec app python scripts/seed_practices.py --reset    # wipe own data + re-seed (prompts "yes")
docker compose exec app python scripts/seed_practices.py --clean    # wipe own data only (prompts "yes")
docker compose exec app python scripts/seed_practices.py --dry-run  # plan only, no DB writes
docker compose exec app python scripts/seed_practices.py --reset --yes  # wipe + re-seed without prompt
```

### 4.2 Via `velo` (available after the next `velo install`)

```bash
velo seed-practices                       # seed
velo seed-practices --reset               # wipe + re-seed (prompts)
velo seed-practices --reset --yes         # wipe + re-seed without prompt
velo seed-practices --reset --dry-run     # show what would be wiped/re-seeded
velo seed-practices --clean               # wipe only (prompts)
velo seed-practices --clean --yes         # wipe only without prompt
velo seed-practices --dry-run             # show seed plan
```

### 4.3 Four modes — what each one does

| Mode | Behavior |
|---|---|
| `seed` (default) | **Top-up.** Iterates over JSON: each master is looked up by `telegram_id`; if missing — created. Each practice is looked up by `data.seed.key`; if missing — created. Existing records are not touched. Idempotent: rerunning changes nothing. |
| `--reset` | **Wipe + re-seed.** Runs clean first (see below), then seed. Use this whenever you edit the JSON and want the changes applied. |
| `--clean` | **Wipe only.** Deletes everything that belongs to masters carrying the marker `data.seed.source == "seed_practices_v2"`. No re-seed. |
| `--dry-run` | **Flag, combinable with any mode.** Prints the action plan to stdout, writes nothing to the database. |

### 4.4 Safety: interactive confirmation for destructive modes

Before running `--reset` or `--clean`, the script prompts
`Type "yes" to confirm:`. Any reply other than `yes` aborts the
operation.

For automation (CI, scripting) the `--yes` flag skips the prompt.

### 4.5 Reading the seed output

```
=== SEED ===
Source: /app/scripts/seed_practices.json
Batch:  2026-05-22T17:30:00+00:00
Masters:
  + ira-kosobukina       TID 10001         ← created
  + dima-shamenkov       TID 10002         ← created
  · georgy-golobokov     TID 10003         ← already existed, skipped
  ...

Practices:
  + 2026-05-18-08-ira-kosobukina            ← created
  · 2026-05-18-11-dima-shamenkov            ← already existed, skipped
  ! WARNING: scheduled_at=... is in the past but status='scheduled'.
  + 2026-05-19-08-georgy-golobokov
  ...
```

Prefix legend:
- `+` — created;
- `·` — already existed, skipped (this is fine — idempotency at work);
- `?` — under `--dry-run`: "would be created";
- `!` — warning, not an error.

### 4.6 Editing content

**Change next week's schedule** → edit `scheduled_at` for the
relevant practices, set `status: scheduled` for future ones and
`status: completed` for past ones, then:

```bash
velo seed-practices --reset
```

**Add a new practice** → append a new record to `practices: [...]`
with a unique `key`, then `velo seed-practices` (no `--reset`
needed — top-up creates only the missing ones, existing records
stay).

**Fix a master's bio** → edit `masters[].bio`. To apply the change
to an existing master in the database, use **`--reset`**. Plain
`seed` will not update an existing master — that is an intentional
limitation (see §8.1).

**Add a new master** → append to `masters: [...]` with a unique new
`telegram_id` (e.g. `10012` if `10011` is taken) and a unique
`key`. Then `velo seed-practices`.

---

## 5. Architecture — how it works inside

### 5.1 Service-only masters

All 11 masters follow one creation schema:

```python
User(
    telegram_id=<10001..10011>,
    first_name=..., last_name=...,
    role=UserRole.MASTER,           # critical: not ADMIN
    is_active=True,
)
MasterProfile(
    user_id=user.id,
    data={
        "account": {"status": "verified", ...},
        "profile": {"display_name": ..., "bio": ..., "methods": [...], ...},
        "documents": [],
        "availability": {
            "is_accepting": True,   # critical: is_accepting, not accepting_bookings
            "note": None,
        },
        "settings": {"auto_confirm_bookings": True, "max_participants_default": 20},
        "stats": {"total_practices": 0, "total_participants": 0, "avg_rating": None},
        "seed": {                                  # ← our marker
            "source": "seed_practices_v2",
            "key": "<slug>",
        },
    },
)
```

**Note on `is_accepting`:** the existing `seed.py` writes
`accepting_bookings`, which is a known bug — the rest of the
codebase uses `is_accepting` (see `masters/service.py:67`). We
write the correct name.

**Note on role:** `get_current_master` in `auth/dependencies.py`
rejects anything where `role != UserRole.MASTER` (it also rejects
admins). Therefore the service master must be `MASTER`, not
`ADMIN`.

### 5.2 The "owned by us" marker

A `seed` key is added to `practices.data` (JSONB):

```python
{
    "taxonomy": {"direction": "...", "style": "...", "difficulty": "..."},  # set by the service
    "seed": {                                                                # set by us
        "source": "seed_practices_v2",
        "owner_tid": 10001,
        "key": "2026-05-18-08-ira-kosobukina",
        "batch": "2026-05-22T17:30:00+00:00",
    }
}
```

A similar `seed` key is added to `master_profiles.data`:

```python
{
    ...account/profile/availability/settings/stats...,
    "seed": {
        "source": "seed_practices_v2",
        "key": "ira-kosobukina",
    }
}
```

`source` is a stable identifier — "this row belongs to our seeder".
Clean uses it to find our data. `key` is the stable identifier of
a specific row (the slug from JSON); idempotency keys off it.

This marker does not collide with the existing `seed.py`, which
uses the `__SEED__` tail in `description`.

### 5.3 Idempotency

**Masters:** lookup by `telegram_id`. If found — return the
existing record, do not update it (important: JSON edits do **not**
propagate to an existing master without `--reset`).

**Practices:** lookup by `data.seed.key.astext == "<slug>"`. If
found — return existing, do not update.

**Extra safety:** if an existing `User` is found but has no
`MasterProfile` (an aborted earlier run), the script raises a
clear error "DB is in an inconsistent state, run --clean and then
seed again", rather than failing later on a foreign-key error when
inserting a practice.

### 5.4 Practice creation: a hybrid path

`CreatePracticeRequest` carries a validator
`scheduled_at_must_be_future` that rejects past timestamps. Since
our schedule includes past practices (`status=completed`), we use a
hybrid:

- **Future practices (`scheduled_at > now`)** go through
  `practices.service.create_practice(user, body, session)` — all
  the Pydantic validators come for free.
- **Past practices** go through a direct ORM insert
  `Practice(...)`, bypassing Pydantic. All enum values and field
  lengths are validated by hand via `_validate_practice_for_orm_insert`
  against `settings.practice_allowed_*`.

After creation (regardless of path):
1. `set_jsonb("data", {**practice.data, "seed": {...}})` adds the
   marker on top of the `taxonomy` block.
2. `practice.status = target_status` sets the intended status (the
   service always creates `draft` — we need `scheduled` or
   `completed`).

### 5.5 Reset: FK-safe wipe in the spirit of `full_cleanup_range`

The DELETE order is critical, because:
- `purchases.practice_id` is `ON DELETE RESTRICT` — a practice
  cannot be deleted while purchases reference it.
- `company_ledger.reference_id` is plain `text`, not an FK — it
  must be cleaned by a sub-select.
- `user_ledger`, `master_ledger`, `payments` all have RESTRICT on
  `user_id`.

The script reproduces the 15-step order from
`backend/tests/helpers.py:full_cleanup_range`, narrowed down to
just the IDs of our service masters (determined by the JSONB
marker).

**Critical technical detail:** master and practice IDs are loaded
into Python lists **at the very start** of clean, **before** any
DELETE. If we used a subquery directly inside DELETE statements,
step 14 (DELETE master_profiles) would empty out the JSONB-marker
subquery, and step 15 (DELETE users) would silently do nothing.
This was caught during validation.

### 5.6 Pre-flight check

At the very start of `cmd_seed` (before any SELECT or INSERT)
`preflight_check(source)` runs. It validates that **every** value
used in JSON across four fields (`practice_type`, `direction`,
`difficulty`, `currency`) exists in `settings.practice_allowed_*`.
If anything is missing — `sys.exit(2)` with a clear message
indicating which values are absent from `config.py`.

This guards against "backend forgot to add `somatic` to config.py":
without it the script would fail somewhere mid-run, leaving partial
masters with no practices.

### 5.7 Warning when status and time disagree

If a practice has `status: scheduled` in JSON but its `scheduled_at`
is already in the past (typical when the script is run a week later
without updating JSON), the script **creates the practice as
declared** but prints a warning. This is not blocking — it just
draws the operator's attention: the JSON is stale, the schedule
needs updating.

### 5.8 No prod guard (this is intentional)

Most deploy scripts include a `if app_env == "production": refuse`
clause. We omitted it because the current VPS test stand runs with
`APP_ENV=production` (it is the "production-style" stand used for
testing). A guard would simply block the command in the one place
where it's needed.

The replacement for the guard is the **interactive confirmation**
for `--reset` and `--clean`. A stray Enter will not wipe anything.

---

## 6. What the backend developer must do once

> **✅ DONE in v2.1.** This action has been completed — the 5 values were
> added to `practice_allowed_directions` directly (via Claude Code) and
> deployed; no backend developer was needed (it's a 1-line config change,
> no migration). Kept below for the record.

**One required action:** add five values to
`practice_allowed_directions` in `backend/app/core/config.py`:

```python
practice_allowed_directions: list[str] = [
    "meditation", "yoga", "breathwork",
    "somatic", "womens_circle", "mens_circle", "tantra", "kundalini",
]
```

Without this, `preflight_check` exits with a clear message.

**Recommended (for UI, not blocking):** tell the frontend
developer about the new direction values so they handle them in
calendar filters, icons, and translations. If the frontend is not
ready to render them, the practices will still go into the DB but
the calendar filters may not surface them (depending on how the
frontend handles unknown values).

**Not blocking but nice to have:** at the next `velo install` on
the VPS the regenerated `manage.sh` will include the
`velo seed-practices` branch. Until then the script still works
through `docker compose exec app python scripts/seed_practices.py`.

---

## 7. Technical decisions and their rationale

### 7.1 Why 11 service masters, not 1

Every practice card on the frontend shows the master's name and
bio. If all 14 practices were attributed to "VELO Seed Master",
the master filter would be useless, master profiles would never
get exercised, and the UX test would not be realistic. With 11
distinct masters the frontend gets a realistic UX test.

### 7.2 Why positive TIDs `10001..10011`, not negative

The original proposal was a negative sentinel (`-1`) as a
"guaranteed not a Telegram user". The product owner picked
positive — easier to read in logs, doesn't look like a "hack
value". The range `10001..10011` sits above the old dummy range
from `seed.py` (`9900001..9900030`) and well below any realistic
Telegram user IDs (which today are ≥10⁸–10⁹).

### 7.3 Why JSON, not YAML

The initial proposal was YAML (better for multi-line Russian text,
supports comments). The product owner picked JSON. To solve the
"800–1500-character multi-line bio" problem we use **JSON with
arrays of strings** (`bio: ["paragraph 1", "", "paragraph 2"]`),
joined via `"\n".join(...)` when read. This is valid JSON, edits
cleanly, no escape-sequence pain.

### 7.4 Why a JSONB marker `data.seed`, not text

The old `seed.py` tags its rows with a `\n__SEED__` tail in
`description`. This:
- pollutes a visible field;
- breaks if anyone edits the description;
- offers no structured metadata storage (batch, owner, key).

A JSONB marker is cleaner: it does not leak into the API response
(`practice_to_response` only forwards `taxonomy`); it allows
structured metadata; it can be queried with
`data['seed']['source'].astext == 'seed_practices_v2'`.

### 7.5 Why the hybrid "service for future, ORM for past"

Going through the service gives ALL the Pydantic validation for
free — field lengths, IANA timezones, enum values, the
is_free/price_cents pricing invariant, and so on. But Pydantic
rejects past timestamps (`scheduled_at_must_be_future`). Past
practices are needed to test completed-card UI, so for them we
use ORM-insert with hand-rolled validation (duplicating the main
Pydantic checks).

Worse alternatives:
- ORM-only for everything → lose synchronization with the
  production schema as it evolves.
- Loosen `scheduled_at_must_be_future` in Pydantic → mutate the
  public API model just for an internal seeder; "create in the
  past" should not be possible in production by design.

### 7.6 Why `shift + "$@"` in bash

```bash
seed-practices)
    cd_compose
    shift
    $COMPOSE_CMD exec app python scripts/seed_practices.py "$@"
    ;;
```

This is the cleanest way to forward an arbitrary combination of
flags (`--reset --dry-run`, `--clean --yes`, `--dry-run`, etc.)
into the Python script, which parses them itself via argparse. No
logic duplication on the bash side — all four modes and both
flags are handled uniformly in one place (Python).

### 7.7 Why idempotency only on creation (edits require --reset)

An alternative is to synchronize the database with JSON on every
seed (UPSERT-style). Technically possible, but adds code and
risks: what if an admin edits a master's bio through the UI and
then we run seed and overwrite their edits? With the chosen
semantics ("edits go through --reset"), the behavior is
predictable: either you update explicitly (reset), or nothing
happens. Documented in the script's docstring.

---

## 8. Known limitations and edge cases

### 8.1 JSON edits do not apply without --reset

Intentional (see §7.7). If you edited a master's bio or a
practice's description and want it applied — run
`velo seed-practices --reset`.

### 8.2 Schedule is tied to the run date

Every practice in JSON has a hard-coded date. If you run the
script a week later without updating JSON, the Saturday/Sunday
"scheduled" practices will be in the past. The script will still
create them (with a warning), but the UI will display "scheduled
practice 5 days ago". **This is fine for a test stand.** For
ongoing use, the operator updates the dates in JSON.

### 8.3 Reset against real purchases

`purchases.practice_id` is `ON DELETE RESTRICT`. If a real user
ever buys our seeded practice, `clean` will hit the RESTRICT FK.
There are no purchases on the current stand, but the situation is
possible in the future. The script does not handle it specially
right now — it will surface as a SQLAlchemy IntegrityError. If
this happens — either resolve manually, or extend `clean` with
refund logic patterned on `cancel_practice`.

`--dry-run --reset` prints a warning when our practices have
purchases from real users, so the operator can spot the issue
before running for real.

### 8.4 Pydantic boundary race for "almost-future" practices

Between the moment we check `is_future = scheduled_at > now` and
the moment Pydantic's validator checks the same `scheduled_at > now`,
some time passes. If a practice is scheduled "1 second in the
future", by the time Pydantic runs it may already be in the past
→ `ValueError`. Unlikely with normal schedules (we seed in
advance), but theoretically possible.

### 8.5 Misha Vikhman's bio is a stub

The source schedule said "no details yet". The JSON contains a
short placeholder. When the real text arrives, replace
`masters[10].bio` and run `--reset`.

### 8.6 Zoom links are all `null`

Not available at the time of JSON authoring. When the links
arrive, fill in `practices[].zoom_link` and run `--reset`.
Practices with `zoom_link=null` are technically valid.

### 8.7 Pre-flight blocks if the backend has not extended config.py

The pre-flight check exits with a clear message **before** any
DB writes. This is by design — better to fail clearly than to
leave garbage in the DB.

### 8.8 Aborted previous run is detected and reported

If a previous run was interrupted mid-way (User created without a
MasterProfile), the next run detects it and exits with the message
"DB is in an inconsistent state, run --clean and then seed again",
rather than failing on a foreign-key error later.

---

## 9. Troubleshooting

Common failure modes and how to fix them.

### 9.1 Pre-flight fails: missing directions

```
!! PRE-FLIGHT FAILED
   JSON contains values not in settings.practice_allowed_*:
   direction:
     missing from config.py: ['kundalini', 'mens_circle', 'somatic', 'tantra', 'womens_circle']
```

**Fix:** the backend developer must add the missing values to
`practice_allowed_directions` in `backend/app/core/config.py`. See §6.

### 9.2 "User TID=N exists, but no MasterProfile"

```
RuntimeError: User TID=10001 (ira-kosobukina) exists, but no
MasterProfile. DB is in an inconsistent state (likely an aborted
previous run). Run --clean and then seed again.
```

**Fix:** run `velo seed-practices --clean` (no `--reset` — we
don't want to seed yet), then `velo seed-practices` for a clean
new seed.

### 9.3 IntegrityError on purchases (RESTRICT FK)

```
sqlalchemy.exc.IntegrityError: ... update or delete on table
"practices" violates foreign key constraint ... on table "purchases"
```

**Fix:** a real user has purchased one of our seeded practices.
Either:
- delete the relevant purchases manually (and the corresponding
  ledger entries) and try again;
- or extend the script with refund logic patterned on
  `practices.service.cancel_practice` (handles refunds and ledger
  cleanup automatically).

Run `velo seed-practices --reset --dry-run` first to see whether
real-user purchases exist before attempting a real reset.

### 9.4 "WARNING: scheduled_at is in the past but status='scheduled'"

This is a warning, not an error. The practice is still created.

**Fix:** update the relevant `scheduled_at` and/or `status` values
in JSON to reflect reality, then run `velo seed-practices --reset`.

### 9.5 ModuleNotFoundError on import

```
ModuleNotFoundError: No module named 'app.modules.promos.models'
(or reports / waitlist / withdrawals)
```

**Fix:** the script assumes these classes live in `<module>/models.py`.
If your project has reorganized them (e.g., they live in `<module>/__init__.py`),
update the import paths at the top of `seed_practices.py`. The four
likely-affected modules: `promos`, `reports`, `waitlist`, `withdrawals`.

### 9.6 Pydantic ValidationError on duration / direction / etc.

```
pydantic.error_wrappers.ValidationError: 1 validation error for CreatePracticeRequest
direction
  direction must be one of ['meditation', 'yoga', 'breathwork'], got 'somatic'
```

**Fix:** the backend has not yet updated `practice_allowed_directions`
in `config.py`. See §6 and §9.1. Pre-flight should normally catch
this earlier; if it slipped through, the backend simply needs to
add the missing values.

### 9.7 "Source not found" / FileNotFoundError

```
FileNotFoundError: Source not found: /app/scripts/seed_practices.json
```

**Fix:** the JSON file is missing from `backend/scripts/`. Confirm
the file is checked into git and pulled on the VPS:
`docker compose exec app ls -la scripts/seed_practices.json`.

---

## 10. History of key decisions

This section is here to remember **why** things are the way they
are, and to avoid re-opening settled discussions.

| Decision | Alternative considered | Why this way |
|---|---|---|
| New script alongside the existing `seed.py` | Modify existing `seed.py` | Existing seeder still serves the journey-for-real-users use case; don't entangle them |
| 11 service masters | A single service master | UX test needs diverse master names and bios |
| TID range `10001..10011` (positive) | Negative sentinel `-1` | Product owner preferred positive — easier to read in logs |
| JSON format | YAML | Product owner chose JSON; worked around multi-line via arrays of strings |
| JSONB marker `data.seed` | Tail tag in `description` / dedicated column | Clean, non-public, no migration needed |
| Idempotency by `key` (slug) | By `(master_id, title)` | Stable across renames |
| Hybrid service + ORM | ORM-only, or weaken Pydantic | Keep validation guarantees for future practices; don't mutate public API |
| No prod guard | Refuse when `app_env=='production'` | Stand is effectively production; guard would block the one place it's needed |
| Interactive confirmation | No confirmation | A stray Enter must not wipe anything |
| Four modes (seed / reset / clean / dry-run) | Two modes (seed / reset) | Dry-run is critical for a multi-user stand |
| Five new directions (somatic, womens_circle, mens_circle, tantra, kundalini) | Map everything to meditation/yoga/breathwork | Recognizable categories are needed for a realistic UX test |
| `first_name="StateFirst", last_name=null` for the StateFirst account | `first_name="Вера и Юлия"` | StateFirst is a brand, not an individual — cleaner User-table entry |
| Final JSON validation pass | Skip and ship | Caught two inconsistent status/time entries and one weird first_name; fixed all three |

---

## 11. How to continue work in a new AI chat

If this chat is closed and work needs to continue, open a new chat
and attach:

1. **This document** (`seed_practices_v2_complete_context.md`) — it
   contains the full history and the rationale for every decision.
2. **`backend/scripts/seed_practices.json`** — the current state of
   the content.
3. **`backend/scripts/seed_practices.py`** — the current script
   version.
4. **A short task statement** — what to fix/add/improve.

Example first message in a new chat:

> Continuing work on `seed_practices_v2`. Attached: handoff document
> and current files. Need to: [your task].

The AI will then quickly restore context and can:
- propose JSON edits (add a master/practice, change the schedule,
  update a bio);
- modify the script (new mode, additional safety, fix a discovered
  bug);
- update the installer;
- validate the changes against the same checklists in this
  document.

### 11.1 Key facts the AI must remember

When resuming work, keep these facts in mind:

- **Imports in `seed_practices.py`** come from
  `app.modules.<module>.models` and `app.modules.<module>.service`.
  The structure is confirmed by Claude Code's recon reports, but
  the actual location of `Promo/Report/Waitlist/Withdrawal` classes
  inside `<module>/models.py` should be verified on first run.
- **The marker** is `data.seed.source == "seed_practices_v2"`. This
  is the source of truth for "ours vs theirs". **Do not change it
  without a data migration.**
- **TID range** is `10001..10011`. If expanding the master roster,
  use `10012, 10013, ...` (do not overlap).
- **The Pydantic validator `scheduled_at_must_be_future`** is the
  reason for the hybrid path. Don't try to fix it by weakening
  Pydantic.
- **`set_jsonb`** is the only correct way to mutate a JSONB field
  in this codebase (`JSONBMixin` in `app.core.mixins`). Without
  it SQLAlchemy will not commit the dict mutation.
- **Use `is_accepting`, not `accepting_bookings`** in
  `MasterProfile.data.availability` (the old `seed.py` has a bug
  here).
- **Role: `UserRole.MASTER`, not `ADMIN`** — otherwise
  `get_current_master` rejects with 403.
- **DELETE order** strictly follows
  `backend/tests/helpers.py:full_cleanup_range`. Master and
  practice IDs are **collected into Python lists BEFORE the first
  DELETE**, because the JSONB marker disappears once MasterProfile
  is deleted.

**v2.1 additions to remember:**
- **`AuditLog` is imported from `app.core.audit`**, not
  `app.modules.audit.models` (the latter does not exist in the live
  repo). The seeder also imports `create_seed_booking` and
  `project_seed_booking_events` from the **sibling `seed.py`** via a
  `sys.path` bootstrap (`backend/scripts` + `backend` added to path;
  `scripts/` has no `__init__.py`, so `seed.py` imports as a top-level
  module).
- **Test-user marker** is `User.credentials.seed.source ==
  "seed_practices_v2"`. `User.data` does NOT exist — `credentials` is the
  only JSONB sandbox and already holds `onboarding_completed` (don't
  clobber it). Never change a test user's `role`.
- **Personal diary entries** are marked via `DiaryEvent.snapshot.seed`
  (the marker MUST be written *after* the `upsert_entry_event` /
  `project_*` call, because projections overwrite `snapshot` wholesale).
  The `DiaryEntry` row is recovered through `DiaryEvent.source_id`.
- **Test-user cleanup uses the intersection** `user_id ∈ test_users AND
  practice_id ∈ our seed practices` for all practice-linked rows, and
  **never deletes the account** or its non-seed data.
- **All seed practices are free (`price_cents=0`)**, so the zero-amount
  ledger rows can be deleted directly without skewing `User.balance_cents`.
  If a paid practice is ever added, revisit the ledger cleanup.
- **Historical check-ins/feedbacks** must be ORM-inserted + manually
  projected (the service validation windows reject past timestamps);
  backdate `created_at` BEFORE the projection reads it.

### 11.2 Validation checklist for any `seed_practices.py` change

After any edit to `seed_practices.py`:

1. `python -c "import ast; ast.parse(open('seed_practices.py').read())"` — syntax.
2. If `cmd_clean` was touched — verify that master/practice IDs
   are gathered **before** the first DELETE (see §5.5).
3. If imports were edited — verify the new path exists in the project.
4. If a new mode was added — update `argparse` and the file's
   header docstring.
5. Mentally walk through `--dry-run` — what the operator will see
   in stdout.
6. Mentally walk through `--reset --dry-run --yes` — what DELETE
   sequence will be issued.

### 11.3 Validation checklist for any JSON change

1. `python -c "import json; json.load(open('seed_practices.json'))"` — valid JSON.
2. All `masters[].key` unique.
3. All `practices[].key` unique.
4. All `practices[].master` reference an existing `masters[].key`.
5. All `practices[].direction` exist in `practice_allowed_directions`
   in `config.py`. If a new direction was added — backend first,
   then JSON.
6. All `scheduled_at` in ISO-8601 with timezone offset
   (`2026-05-25T08:00:00+03:00`).
7. `status` for practices in the past is `completed` or
   `cancelled`, not `scheduled`.

### 11.4 Validation checklist for any `install_velo.sh` change

1. `diff` against the original — additions only, no deletions or
   modifications of existing logic.
2. `tr -d '\r' < install_velo.sh > /tmp/lf.sh && bash -n /tmp/lf.sh`
   — bash syntax on an LF-converted copy.
3. Extract the embedded `manage.sh` (between `<< 'MANAGE_EOF'` and
   `MANAGE_EOF`) and run `bash -n` on it separately.
4. Line endings: the whole file is CRLF (this is a Windows repo).
   Do not normalize.
5. Case-block structure: every `pattern) ... ;;` branch is
   correctly closed.

---

## 12. Quick reference

### Commands

```bash
# Inspect
velo seed-practices --dry-run
velo seed-practices --reset --dry-run

# Run
velo seed-practices
velo seed-practices --reset
velo seed-practices --clean

# Automation
velo seed-practices --reset --yes
velo seed-practices --clean --yes

# Direct (works without manage.sh update)
docker compose exec app python scripts/seed_practices.py
docker compose exec app python scripts/seed_practices.py --reset --dry-run
```

### File paths

| Purpose | Path |
|---|---|
| Content source | `backend/scripts/seed_practices.json` |
| Script | `backend/scripts/seed_practices.py` |
| Installer (with new branch) | `scripts/install_velo.sh` |
| Backend config (5 new directions) | `backend/app/core/config.py` |
| Existing seed (do not touch) | `backend/scripts/seed.py` |
| Cleanup pattern reference | `backend/tests/helpers.py:full_cleanup_range` |
| `set_jsonb` definition | `backend/app/core/mixins.py` (`JSONBMixin`) |
| `get_current_master` | `backend/app/modules/auth/dependencies.py` |
| `create_practice` service | `backend/app/modules/practices/service.py` |
| `CreatePracticeRequest` schema | `backend/app/modules/practices/schemas.py` |

### Magic values

| Value | Meaning |
|---|---|
| `10001..10011` | TID range of service masters |
| `"seed_practices_v2"` | Marker `data.seed.source` for "ours" (masters/practices); also `credentials.seed.source` (test users) and `snapshot.seed.source` (personal diary events) |
| 5 real tester TIDs | `526738615, 231944851, 792933976, 936933042, 1051790788` (in `test_users`) |
| `is_accepting` | Correct availability field (not `accepting_bookings`) |
| `verified` | Required `data.account.status` for `get_current_master` |
| `UserRole.MASTER` | Required role for service masters |
| `Europe/Moscow` | Default timezone |
| `60` | Default `duration_minutes` |
| `"live"` | `practice_type` for all 14 practices |
| `"eur"` | Default currency |
| 5000 | Max length of `description` / `what_to_prepare` / `contraindications` |
| 200 | Max length of `title` |
| 100 | Max length of `style` |
| 500 | Max length of `zoom_link` |
| 50 | Max length of `timezone` |
| `[5, 480]` | Valid range of `duration_minutes` |
| `[1, 10000]` | Valid range of `max_participants` |

### Allowed enum values

| Field | Allowed values |
|---|---|
| `practice_type` | `live`, `series`, `one_on_one`, `replay` |
| `direction` | `meditation`, `yoga`, `breathwork`, `somatic`, `womens_circle`, `mens_circle`, `tantra`, `kundalini` |
| `difficulty` | `beginner`, `medium`, `high` |
| `currency` | `eur` |
| `status` | `draft`, `scheduled`, `live`, `completed`, `cancelled`, `deleted` |

---

## 13. File tree (TL;DR)

```
velo/                                              ← repo root
├── backend/
│   ├── app/
│   │   ├── core/
│   │   │   ├── config.py                          ← BACKEND: add 5 values to practice_allowed_directions
│   │   │   ├── database.py
│   │   │   └── mixins.py                          ← JSONBMixin.set_jsonb lives here
│   │   └── modules/
│   │       ├── practices/{models, schemas, service}.py
│   │       ├── masters/{models, service}.py
│   │       ├── users/models.py
│   │       └── ... (audit, bookings, diary, etc.)
│   ├── scripts/
│   │   ├── seed.py                                ← EXISTING — do not touch
│   │   ├── seed_practices.json                    ← NEW — content source
│   │   └── seed_practices.py                      ← NEW — the script
│   └── tests/
│       └── helpers.py                             ← full_cleanup_range (cleanup pattern reference)
└── scripts/
    └── install_velo.sh                            ← PATCHED: velo seed-practices branch
```

---

## 14. Full deliverables list and readiness checklist

| File | Size | Purpose |
|---|---|---|
| `seed_practices.json` | ~480 lines | Source: 11 masters + 14 practices |
| `seed_practices.py` | 790 lines | Script: 4 modes, idempotency, FK-safe cleanup |
| `install_velo.sh` | +13 lines vs original | `velo seed-practices` branch + 4 help lines |
| `seed_practices_v2_complete_context.md` | this document | Full handoff context |

Readiness path:

- [x] JSON with content
- [x] Python script
- [x] `install_velo.sh` patch (authored; **not yet re-installed on this VPS** — `velo seed-practices` wrapper absent here, use direct `docker compose exec`)
- [x] Handoff document (this file, now at v2.1)
- [x] JSON validated end-to-end (0 errors, 0 warnings)
- [x] **Backend config: 5 directions added to `practice_allowed_directions`** (done via Claude Code, deployed)
- [x] v2.1: `test_users` user-side seeding added (diary, bookings, check-ins, feedbacks, upcoming, cancelled)
- [x] `AuditLog` import path fixed (`app.core.audit`)
- [x] First `--dry-run` on the stand (clean)
- [x] First real run on the stand (5 test users seeded; `Seed завершён, изменения зафиксированы.`)
- [ ] Re-install `velo` on the VPS so `velo seed-practices` works (optional sugar)
- [ ] Zoom links filled in (when available)
- [ ] Misha Vikhman's bio filled in (when available)
- [ ] Verify the feed visually in-app under each of the 5 tester accounts
