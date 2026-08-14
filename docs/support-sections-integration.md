# Support chat on comms sections — the contract, and the one trap

> **UNBLOCKED 2026-08-14.** The comms side shipped `POST /api/v1/sections` and handed over a
> manual. Support had been blocked on that endpoint since 2026-08-12, and our own account-based
> version was built and WITHDRAWN before pushing — it would have handed every admin the private
> conversations of whoever the support account belonged to.
>
> ⚠ **THIS IS OUR ENGLISH RESTATEMENT, NOT THEIR DOCUMENT.** Their manual is Russian and arrived
> as an external artifact; it is deliberately NOT tracked here, because every tracked document in
> this fleet is English (`Claude-Profile-Rules` LANGUAGE, no carve-out) and translating another
> party's contract note would make our paraphrase look like their words. On any dispute, THEIR
> file is the source, not this one. Their base: comms `origin/main` `8d2904c`.
> ⚠ Nothing here has been exercised against a running comms. Every line is READ, not RUN.

## 1 · The endpoint

`POST /api/v1/sections`, `Authorization: Bearer <COMMS_SERVICE_TOKEN>`, body
`{"key": "support", "label": "<human label>"}` → 200 with `{id, key, label, created_at}`.

Both fields required, `min_length=1`; empty string, missing field or over-long value → 422.
Called through OUR proxy like every other comms endpoint — the frontend never talks to comms.
The token already exists in `backend/.env`; the installer delivers it.

## 2 · CREATE-OR-FIND, not upsert — three consequences

- **A repeat POST with the same `key` returns the SAME section.** Not an error, not a 409.
- **`label` is NOT updated on a repeat.** Posting a known key with a new label is a successful
  no-op returning the OLD label. There is no rename through this endpoint. "It didn't rename" is
  the contract, not a bug — do not debug it.
- **There is no `created` flag, deliberately**, unlike the neighbouring `POST /threads`. Under a
  race both callers miss the row, one inserts, the other resolves onto the winner's row — and
  both would report `created=true` for one row. A flag that can be true twice is worse than no
  flag. Do not ask for it "for symmetry".

The race is arbitrated by the database: a unique index on `key` turns the losing insert into an
`IntegrityError` that resolves to the existing row. We need no locking and no "does it exist?"
pre-check.

## 3 · THE HARD RULE: never persist the section id

**Call it LAZILY, from product code, every time the id is needed** — not at application start,
not from the installer, not once by hand. Caching in process memory is fine.

**The id must not survive a teardown: not in env, not in config, not in a table of ours, not in a
migration, not as a frontend constant.** The section lives in the comms database, and
`docker compose down -v` takes it with the volume; after a reinstall the id is DIFFERENT. The
source of truth is the key `support`, and the id is fetched each time.

Lazy get-or-create buys reproducibility for free: the first call after a teardown recreates the
section. Neither our installer nor our infrastructure ever learns that sections exist.

Rejected on their side, so nobody re-proposes them: calling it from the velo installer (the
installer would start knowing about product sections), and having comms create it at startup
(comms would start knowing which section a product needs — a direct loss of agnosticism).

## 4 · Wiring a thread to the section

A section thread is an ordinary `POST /api/v1/threads` with `operator_kind = SECTION` and
`operator_value = <section id>`. After that everything already built applies: `claim` to take a
thread, retag to move it, and the ordinary feed / send / read / unread-count endpoints.

**Operator membership in sections is NOT modelled in v1** — any agent serves any section.

## 5 · ⚠ THE TRAP: an unclaimed thread notifies nobody

Message notifications are emitted by the engine in the same transaction as the message row, and
they branch on the sender: a sender who is not the thread's client notifies the CLIENT
(`msg.participant_message`); a non-empty assignee who is not the sender notifies the ASSIGNEE
(`msg.support_message`).

**A section thread has an EMPTY assignee until someone claims it.** A push to a pool of agents is
deliberately deferred on their side and marked in their code as an accepted ceiling. So:

> Until the thread is claimed, **the operator is notified of nothing.** A person writes to
> support and nobody learns of it until someone opens the list and takes the thread.

The student↔master DM does not have this problem: there the assignee is prefilled with the master
at creation, so notifications flow both ways immediately.

**This is ours to solve, and they named three shapes without choosing:** show the unclaimed queue
as an active screen rather than a list someone must remember to open; auto-claim when there is in
practice a single operator; or ask them for a pool push, which becomes a trigger on their side.
**The choice is a product decision and belongs to the owner.**

## 6 · Operational notes worth keeping

- The comms image has no `curl` (deps-only Dockerfile). Probe endpoints from inside the box with
  Python's `urllib` via `docker exec -i comms-app python3 -`. **The `-i` is mandatory** — without
  it stdin is not attached, the script silently reads EOF, and you see neither error nor output.
- To prove the SAME row came back rather than a recreated one, compare `created_at` to the
  microsecond, not `id`. An upsert would have matched the id too.
- The key `support` is ours and collides with nothing: keys are unique per installation, and each
  product has its own server, comms stack and database.
- Their CLI gained `start`/`stop`, so `velo stop` now brings down the WHOLE box including the
  comms stack, and `velo start` raises it in dependency order. **Only `install_velo.sh` and the
  `velo` commands are ever executed on the server** — running their deploy script directly is
  forbidden, not merely discouraged.
