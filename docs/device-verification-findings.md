# Findings behind the items that now await human observation

> **Created 2026-08-15 by Navigator-46, on the owner's ruling that the roadmap stops
> carrying items whose only remaining step is "somebody must look".** Those registry
> entries were REMOVED from `Agent-Velo/BOARD-REGISTRY.md` and its index on the same
> tick. **What could not be removed with them is what they MEASURED** -- code anchors,
> SDK-level analysis and several standing prohibitions, each of which cost real work and
> none of which a tester report would regenerate.
>
> **This file is the destination the board's own de-ballast rule names: REFERENCE moves
> to `velo/docs/`.** It is reference, not open work: nothing here has a closing condition
> and nothing here is a task. The tasks now live with the testers.
>
> ⚠ **READ THIS BEFORE "FIXING" ANYTHING NAMED HERE.** Several of these entries exist to
> stop a future seat from rebuilding something deliberate. The prohibitions are repeated
> on the board under `C · DELIBERATELY NOT FIXED`; the measurements live only here.
>
> Anchors were correct at `e0a9a0b3`. Line numbers drift -- re-derive before citing.

---

## V1

- **V1 · EXCLUDING THE MASTER FROM THE ATTENDANCE COUNT IDENTIFIES HIM BY THE WRONG KEY [adversarial validation №566].** `attendance_service.py:106-145` catches the host ONLY by `zoom_registrant_id` or the registrant email, while since `733a2af` the master enters by the host key (`start_url`) — a different mechanism. **MEASURED: `ZoomMeeting.host_zoom_user_id` is WRITTEN in two places (`zoom/service.py:130`, `retry_poller.py:272`) and READ BY NONE** — re-verified on `e0a9a0b3` 2026-08-15; the anchor read `:125` and had drifted five lines, the write sites and the zero-reader finding both hold — a reliable identifier lies wired-in-nowhere. **PREMISE, unprovable in code:** that Zoom reports a `start_url` entrant with no `registrant_id`. If so, nobody's hours are spoiled (an unidentified row counts to no one) but the master lands in the unidentified bucket on EVERY practice, so the bucket degenerates into noise. **CLOSE: the owner's live experience shows how the host appears in the report, and identification is wired to the key that actually arrives.**

---

## B21

- **B21 · Zoom build risks resolved by nothing but live experience:** whether webhooks are gated by the plan · whether personal links survive a session reschedule · whether a cancelled registrant's link stops working · whether the report survives deletion of a past meeting. Plus the plan: one licensed host runs 1 meeting at a time (Pro) ⇒ a SECOND license is needed exactly from the moment two masters run overlapping. CLOSE: each question closed by observation on a live one.

---

## B33

- **B33 · THE MASTER'S BELL — SHIPPED AND DEPLOYED (`aa44a58a`, live at `d1a59e84`).** Live unread count, a real inbox, all four `/api/v1/notifications` endpoints called. ⚠ v1 does NOT act on `action_data` — a tap marks read and stops; stated in the view header and covered by a test, deliberately. **CLOSE: a master has seen a real count open a real inbox.**

---

## B29

