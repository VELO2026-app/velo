# Zoom Audit — Probe Definitions

Static-audit probes for VELO's Zoom integration code (VELO-tuned at birth, PROMPT №624).
All ten probes are LIVE. Read severity markers from `probekit-core/references/severity-format.md`
— the CRITICAL/HIGH/MEDIUM/LOW label on each probe below is this skill's own default-severity
tier (matches the convention in `probekit-design-audit`/`probekit-responsive-audit`); the actual
finding in a report still carries a 🔴/🟡/🟢/💎 marker per the core decision tree.

Every probe here was paid for with a real defect already found in this codebase or on this
Zoom account — not a hypothetical. The citation in each probe is the paid-for instance, kept
as a worked example; re-derive the line number before trusting it (`validation-anti-bias.md`
Rule 4 — a cited line decays, the grep that finds it does not).

## P1: Zero-Result False Positives (CRITICAL) — a process rule, not a code pattern

This probe governs how EVERY OTHER probe in this skill is allowed to report "no issues found."

**The rule:** a probe MAY NOT conclude "clean" from an empty grep, an absent field, or zero
matching rows unless it also ran a CONTROL proving the search mechanism can fire at all —
a query for something KNOWN to exist in the target, confirmed to return a hit. An empty result
with no control is not evidence of absence; it is evidence the search may be broken, scoped
wrong, or looking for the wrong vocabulary.

**Detection (self-check, run before reporting any probe below as clean):**
```bash
# Control: does the target directory even contain Zoom code at all?
grep -rln "zoom" backend/app/modules/zoom/ | wc -l
# If this returns 0, every other probe's "0 findings" in this run is void --
# the scan never touched real Zoom code, for whatever reason, and must be
# fixed before any other probe's silence means anything.
```

Applied at the CODE level, not just the scan level, this same shape recurs across the Zoom
module and is itself a finding class: a function that returns `None`/`[]`/`{}` on both "nothing
to report" and "the query/lookup itself failed silently" collapses two different facts into one
observable state, and a caller reading that state as "all clear" cannot tell which one it got.

**Why it matters:** this is the single most expensive lesson of the last 24 hours, independent
of Zoom specifically — three of the ten checks in this file exist because a narrow probe or a
narrow read returned nothing and was trusted. `probekit-core/references/validation-anti-bias.md`
Rule 2 (PROVE-ZERO) is the general form; this probe is that rule pointed at Zoom.

## P2: Token-Cache Latency Assumptions (WARNING)

`zoom/zoom_client.py`'s `_get_access_token` caches the S2S OAuth token for `expires_in - 60`
seconds (`zoom_client.py:132`, `_token_cache` declared `:61`). A scope or permission change made
in the Zoom Marketplace console does NOT reach the running app until the cache expires or the
process restarts — up to roughly an hour, not immediately.

**Detection:**
```bash
grep -rn "is_zoom_stub\|_get_access_token\|_token_cache" backend/app/modules/zoom/*.py
```
Then read every call site and any comment near it for language implying a permission/scope
change takes effect on the next request, the next deploy, or "immediately" — none of those are
true without a restart or a natural cache expiry.

**Why it matters:** a live-account debugging session that changes a scope and re-tests within
the same hour will see the OLD scope set and misdiagnose a working change as broken (or the
reverse — a still-broken change that happens to work because a stale cached token from a wider
scope grant is still in play). Paid for directly: the owner's own console changes in this
session (scopes, `auto_recording`) only became visible to the running app on its next token
fetch or restart, not the instant they were saved.

## P3: Account-Level Settings Overriding Per-Meeting API Fields (WARNING)

Proven on `auto_recording`: setting `"auto_recording": "cloud"` in the create-meeting payload
(`zoom_client.py:286`) does not itself decide whether a meeting records — Zoom's account-level
"record automatically" setting governs, and the per-meeting field is honored only when it
agrees, or is silently overridden when it doesn't. Recording only actually started once the
owner changed the ACCOUNT setting in the console (PROMPT №618/619); the code-level field had
been present the whole time this session and did nothing on its own until then.

**Detection:**
```bash
grep -n '"settings":' -A 10 backend/app/modules/zoom/zoom_client.py
```
Read every key inside that `settings` dict (`approval_type`, `registrants_email_notification`,
`join_before_host`, `auto_recording`) and check whether any comment or docstring nearby claims
the field is sufficient by itself, without naming the account-level setting it depends on.

