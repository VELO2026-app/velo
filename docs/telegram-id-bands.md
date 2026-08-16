# VELO — `telegram_id` test-band registry (reference)

> **Moved off `Agent-Velo/DS-build-plan.md` 2026-08-16 by Navigator-47**, under that file's own de-ballast
> rule: the only levers left are removing what is CLOSED and moving REFERENCE into `velo/docs/`. These are
> lookup values, consulted when a test file claims a band — not open work, and not something a cold seat
> needs on the boot path. **The PROHIBITION stays on the board; only the numbers moved here.**
> ⚠ The open work this reference serves is `T-28`, which lives in `Agent-Velo/BOARD-REGISTRY.md`. This file
> does not track it and does not close it.

## The hazard, stated first

**The band registry is SPLIT ACROSS TWO REPOS, and that is the whole problem.** Ours is here; the
teammate's is his `dispatcher-plan §5`. ⚠ **Measured 2026-08-15: `dispatcher-plan §5` DOES NOT EXIST AS A
FILE in either repo** — the comms repo tracks exactly one document, `deploy/INTEGRATION.md`, and it names
no band and no migration. So the other half of this registry is not readable by us and has to be asked for
directly rather than looked up. ⚠ **Re-fetched 2026-08-16 (Orc-92): `origin/test` and `origin/main` both
came back `[up to date]`** — the clone's tip, `9474751` (test, 2026-08-14 02:19:51), is not stale, it is
current; nothing new landed upstream since. A repo-wide grep for `89[0-9]{3}` across every tracked `.py`/
`.md` in that clone returns **0 hits** — the comms side genuinely claims no id in this space, measured, not
assumed from silence.

## The bands

| Band | Holder | Note |
|---|---|---|
| `70000`-`70099` | T-31 seed | |
| `89760`-`89899` | velo's free window | the space we allocate from |
| `89780`-`89799` | T-20 | reserved |
| `89800`-`89839` | T3 students (`test_chats_t3_students.py`) | claimed at `69035333`, vacating `89760`-`89799`; sweeps the whole span on cleanup |
| `89800`-`89809` | T-37 original decade (`test_master_groups.py`) | sub-claim inside T3's swept span, pre-existing, accepted (not a live overlap — T3's own literal usage starts at `BAND_MIN+15`, i.e. `89815`) |
| `89840`-`89859` | `test_zoom_public_link.py` (teammate, `origin/test`) | |
| `89860`-`89869` | T-37B (`test_master_groups.py`) | **RESOLVED** — relocated here from the colliding `89810`-`89819`, see below |
| `89870`-`89899` | `test_support_t1.py` | widened `PROMPT №713`, per-id rescan before the widen |

## Why vacating one band into another is not a fix

`69035333` moved T3 off T-20's reservation by claiming `89800`-`89839`. **That is a relocation, not a fix,
and nothing checked the destination** — three days later our own T-37 amendment (`14244b22`) claimed inside
that same span (`89810`-`89819`), producing the 32nd overlap.

✅ **RESOLVED AND COMMITTED, re-derived 2026-08-16 (Orc-92): `f3e4f41f` moved T-37's second decade off the
published `89800`-`89839` span; `bbde7b48` relocated it again after a fetch showed the teammate had already
claimed the first landing spot (`89840`-`89859`) on `origin/test`. It now sits at `89860`-`89869`, verified
free on both sides at the time of the move and unclaimed by anything since — a fresh grep across every
`backend/tests/*.py` finds zero literal `8981[0-9]` usage left anywhere (only historical comments). Tree is
clean on `test_master_groups.py`, `test_chats_t3_students.py` and `test_ai_summary.py`; `14244b22` and both
follow-ups are ancestors of `HEAD`.** **Check the destination before you claim a band — this is the
recorded instance of doing so, not an open one.**

⚠ **`_clean_band` DELETES EVERY USER IN RANGE AND COMMITS.** An overlap here does not merely clash on ids —
it destroys the other file's fixtures mid-run. That is why this is a hazard and not an untidiness.

⚠ **The ids are often COMPUTED, not literal** (`BAND_MIN + 15`), so a grep for `8981[0-9]` returns a
comment and reads CLEAN. The obvious pattern cannot see the collision — read the band declaration, not the
usages.

⚠ **Wider instance, not firing today:** `test_ai_summary.py` runs `full_cleanup_range(89000, 89999,
delete_users=False)` — the WHOLE `89xxx` space. ⚠ **RE-MEASURED 2026-08-16 (Orc-92), corrected from "18
other": `grep -rl -E '89[0-9]{3}' backend/tests/*.py` returns 22 files; four are false positives (two IBAN
strings `DE89370400440532013000` in `test_admin_withdrawals.py`/`test_withdrawals.py`, one comment-only
cross-reference in `test_ledger.py` that claims no band of its own, one explicit self-exclusion in
`test_student_entitlement_t20.py`). Genuine denominator: 18 files place ids in `89xxx`, `test_ai_summary.py`
itself among them — 17 OTHER files, not 18.** It spares user rows and deletes everything hanging off them.
There is no `pytest-xdist` config and no CI, so a serial run has each file clean before the next starts.
**It fires the moment anything runs in parallel, or two runs share the stand.**