- **B29 · WHITE SLIVERS AT THE KEYBOARD’S ROUNDED CORNERS (`T24-4`) — RECON `№670`, NO FIX BUILT, AND THE SYMPTOM MAY ALREADY BE GONE.** ⚠ **NO SIGHTING AFTER `№650` (`88dadca9`, 2026-08-01, ancestor of `main`) EXISTS IN ANY ARTIFACT** — git, board and `T24-BATCH.md` all pre-date it, and the 2026-08-03 device pass did not show it. Nobody has retested the corners since; that is NOT proof it is fixed (a race that did not fire once still fires). ⚠ The earlier board text (freeze runs before `expand()`) was STALE — `№650` made `scheduleInitialFreeze()` (`useBackgroundStabilizer.ts:97-118`) poll `viewport.isStable()` first. **THE LIVE CANDIDATE, measured in the installed SDK:** `isStable = height() === stableHeight()` (`@tma.js/sdk/dist/index.js:3469`) means "Telegram is not animating", which the PRE-EXPAND steady state also satisfies; android is absent from the fast-path list at `:3747`, so `viewport.mount()` (`main.ts:36`, module load) does a real round-trip that can resolve BEFORE `webApp.expand()` (`telegram.ts:52`), which runs only from `App.vue:108` — after the freeze’s own first tick (`App.vue:73`). Band colour = `--velo-tg-bg` `#ffffff`. **CLOSE: someone looks at the corners on the CURRENT build — until then no fix ships, because the correctness of any re-sequencing is a device-only claim.**
  > 📄 **THE WHOLE DIARY SAGA NOW LIVES IN `velo/docs/diary-behaviour-spec.md` (rulings 1-6, the device measurement, what died and what survives) AND `diary-behaviour-map.md` (what the screen did before). Board keeps only what must be known BEFORE acting.**
  > ✅ **ROOT CAUSE FOUND AND FIXED, device-confirmed.** The Android keyboard was NEVER DETECTED: Telegram reported `viewportHeight` = `viewportStableHeight` = 523.7 with the keyboard up, a delta of 0 against a threshold of 150, so `is-keyboard-open` never set and NEITHER positioning rule had ever matched. Five cycles refined formulas behind a gate that never opened. Detection now runs off a self-captured rest-height baseline; on his device it reads `keyboardOpen true` and `pageTop` 0 (was 263.53). **APP-WIDE:** `.velo-kbd-scroll` (auth, onboarding, modals, sheets, admin) and the tab-bar hide now fire on Android for the first time — NONE device-verified.
  > ✅ **RULINGS 4→5→6 ALL LANDED IN ONE DAY AND 6 REVERSES MOST OF 4 AND ALL OF 5** — the owner looked at each shipped build and ruled on it, which is the order he demanded after five source-reasoned failures. Final shape: NO fog, NO dim, content fully visible and pushed up by the growing composer, keyboard STAYS after Send (3b), header never moves (2), only the field itself frosted. **Rulings 3 and 5 are STRUCK in the spec, not deleted — delete them and someone restores the freeze from git.**
  > ⚠ **ONE ITEM CARRIED, NOT TWO — corrected 2026-08-04 by Navigator-42 at boot, against my stale text.** `.velo-kbd-scroll` was FIXED at `№666` and already subtracts the safe area (`global.css:296`). **The only raw cap left is `global.css:321`** on `.v-modal__overlay`/`.v-sheet__overlay`, and it cannot take the same fix: both components `Teleport to body`, so they are siblings of `#app` and cannot inherit `--velo-content-safe-top` — it would resolve to `0px` forever, a no-op dressed as a fix. **CLOSE: the var is published where teleported content can inherit it, and the overlay subtracts it.** ⚠ I carried the PRE-FIX flag past its own fix and quoted comment lines as the rule (`§2.1`).

---

## T24-1

- **`T24-1` · THE DIARY COMPOSER DOES NOT SIT ABOVE THE ANDROID KEYBOARD — DEVICE-REPORTED, NEVER RE-VERIFIED, AND IT HAD NO ENTRY IN THIS FILE UNTIL 2026-08-14.** Agreed behaviour (`T24-BATCH.md:52-57`): once the keyboard opens the input window sits ABOVE it with NO buttons below. Measured from the owner's four screenshots: keyboard closed → field at the bottom, chevron left, mic+send right; keyboard OPEN → **the field is not visible at all, only a round floating button remains**; iPhone behaves correctly. Same build, two platforms, two results. A REGRESSION on the `DIA` composer rebuild (`5647eacc`), not a missing feature. ⚠ **PLAUSIBLY ALREADY CLOSED AND NOT CLOSABLE FROM HERE:** `B29`'s entry records the root cause of this whole family as FOUND and FIXED — the Android keyboard was NEVER DETECTED (`viewportHeight` = `viewportStableHeight`, delta 0 against a threshold of 150), so NEITHER positioning rule had ever matched; detection now runs off a self-captured rest-height baseline and reads `keyboardOpen true` / `pageTop 0` (was 263.53) on his device. That is the exact mechanism this item describes, so the fix very likely took it — **but "very likely" is not a sighting, and this is a device-only claim.** ⚠ **WHY IT WAS MISSING, recorded because the bookkeeping defect is the reusable part:** the board's COUNTER block asserted `T24-1` was open AND that this file carried it. It carried nothing — 0 hits here, 0 in the OPEN-WORK INDEX, 1 on the board, which was the false claim itself. **The ID-set check cannot ever catch this class: it compares the index against this file, and an item whose only claim to existence lives in a THIRD block is outside both sides of the comparison.** The check is sound; its scope is narrower than the invariant's attack surface. **CLOSE: someone opens the diary composer on an ANDROID device on the current build and sees the field above the keyboard — or the owner rules it closed on a build he has already looked at, since rulings 4→5→6 were made screen-in-hand.**

