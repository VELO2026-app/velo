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
directly rather than looked up.

## The bands

| Band | Holder | Note |
|---|---|---|
| `70000`-`70099` | T-31 seed | |
| `89760`-`89899` | velo's free window | the space we allocate from |
| `89780`-`89799` | T-20 | reserved |
| `89800`-`89839` | T3 students | claimed at `69035333`, vacating `89760`-`89799` |

## Why vacating one band into another is not a fix

`69035333` moved T3 off T-20's reservation by claiming `89800`-`89839`. **That is a relocation, not a fix,
and nothing checked the destination** — three days later our own T-37 amendment (`14244b22`) claimed inside
that same span, producing the 32nd overlap. **Check the destination before you claim a band.**

⚠ **`_clean_band` DELETES EVERY USER IN RANGE AND COMMITS.** An overlap here does not merely clash on ids —
it destroys the other file's fixtures mid-run. That is why this is a hazard and not an untidiness.

⚠ **The ids are often COMPUTED, not literal** (`BAND_MIN + 15`), so a grep for `8981[0-9]` returns a
comment and reads CLEAN. The obvious pattern cannot see the collision — read the band declaration, not the
usages.

⚠ **Wider instance, not firing today:** `test_ai_summary.py` runs `full_cleanup_range(89000, 89999,
delete_users=False)` — the WHOLE `89xxx` space, with 18 other test files placing ids in it. It spares user
rows and deletes everything hanging off them. There is no `pytest-xdist` config and no CI, so a serial run
has each file clean before the next starts. **It fires the moment anything runs in parallel, or two runs
share the stand.**
