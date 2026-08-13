# Attendance accounting — how the three axes work

> **Reference, lifted out of `Agent-Velo/DS-build-plan.md` on 2026-08-14 because that file is
> every-boot and was at its 60,000-byte ceiling.** Nothing here is open work: the OPEN findings
> (`AT-1` identification, `AT-3` the shared link) and the ENV-only knob rule stay on the board,
> which points here. The text below is the board's own, moved verbatim.
> ⚠ Every `file:line` was true when written. Re-derive before acting.
>
> Origin: the owner's option-B decision of 2026-07-23, from recon `№584`.

## How accounting works NOW

1. **Threshold = 50% of the practice DURATION**, live since `dc90160f`: `attendance_threshold_seconds(duration) = (duration // 2) * 60` (`zoom/attendance_service.py:83`), the owner's mapping (30→15 · 45→22 · 60→30 · 75→37 · 90→45 · 120→60) asserted literally in `test_zoom_attendance_ladder.py`. The old `zoom_attendance_threshold_minutes` env knob is vestigial, zero readers. Accepted once: the API validator admits `5..480`, so a call made outside the UI yields a 2.5-min threshold — total over that range by test, no floor invented. Compared in SECONDS; rejoin is summed. `zoom_minutes_present` is UI only.
2. **Timing:** NOT real time — the Zoom report, worker `report_poller.py`. The verdict no earlier than `end of practice + 15 min` (`zoom_report_ripen_margin_minutes`, `config.py:454`), deadline `+120 min` (`zoom_attendance_decision_deadline_minutes`, `config.py:463`). Counted from the end of the WHOLE practice, NOT from the person's exit.
3. **Identification:** `registrant_id → email → unmatched` (`attendance_service.py:93-145`). Email is synthetic `user-{id}@…invalid`, NOT used as a key (`service.py:79-87`). Only `registrant_id` actually works, and it exists ONLY for entry via the personal link; any other entry → `unmatched` → not counted at any presence. Fallback (stub / report didn't arrive by the deadline): binary `joined_at`/pre-checkin (`bookings/service.py:600-640`), not minutes.

**How accounting works NOW (three independent axes; axis 1 re-anchored to `dc90160f` 2026-07-28, axes 2-3 last verified on `a4c2fa9` and unchanged since):**