---

## PK-Z2

- **PK-Z2 · DEPLOYED 2026-08-08 (`83b27ca3`, live in `3e4ccabc`); the temporary local type was removed after the regen (`eb2fe3e1`, unpushed).** `ZoomMeeting.last_sync_error` (16 writes, zero readers) now reaches the admin practice screen as the raw recorded string — no translation layer is invented (`B8`). Backend field + a scoped local type that deletes itself at the next `generated.ts` regen. ⚠ **MEASURED THIS CYCLE AND LEFT OUT OF SCOPE ON PURPOSE: `ZoomRegistrant.last_sync_error` (`zoom/models.py:227`) is the same blindness one level down** — why ONE participant’s personal link failed — and nothing reads it either. ⚠ This endpoint has NO backend test at all (`attendance` occurs zero times in `test_admin_practices.py`); pre-existing, not created here, and not expanded into with the local pytest gate down. **CLOSE: deployed, and an admin has read a real reason off the screen.**

---

## T-37

- **`T-37` · «WHO IS A STUDENT», DISPLAY HALF — BUILT AND COMMITTED `2396fb6c`, UNPUSHED.** `_derived_students_base` is now a UNION over four sources (non-cancelled bookings, chat threads, waitlist at ANY status, ANY group membership), deduped by the union itself, with `blocked_at IS NULL` applied ONCE to the unioned ids so it covers every source by construction. `practices_count` comes from a LEFT JOIN so a chat-only contact survives at 0. No migration, no new API field, no preview — `GroupMemberItem` has no `practices_count` to expose. ⚠ **`is_master_audience_member` lost its second branch: group membership is now a union source, so the derived check is a strict SUPERSET of the old (derived OR group) — the change can only widen. Consequence, tested: `get_master_student_detail` opens for a chat-only contact although its own code was never touched.** ⚠ **`№609` STANDS UNTOUCHED — «Мои ученики» stays ATTENDED-only and is NOT unified with display. Do not "finish" that.** ⚠ **RULED 2026-08-14, option A: A CANCELLED BOOKING IS A CONTACT and the person appears.** His reason: he had already ruled the same way twice (group membership, declined waitlist) on one logic — the list must not lose someone the master had contact with — and an unexplainable exception survives only until the first person who tidies it. **AMENDMENT PENDING on `№707`: widen the booking CONTACT source only. `practices_count` must NOT count cancelled bookings — a cancelled-only contact shows 0, like a chat-only one.** **CLOSE: the amendment ships and the widened list is deployed and seen by a master.**

---

## B13

- **B13 · The `promote` seam is not checked end-to-end:** the frontend tests check the arguments of a mocked call, the backend tests — the server side, there is no live pass through both layers. CLOSE: one end-to-end pass.

---

## B24

- **B24 · The attendance verdict lags ~15 minutes** (`zoom_report_ripen_margin_minutes = 15`, deadline 2 hours) — a deliberate cost of working via the API instead of the SDK. The community gets by with 15-30 seconds, but their numbers were taken not under our load. CLOSE: revisited AFTER the first live report, with our own measurement.