**Why it matters:** any future per-meeting field added here (recording layout, transcript,
waiting room) is subject to the same trap — a code review that only reads this file will
conclude the feature is controlled, when the account console is the actual switch. A comment
claiming otherwise will mislead the next engineer who has no console access to check against.

## P4: Write-Only Zoom Fields (WARNING)

`ZoomMeeting.host_zoom_user_id` (`zoom/models.py`) is written at `zoom/service.py:125` and
`zoom/retry_poller.py:272`, and read nowhere in the backend — verified by an exhaustive grep,
not by absence-in-one-file.

**Detection:**
```bash
# Every column on ZoomMeeting / ZoomRegistrant / ZoomAttendanceSegment:
grep -n "Mapped\[" backend/app/modules/zoom/models.py
# For each column name found, count writers vs readers:
grep -rn "<column_name>" backend/app/modules/ backend/tests/ | grep -v "models.py"
```
A column with 1+ writers and 0 readers outside `models.py`/tests is the pattern. Confirm by
reading BOTH write sites (not just grepping the name) — a write-only field can still matter for
audit trail / debugging (raw dumps, admin views not yet built) and this probe does not judge
which; it only surfaces the fact for a human to classify.

**Why it matters:** every persisted field is a real cost — a migration, an index maybe, a row
in every future dump — and a write-only field is either dead weight that should be removed, or
a forgotten capability (here: `host_zoom_user_id` is explicitly documented as a "secondary
defense for host exclusion" that nothing currently calls on, `models.py`'s own docstring)
sitting unused while its problem is solved a different way. Either answer is worth a report
line; silence is not.

## P5: Identification-Chain Overreach (CRITICAL)

The attendance matching ladder is `registrant_id -> email -> unmatched`
(`attendance_service.py:14`, ladder logic `:118-157`). VELO users have no real email by design
(`zoom/service.py:80-87`, `_registration_email_for`); the email sent to Zoom is almost always a
synthetic `@users.velo.invalid` placeholder, and `PLACEHOLDER_EMAIL_SUFFIX` detection
(`attendance_service.py:62,68`) guarantees a placeholder NEVER matches, on either side. So in
practice only `registrant_id` ever actually resolves a person — and `registrant_id` exists ONLY
for a participant who joined through their own personal Zoom link. Any other entry path lands
in `unmatched` and that person's attendance is counted to nobody, silently — no error, no log
line a human would notice, just a segment with `matched_registrant_row_id = NULL`.

**Detection:**
```bash
grep -rn "registrant_id\|by_email\|_normalized_matchable_email" backend/app/modules/zoom/attendance_service.py
```
For any NEW code path touching attendance matching, verify it does not assume the email rung is
a reliable fallback, and does not invent a third identification key without also handling the
case where that key is absent or synthetic.

**Why it matters:** this is the highest-severity check in the file because a wrong assumption
here does not crash or error — it silently mis-attributes or drops real attendance data, which
is exactly the class the honesty rules in `severity-format.md` single out ("assertion-free code
that silently passes → always CRITICAL"). The board tracks this as open finding `AT-1`.

## P6: Deletion-Asymmetry Assumptions (WARNING)

A `ZoomMeeting` is deleted (`status` set to `deleted`) in exactly one code path:
`delete_meeting_for_practice` (`zoom/service.py`), called from exactly one site,
`practices/cancel_service.py:125`, fired only on master-initiated cancellation. A practice that
runs to COMPLETION never has its meeting deleted — the row (and the underlying Zoom meeting)
persists indefinitely. Verified exhaustively: grepping every write of `ZoomMeetingStatus.DELETED`
across the backend returns exactly the one production call site, one test, and the docstring
that names it.

**Detection:**
```bash
grep -rn "ZoomMeetingStatus.DELETED\|delete_meeting_for_practice" backend/app/
```
Read every hit. Flag code (or a comment) that assumes a COMPLETED practice's meeting is gone
(e.g. treating a missing meeting as the normal end-state for a finished session), and flag code
that assumes a CANCELLED practice's meeting still exists (e.g. attempting to fetch a join/start
link for one without handling `ZoomMeetingStatus.DELETED`).

**Why it matters:** the direction that's easy to get wrong changes depending on which feature is
being built. REC-1 (watch-recording) depends on completed-practice meetings persisting and
would have been broken by assuming otherwise; a hypothetical "clean up old meetings" job would
break if it assumed cancellation was the only path that ever needs to run, since it already is.

## P7: Collapsed Failure States (CRITICAL)

"The thing is absent" and "the call to find out failed" must never be the same observable
state. The recording endpoint (`bookings/router.py`, `GET /{booking_id}/recording`) is the
reference implementation: it returns three DISTINCT states — `available` / `unavailable` (Zoom
confirmed nothing there) / `error` (the Zoom call itself failed) — and never lets one stand in
for another (`bookings/schemas.py`, `BookingRecordingResponse` docstring).

**Detection:**
```bash
grep -rn "except ZoomAPIError\|except Exception" backend/app/modules/zoom/*.py backend/app/modules/bookings/*.py backend/app/modules/practices/cancel_service.py
```
For every except block found, read what the caller does with the outcome. Flag any path where
a 404-shaped "not found" and a 5xx/network failure are handled identically (same return value,
same log level, same downstream branch) — the caller loses the ability to distinguish "nothing
to show" from "we don't actually know."

**Why it matters:** a collapsed state is invisible until the failure case actually happens, at
which point it reads to a human as confirmed absence rather than an open question — the exact
shape of the class named in P1, applied specifically to error handling rather than search
tooling.

## P8: Stub-Mode Divergence (WARNING)

`settings.is_zoom_stub` (`core/config.py:623`, consumed at `zoom_client.py:156`) switches every
Zoom call between a real HTTP request and a deterministic fake response
(`zoom_client.py:186-232`). Logic whose real-world correctness depends on details the stub does
not faithfully reproduce (exact response shape, error codes, timing) can pass every test while
being wrong against the real API — because the tests never left stub mode.

**Detection:**
```bash
grep -n "is_zoom_stub" backend/app/modules/zoom/*.py backend/app/core/config.py
grep -rln "monkeypatch.setattr(settings, .zoom_" backend/tests/
```
Cross-reference: for any function whose behavior branches on `is_zoom_stub` (directly or via a
caller that does), confirm a test exists that forces BOTH states — stub (the default) AND real
credentials via `monkeypatch.setattr(settings, "zoom_client_secret", ...)`, the pattern already
used in `test_zoom_attendance_decision.py`. A function tested only under the default stub state
has unproven behavior on the branch that matters in production.

**Why it matters:** stub mode exists specifically so this codebase's test suite can run without
live credentials — but that convenience is exactly what lets a stub-only-tested code path ship
untested against the one mode where it actually runs for real users.

## P9: Attendance Lock Weakening (CRITICAL) — SW1

Both booking reads inside the attendance-decision path take `with_for_update()` AND re-check
`booking.status == CONFIRMED` under that lock before writing a verdict —
`attendance_service.py:263,266` (`ingest_report_for_meeting`) and `:339,341`
(`apply_legacy_proxy_fallback`). This is the fix for a lost-update race: without both the lock
and the re-check, a booking cancelled between the read and the write could have its cancellation
silently reverted by an attendance decision that started before the cancel committed.

**Detection:**
```bash
grep -n "with_for_update\|BookingStatus.CONFIRMED" backend/app/modules/zoom/attendance_service.py
```
Confirm BOTH properties are still present at BOTH sites: the `.with_for_update()` on the
`select(Booking)` query, AND a status re-check comparing against `CONFIRMED` (or the relevant
live status) that skips the write when it no longer matches. Either one alone is insufficient —
the lock without the re-check still races a cancel with no CONFIRMED check to catch it, and the
re-check without the lock reads a value that can change before the write commits.

**Why it matters:** this exact discipline is tracked on the board as SW1 with an explicit
standing instruction: "line numbers shift; the discipline does not" — any future edit to this
file must be checked against this probe before merging, not just diffed by eye.

## P10: Env-Only Knob Documentation Drift (WARNING)

`zoom_report_ripen_margin_minutes` (15, `config.py:460`) and
`zoom_attendance_decision_deadline_minutes` (120, `config.py:469`) are configured ONLY in the
server's `.env` file. There is no admin UI, no settings table, no API endpoint for either —
the project has no general admin-settings mechanism at all, and building one for two numbers
was explicitly rejected (board ruling: "RE-OPEN ONLY IF a second attendance parameter
accumulates AND an admin surface is built for the whole set — never for one number.").

**Detection:**
```bash
grep -rn "zoom_report_ripen_margin_minutes\|zoom_attendance_decision_deadline_minutes" backend/ frontend/
```
Flag any doc, comment, or (especially) frontend UI copy that implies these are admin-
configurable, adjustable per-practice, or reachable through any surface other than an operator
editing `.env` and restarting the process.

**Why it matters:** a doc or UI string claiming adjustability that does not exist sends an
operator (or a future engineer) looking for a settings screen that was deliberately never
built, wasting a real search for something the codebase already decided not to have.
