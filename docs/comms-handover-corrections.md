# What the comms side's answers corrected

> **Moved out of `Agent-Velo/DS-build-plan.md` 2026-08-15 by Navigator-46** under that file's own de-ballast rule: the only levers left are removing what is CLOSED and moving REFERENCE into `velo/docs/`. These are CORRECTIONS the backend teammate's answers made to what our board and our tester brief had said — settled facts, not open work. **Nothing here has a closing condition.**
> Kept because each one reverses something we told somebody: if a tester or a seat repeats the old claim, this is the record that refutes it.

---

## Corrections — corrections to what this board and our tester brief said
- ⚠ **NOTIFICATIONS ON A NEW CHAT MESSAGE EXIST AND ARE BY DESIGN — we told the testers the opposite and had to correct it.** `comms/app/api/messaging.py:295` calls `notify_new_message` IN THE SAME TRANSACTION as the message row: never a message without a ping, never a ping without a message. velo emitting nothing is CORRECT — `msg.*` is the messaging engine's to emit, not the product's. **If a tester reports no notification, that is a DELIVERY bug (channel/mode/profile), not an absent feature.**
- **Prefs `categories` is PARTIAL — there is no data-loss risk and our one-key send is right.** `schedule` is a FULL replace (all three fields) and `null` clears it; unknown body keys including `timezone` are 422, not ignored.
- **The bell is UNBLOCKED: the inbox item shape is frozen and given**, and `unread` arrives in the same response — `/unread-count` is not needed for the badge. Our `/api/v1/notifications` is a byte-for-byte passthrough, so his shape IS what the frontend receives.
- **Message order (newest-first) and field names (`sender`, `created_at`) confirmed — we read them correctly.**
- **Support is unblocked BY HIM, not by us: he is building an idempotent `POST /sections`.** He REFUSED to hand over a hand-made section UUID, and the reason is worth keeping: the section lives in the comms DB, and a `docker compose down -v` takes it with the volume — support would break on the next reinstall with nobody able to connect cause to effect. ⚠ Until `claim`, an unassigned section thread has no assignee and the operator gets NO notification — a deliberate ceiling.
- ⚠ **MY `env-render.sh` RECONSTRUCTION CARRIED A REAL SECURITY BUG AND HIS MERGE FIXED IT.** My `[ -z "$line" ]` tested the LINE, not the VALUE, so `POSTGRES_PASSWORD=` passed and postgres would have come up WITHOUT AUTHENTICATION — the exact outcome my own comment called the worst. His original had the mirror defect (`grep -m1` takes the FIRST duplicate; the file is read as shell assignments, so the LAST wins). Merged in his `b455559a`, 47 fixtures green. **Do not re-open, and do not treat my version as the reference.**
