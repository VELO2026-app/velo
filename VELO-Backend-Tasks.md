# ZOD BACKEND TASKS — consolidated backend wishlist (user / master / admin)

> **Maintenance rule (added `PROMPT №679`, 2026-08-12):** this document is refreshed whenever the
> teammate's branch merges into our line — that is the exact moment it drifted from reality last
> time (44851822/330a4d70, 2026-08-11: E4/E8/E9/E12/E15/E20/E21/F2/F6 all found DELIVERED against a
> stale OPEN/PARTIAL status here, one epic 48 commits stale). Establish status by reading the code,
> never by trusting this file's own field.

> **Freshness (PROMPT №510, 2026-07-19, verified against `8d4948f` on `test`):** graded
> ACTIVELY MISLEADING overall. This pass corrected: the "Consistency semaphore 1.3" FOLLOW-UP
> (the feature and the "(parked)" screen it refers to are both gone, deleted 2026-07-07), the
> admin-consistency mention in the seed-data note, the `GET /admin/consistency` line in the
> grounding-facts endpoint list, and E12's pointer to `_series_meta_for_practices` (renamed,
> moved). Everything else below — epic STATUS lines, dates, gen: numbers — is UNVERIFIED this
> pass; this is a fast-moving live task list, treat anything not explicitly touched above as
> whatever it said before, not re-confirmed.

> **Priority legend.**
> - **P0** — a screen that is already built does **not function** without this. Highest urgency.
> - **P1** — the endpoint exists or the screen partly works; this **enriches** a partially-working screen.
> - **P2** — nice-to-have; the screen is usable without it.

---

## ⚡ LANE BOUNDARY (operator, 2026-07-15) — read this before assigning anything below

**Zod's lane is: messaging · notifications · support-ticket intake
(rides the messaging module). Everything else in this document is OWNED-BY-NAV.**

> **⚠ AMENDED 2026-07-16 (explicit operator call, supersedes the 07-15 boundary below): E21
> Zoom-attendance-tracking is REMOVED from Zod's lane and is now OWNED-BY-NAV.** We build it
> ourselves, end to end (web research → design → implementation); Zod's only role on E21 is to
> REVIEW. **The 2026-07-17 deadline is CANCELLED** — E21 is sequenced after the probekit skills
> work (T8) and the full test round. See the E21 section below. Do not start E21.

The test is **delivery-through-the-messaging-module**, not "does it involve text" or "does it look
like a small backend one-liner". Support-ticket intake reads like a standalone form in isolation, but
it ships through the messaging module Zod is building, so it stays his — a plausible-looking table and
endpoint is not, on its own, grounds to reassign it. ~~E21 stays his too, by explicit operator call,
even though attendance-tracking is not itself messaging/notifications.~~ **← REVERSED 2026-07-16 by a
later operator call: E21 is OWNED-BY-NAV. See the amendment above.**

**Second rule, same date, orthogonal to the lane above: Zod owns anything blocked on infrastructure
that does not exist yet in this project, regardless of what feature it sits under.** The lane test above
is about *domain* (is it messaging/notifications/support — Zoom left this list 07-16); this test is
about *missing plumbing*
(does building it require standing up something — a provider, a service, a store — that isn't there).
Neither test cares whether the other says otherwise; an item can fail the lane test and still be Zod's
because of this rule. Two items currently qualify:
- **E13 (master-application document upload).** Fails the lane test outright — document upload isn't
  messaging-shaped. Zod's anyway because **S3 is not connected and there is no file storage anywhere in
  this project.** See E13's own STATUS line.
- **E6's insight portion (the generated weekly-summary prose, not the whole epic).** Also fails the
  lane test. Zod's anyway because **there is no AI provider in this project** — `backend/app/modules/ai/`
  is a `Protocol` (`AIServiceProtocol.generate_summary`) + `MockAIService` returning a static
  placeholder, its own header marking the real implementation out-of-MVP-scope pending "an external LLM
  API". Operator, 2026-07-15: *«Всё, что связано с ИИ, будет делать потом Зод, а мы делаем то, что
  можем сделать»* — everything else in E6 (key feedbacks, needs-attention) is plain aggregation over
  data that already exists, so it is OWNED-BY-NAV and does NOT fall under this rule. See E6's own
  STATUS line.

This is written as a **rule**, not a growing exception list — do not add a third bullet under it without
also checking whether it's actually a THIRD instance of the same infrastructure-missing pattern (a
provider/service/store that plain aggregation code cannot substitute for) rather than a new one-off.
When the missing infrastructure lands (S3 connected, an LLM provider wired), the specific item it was
blocking moves back to OWNED-BY-NAV on its own — the rule does not need to be re-litigated, only the
item's STATUS line updated.

Any marker elsewhere in this doc that still says "OPEN — Zod" / "Zod's part" / "Zod add" etc. for
anything OUTSIDE the lane above OR this infrastructure rule is stale and should be corrected on sight,
not treated as current. This block is the single source of truth for the boundary — do not re-derive it
from scattered epic text.

---

## ⏱ STATUS — actualized `PROMPT №679`, 2026-08-12, against live code on `test` (`330a4d70` + our three)

Each epic carries a **STATUS** line inside its own section below. One-glance state, established by
reading the code, not by any epic's own stale field:

- **DELIVERED (do not rebuild):** **E1** named reviews · **E2** income/ledger+transactions ·
  **E4** messaging (`backend/app/modules/chats/`) · **E5** students/CRM · **E7** period stats
  (master + admin) · **E9 (core)** admin practices/revenue/metrics · **E12** checkin_count ·
  **E15** master_onboarding_completed · **E16** apply languages · **E20 (T2 remainder)** taxonomy
  validator DB source-swap + FE catalog fetch · **E21** Zoom attendance tracking (code-complete;
  see its own section — gated only on missing Zoom credentials, not unbuilt).
- **PARTIAL (some delivered, a remainder open):** **E3** (create-recurrence + daily-label/list-
  visibility done; PATCH-edit of an existing series' recurrence open) · **E8** (master-notifications
  contract + unread bell-feed DELIVERED; push-delivery/quiet-hours moved to an external comms
  service and the 9 master toggles are stored but read by nothing — see E8) · **E9** (rich
  masters-detail + admin/participants + list methods DELIVERED; `documents[]`, reports
  category/priority, withdrawal `master_display_name`+2FA, single-user GET still open) ·
  **E10** (GET-list DELIVERED; DELETE deliberately not built, PATCH-deactivate covers it — not an
  open item) · **E11** (`DELETE /masters/me/payout` + per-card `{attended,no_show}` DELIVERED;
  real account deletion+forfeiture, card payout, connection-link delivery, support-ticket intake,
  master-side booking delete, i18n still open — see E11).
- **OPEN (verified absent in code):** **E6** weekly-summary insight (no AI provider) · **E13**
  apply-doc/photo-upload (no S3) · **E17** master web-auth (PARKED) · **E19** two-level
  Направление→Вид taxonomy schema (F2/F6's DISPLAY need was met a different way — see F2/F6, now
  removed — but E19's own schema+workflow ask is still unbuilt).
- **Delivered OUTSIDE the epic set (not E-numbered):** auto-complete-by-duration (lifecycle worker);
  **W-6/W-7** (user dashboard full attended-stats + bookings load-more, commit `028ae7e`); plus
  frontend/test self-fixes (`StudentDetailResponse.name/avatar`, admin-metrics test isolation) — for
  coordination, not Zod work.

---

## ⏱ SELF-BUILT THIS BATCH — 2026-07-06 (T1–T5 + Bug2, HELD ahead-8 on `54bdf0a`; coordination, NOT Zod work — do not rebuild)

We self-built the following this session under the backend-exception (additive / JSONB / config,
no migration). Recorded here so Zod sees the new surfaces and avoids collision. Deploy delta
`ca66e0e..54bdf0a` = 11 commits (our 8 + Zod's Z-7 zoom-factory `0e3f280` / R-1 clear-admin-marker
`da98d56` / regen `39bdc31`). **Zero migration** across all 11.

**Additive endpoints / contract (self-built, live after deploy):**
- `POST /admin/users/{id}/make-master` (T2) — explicit admin grant: create-or-re-verify the
  `MasterProfile` **and** set `role=master` **and** clear the switched-away-admin marker
  (`credentials_without_admin_home`, shared with R-1). `409 already_master` if already master.
- `GET /admin/masters/{id}` → `AdminMasterDetail` (T3) — real methods / experience / bio for review.
- `PATCH /admin/masters/{id}/methods` → `EditMasterMethodsRequest` (T3) — admin edits a master's
  flat method set during review (min 1 / max 20). Distinct from the M3 master-side change-request.
- `UserResponse.master_application: MasterApplicationInfo | None` on `GET /me` (T5) — reject-visibility
  so a role=`user` applicant sees the verdict (reason) on `MasterPendingView`.
- **Generic Redis invite (T5, replaces the account-bound ID-invite):** `POST /admin/masters/invite`
  now takes **no body** (was `{telegram_id}`), stores `master_invite:{sha256(token)}` → `{issued_by,
  issued_at}` in Redis with **no TTL**, returns the composed `?startapp=master_onboarding__<token>`
  link (`503 bot_url_not_configured` if `TELEGRAM_BOT_URL` unset). `POST /masters/invite/claim` burns
  the token atomically (`GETDEL`; first-claim-wins, unknown/consumed → `404 invite_invalid`); any
  authenticated opener may claim. The account-bound `credentials.master_invite` writer/reader path is
  **removed** (schema `InviteMasterRequest` deleted; own-marker hash-compare gone).

**T4 role/capability pivot (behavior change, no contract field):** `verify_master` (application
approval) now sets `status=verified` **ONLY** — it no longer flips `User.role`. The applicant gains
master *capability* and self-switches via the existing `POST /users/me/role` (`derive_allowed_roles`
keys on `status=="verified"`). `get_current_master` still requires `role=master` AND verified, so a
verified-but-not-switched account is correctly gated. `make_master` (T2) is the one path that flips
role (explicit grant).

**generated.ts hand-adds reconciling at deploy regen (zero expected type-drift):** added
`AdminMasterDetail`, `EditMasterMethodsRequest`, `MasterApplicationInfo`; removed `InviteMasterRequest`.
All have backing backend schemas (or, for the removal, none), so a clean OpenAPI regen matches.

**Known FOLLOW-UPS (self / later — NOT asking Zod to action now):**
- **Consistency semaphore 1.3 redefinition — MOOT, feature deleted.** T4 creates a valid `verified`
  profile with `role=user` (approved-but-not-yet-self-switched), which would have diverged semaphore
  `1.3_master_users_eq_verified_profiles`. **This entire FOLLOW-UP is moot as of 2026-07-07 (`9ca5619`,
  "remove data-integrity semaphores feature entirely"): the admin DB-integrity screen this note called
  "(parked)" was deleted whole, not un-parked** — `admin/consistency/` (backend package + tests),
  `AdminConsistencyView.vue`, and `VELO-Data-Consistency-Semaphores.md` are all gone. No transient-window
  divergence is monitored by anything today; there is nothing left to redefine. Kept here as a record of
  a decision that no longer applies, not as live guidance.
- **Free-text custom-method add** in the T3 methods editor (currently pick from the fixed set).
- **Cross-session persistent reject indicator** in the user zone (today the verdict shows via
  `/me master_application` on the pending screen only).
- **Durable `MasterInvite` table** if the Redis-ephemeral invite proves insufficient (a Redis flush
  drops unburned tokens; acceptable for now — admin regenerates).

---

## Environment note — admin/finance seed data

Originally the admin/finance domains had no seed, so admin screens rendered empty even where the
contract existed. **UPDATE 2026-06-24:** a priced + `as_master` seed now populates masters / practices
/ participants / check-ins / reviews on TEST, so master + most admin screens render real values. The
admin **withdrawals** domain may still need dedicated seed coverage (the **consistency** domain named
here no longer exists — deleted whole 2026-07-07, `9ca5619`). This is an **environment / seed-script
gap, not a backend-contract gap** — do not assume an admin endpoint is missing just because a
less-seeded screen looks thin.

---

## Grounding facts (verified in `generated.ts`; ⟳ = updated 2026-06-24)

**Already present in the backend (do NOT rebuild):**
- `GET /admin/stats` ⟳ now `AdminStatsOverviewResponse` (deltas/revenue/rates/period, gen:113),
  `GET /admin/masters` + verify/reject, `GET /admin/reports`, `GET/POST /admin/withdrawals` +
  approve/reject, `GET /admin/users`. ⟳ NEW since: `GET /admin/practices`
  (+/{id}) gen:567/59, `GET /admin/revenue` gen:97, `/admin/metrics/{check-in,feedback,return}`.
  (`GET /admin/consistency` REMOVED 2026-07-07 `9ca5619` — do not rebuild it, no longer a target.)
- Promo module: `POST /admin/promos`, `POST /masters/me/promos` (gen:320), `PaginatedPromosResponse`
  (gen:639), `promo_code` on booking. (GET-own-list + DELETE still absent — E10.)
- `email` exists on the master-application interface but ⟳ still NOT on `UserResponse` (gen:1059) — E11.
- Master balance `available_cents` / `frozen_cents` on `MasterProfileResponse`.
- `GET /practices/{id}/ai-summary` — a per-practice mock summary (NOT the weekly summary — E6).
- `GET /practices/{id}/attendance` → `AttendanceResponse` (gen:181) carries `attended`/`no_show`/
  `total`/`pending` + per-item projection. (The per-card LIST aggregate is still absent — E11.)

**Key contract shapes:**
- ⟳ `NotificationSettings` / `…Update` still carry **exactly four keys** (`push`, `practice_reminders`,
  `master_messages`, `support_messages`, gen:551) — the +9 master keys + `schedule` are still OPEN (E8).
- ⟳ `PracticeType` includes `'series'` AND now a real recurrence model exists: `RecurrenceSpec`
  (gen:876), `CreatePracticeRequest.recurrence` (gen:350), `recurrence_days`/`total_sessions`/
  `completed_sessions` on `PracticeResponse` (gen:765-767). **But `UpdatePracticeRequest` (gen:1032)
  has no `recurrence`** — edit-a-series is still OPEN (E3).
- ⟳ `ReportResponse` (gen:895) still carries `reporter_id` only — no category/priority/reporter_name/
  date filter (E9).
- ⟳ `AdminWithdrawalResponse` (gen:141) still has no master display name + no 2FA (E9).

---

## SELF-FIX LOG — batch №227 (2026-07-01, operator-authorized backend exception)

Minor gaps closed by us (backend projection + manual `generated.ts` + frontend wire), NOT Zod:
- **E18** `zoom_link` on `PracticeSummary` — from_attributes projection (no migration); `generated.ts` + Zoom wired (user dashboard / live / master dashboard).
- **E14** `rejection_reason` on `MasterProfileResponse` — projected from `data.account.rejection_reason` in the router; `MasterPendingView` shows the real reason.
- **E1 (increment)** `user_id` on `MasterReviewItem` + diary `ReviewItem` — projected from the joined `User`; per-practice review cards (`PracticeReviewsView`) navigate to the student profile. *(Attention-filter DONE №280: `getMasterReviews(…, attention)` + AnalyticsView «Требуют внимания» fetches `attention=true`; the backend param was already deployed. AnalyticsView attention card left on its existing message action pending operator UX call.)*
- **E10** GET `list_my_promos` + PATCH deactivate were already delivered by Zod — frontend now wired (`api/promos.ts` + `MasterPromocodesView`, active-list + soft-deactivate); no hard DELETE added.

**REASSIGNED (operator policy, 2026-07-15) — OWNED-BY-NAV, NOT Zod's lane.** These three were
originally deferred as small-but-Zod-hot one-liners; none of the three files is messaging/notifications,
so under the narrowed Zod lane (messaging + notifications only) they are ours:
- **E12** add a grouped-COUNT `checkin_count` to `PracticeResponse`/`PracticeSummary`, batched like `series_meta_for_practices` (practices/enrichment_service.py:59 — renamed from `_series_meta_for_practices`, moved from service.py; verified PROMPT №510). OWNED-BY-NAV: practices/service.py (E3).
- **E15** mirror `onboarding_completed` → `master_onboarding_completed` on `UserResponse` + accept on PATCH-self (users/, credentials JSONB, service.py:45 frozenset). OWNED-BY-NAV: users/.
- **E3a** add `Practice.status != PracticeStatus.DELETED.value` to the occurrence-count filter (practices/service.py:427) — soft-deleted occurrences currently inflate `total_sessions`. OWNED-BY-NAV: E3 engine.

## A) EPICS

Each epic states **(a) why · (b) screens · (c) what breaks · (d) backend state**, plus a
**STATUS (2026-06-24)** line.

### E1 — Non-anonymous feedback (de-anonymise reviews). **P0.**
- **(a) Why.** Three master-facing screens must show *who* left a review and *what they wrote*; the
  insights endpoint is deliberately anonymous — de-anonymisation is a conscious new contract.
- **(b) Screens (3, ONE endpoint).** Master analytics → «Требуют внимания»; per-practice
  `PracticeReviewsView`; master past-practice detail → «Отзывы участников».
- **(c) Breaks.** All three sections rendered empty (numeric counts were real, named reviews missing).
- **(d) Backend.** `GET /practices/{id}/insights` is anonymous; no named-reviews endpoint existed.
- **Request.** NEW `GET /practices/{id}/reviews` → `{ reviewer_name, avatar, rating, comment,
  created_at }` + an attention filter (negative items only) so it serves both the per-practice list and
  the dashboard "needs attention" feed.
- **STATUS (2026-06-24): DELIVERED** — `GET /practices/{id}/reviews` → `PaginatedReviewsResponse`
  (gen:663), `ReviewItem` (gen:922), `getPracticeReviews` practices.ts:170. The **cross-practice**
  needs-attention feed (the former internal "#3") is also DELIVERED: `GET /masters/me/reviews` →
  `PaginatedMasterReviewsResponse` (gen:615) with `MasterReviewItem.practice_title` (gen:521).
  **CORRECTION (2026-07-04, PROMPT №280): the attention param was STALE-OPEN — it already ships.**
  `GET /masters/me/reviews?attention=true` narrows to the negative (confused) bucket server-side
  (`reviews_router.py` `attention: bool = Query`, `reviews_service.list_master_reviews`,
  `Feedback.rating <= ATTENTION_RATING_MAX`) and is LIVE on origin/test. E1-attention = **frontend
  wiring, now DONE**: `getMasterReviews(..., attention)` passes it; `AnalyticsView` «Требуют внимания»
  fetches `attention=true`. **Also OPEN: `MasterReviewItem` (gen:521) / `ReviewItem` (gen:922) carry no `user_id`** —
  the reviewer is name-only, so a review card cannot navigate to that student's profile. Add a reviewer
  `user_id` to the review item so the frontend can link a review → student profile. *(The per-practice
  `attention` filter EXISTS on the backend — test-verified — but the frontend wrapper doesn't pass it;
  that side is frontend-wiring, see section D.)*

### E2 — Income / ledger + transactions. **P0.**
- **(a) Why.** Income earned over a period + a transactions list. Balance ≠ income.
- **(b) Screens.** Master income (period-scoped) + transactions list. **Reused by** admin revenue (E9).
  *(Frontend-coordination: income/transactions are consumed by `AnalyticsView`, not `MasterFinanceView`
  — Finance = payout/withdrawal only.)*
- **(c) Breaks.** Income rendered «—»; transactions list empty.
- **(d) Backend.** Balance fields existed; no income/transaction API.
- **Requests.** NEW `GET /masters/me/income?period=week|month`; NEW `GET /masters/me/transactions`.
- **STATUS (2026-06-24): DELIVERED** — `IncomeResponse` (gen:442, `getIncome` masters.ts:145);
  `MasterTransactionItem` (gen:536) + `PaginatedTransactionsResponse` (gen:679, `getTransactions` :154).
- **⟳ ENRICHED 2026-06-25 (transaction title = practice name — recon item C).** The transactions list
  (AnalyticsView) shows a generic `MasterTransactionItem.title` («Оплата за практику» / «Комиссия»)
  because `MasterTransactionItem` (gen:536 = `title` / `created_at` / `counterparty_name` /
  `amount_cents`) carries **no practice reference** — no `practice_title` / `practice_id` exists on it
  (verified, grep: `practice_title` is absent app-wide). Operator wants the PRACTICE NAME on sale/refund
  rows. Add `practice_title` (and/or `practice_id`) to `MasterTransactionItem` for sale/refund rows so
  the list shows which practice the payment was for; commission / platform-side rows have no practice
  and keep «Комиссия». The frontend will then render `practice_title` when present, falling back to
  `title`. **P1.**

### E3 — Recurrence / series engine. **P1.**
- **(a) Why.** Create/Edit lets a master configure a repeating practice; `series` was a label only.
- **(b) Screens.** Master Create/Edit → «Повторение»; practices list (weekday line + "N of M left");
  WI-B cancel-scope.
- **(c) Breaks.** Recurrence period/weekdays/end/count were captured-only (not sent); cancel had no scope.
- **(d) Backend.** `series` tag persisted; no recurrence model; cancel had no scope.
- **Requests.** EXTEND `POST/PATCH /practices`: `recurrence{period,days_of_week,end,count}` + instance
  generation. EXTEND `POST /practices/{id}/cancel`: `scope`.
- **STATUS (2026-06-24): PARTIAL.** DELIVERED: `RecurrenceSpec` (gen:876),
  `CreatePracticeRequest.recurrence` (gen:350), `CancelPracticeRequest.scope` (gen:253),
  `recurrence_days`/`total_sessions`/`completed_sessions` on `PracticeResponse` (gen:765-767).
  **OPEN:** `UpdatePracticeRequest` (gen:1032) has **no `recurrence`** → `PATCH /practices/{id}` cannot
  edit an existing series' recurrence. Add it + regenerate the affected child instances on edit.
- **⟳ ACTUALISED `PROMPT №679`, 2026-08-12 — items 1/2 of the 2026-06-25 card/list recon are DONE.**
  (1) **Daily series now renders «Ежедневно», not «Регулярная»:** `enrichment_service.py:31-40`
  `_recurrence_days_from_spec()` populates `recurrence_days=[1..7]` for a daily series exactly as
  the zero-FE-change fix option asked. (2) **Series occurrences are now visible in «Предстоящие»:**
  `listing_service.py:56-114` (`list_master_practices`, wired to `GET /masters/me/practices`) filters
  only on `master_id`/`status`, no parent-only restriction — each occurrence is its own row.
  **Still open — item 3, unchanged:** deleting one occurrence still has no scope of its own;
  `delete_practice` (`service.py:1810-1851`) remains draft-only, single-row, no cascade. In practice
  this is narrower than it reads: a PUBLISHED series is removed via `cancel`, which already carries
  `scope` (DELIVERED); only a DRAFT occurrence hits the scopeless delete path, and a draft series has
  no participants to protect. Left open as originally P3/cosmetic, not reclassified.
- **⟳ ACTUALISED `PROMPT №679` — the 2026-06-26 occurrence-count DELETED-filter fix is DONE.**
  `service.py:838` now includes `Practice.status != PracticeStatus.DELETED.value` in the occurrence-
  count filter, alongside the existing `!= CANCELLED`. The soft-deleted-draft skew this item tracked
  (a soft-deleted draft occurrence inflating the series total) is closed.

### E4 — Messaging module. **P1. STATUS: DELIVERED (`PROMPT №679`, 2026-08-12) — do not rebuild.** `backend/app/modules/chats/` (threads/messages/read/unread-count) + full frontend chat UI.

**Still genuinely open — a narrower, DIFFERENT item than the chat module above:** the "запрос
мастеру" (ask-the-master) flow from a booking-confirmed screen is still not persisted as its own
entity and does not surface on the master's student-profile screen. `BookingConfirmedView.onSendRequest`
still only fires a toast (verify against current frontend before treating as current); backend
`StudentCheckinItem` (`backend/app/modules/masters/students_schemas.py:47`) still carries no
`request_text`/`practice_id`, and no `recent_requests[]` exists on `StudentDetailResponse`. Whether
this belongs to Zod or is superseded by simply sending a chat message via the new module is an
open product question, not resolved by this pass — flag as AUTO-ASK if picked up.

### E5 — Students / CRM aggregate. **P0.**
- **(a) Why.** "A master's students" — people who book/attend, aggregated per person.
- **(b) Screens.** Master dashboard → «Мои ученики»; `MasterStudentsView`; `MasterStudentProfileView`.
- **(c) Breaks.** Stubs; tap = «недоступно»; client-side search over a stub list.
- **(d) Backend.** No students aggregate.
- **Requests.** NEW `GET /masters/me/students`; NEW `GET /masters/me/students/{id}`.
- **STATUS (2026-06-24): DELIVERED** — `PaginatedStudentsResponse` (gen:671),
  `StudentListItem`(+needs_attention) (gen:984), `StudentDetailResponse` (gen:966); `getStudents`/
  `getStudent` masters.ts:120/130.

### E6 — Weekly summary (master + user). **P2.**
- **(a) Why.** A weekly personalised summary (insight + key feedbacks + who needs attention). The
  existing AI summary is per-practice and mock.
- **(b) Screens.** Master dashboard → «Саммари» + `MasterSummaryView`; user → «Подробнее» + `AiSummaryView`.
- **(c) Breaks.** Nothing, as of PROMPT №420 — see STATUS.
- **(d) Backend.** `GET /practices/{id}/ai-summary` is mock + per-practice (unrelated to this epic; a
  different feature entirely, kept for its own sake, not a stand-in for the weekly summary).
- **STATUS (2026-07-15, PROMPT №420): DELIVERED except the insight, which is Zod's (see LANE below).**
  Recon before building found two of the three pieces already real and just not wired to this one
  screen — no new backend was needed for either:
  - **needs attention: DELIVERED, pre-existing (E5).** `MasterSummaryView` already filters the real
    `GET /masters/me/students` feed (`StudentListItem.needs_attention`) and navigates on the real
    student `id` — this was already E6-complete before this batch touched anything.
  - **key feedbacks: DELIVERED, wired this batch.** `GET /masters/me/reviews` (E1's cross-practice named
    feed, `MasterReviewItem`) already carries a real reviewer `user_id` — the doc's prior note below
    calling this blocked on a missing `student_id` was **stale**; the field shipped as an "E1 remainder"
    without this doc being updated. `MasterSummaryView`'s "Ключевые отзывы" now calls the same endpoint
    AnalyticsView's «Требуют внимания» uses, without the `attention=true` filter (a highlight reel, not
    only the negative bucket), fully navigable. No new endpoint, no new backend field — pure frontend
    wiring onto an endpoint that already existed.
  - **insight: genuinely open, and it is Zod's** — not because of the lane above (it isn't messaging),
    but because there is no AI provider in this project to generate it. See the infrastructure rule in
    the LANE BOUNDARY block at the top of this doc. Stays an honest static placeholder
    (`MasterSummaryView`/`AiSummaryView`) until that provider exists.
  - *Prior note, now corrected: this doc used to describe a dedicated `GET /masters/me/weekly-summary` /
    `GET /users/me/weekly-summary` pair as the request. Neither was built or is needed — the two real
    pieces are served directly from their own existing endpoints (`/masters/me/students`,
    `/masters/me/reviews`) on the summary screen, the same pattern `MasterSummaryView` already used for
    needs-attention before this batch. A combining endpoint would be indirection with no consumer
    benefit. If a future need justifies one (e.g. a single round-trip matters on a slow connection),
    reopen this as its own decision — do not resurrect the old request lines below as-is.*
- **STATUS (2026-06-24, historical — see 2026-07-15 above for current):** only the per-practice
  `AISummaryResponse` (gen:33) existed; no weekly-summary endpoint.
- **LANE (2026-07-15):** SPLIT — needs attention + key feedbacks are OWNED-BY-NAV (delivered, see
  above); the insight is Zod's under the infrastructure rule (missing AI provider), not the domain lane.

### E7 — Period-scoped stats + deltas. **P1.**
- **(a) Why.** Master + admin dashboards show stat cards with a Неделя/Месяц toggle + a delta vs the
  previous period.
- **(b) Screens.** Master dashboard (cards + toggle), master analytics, admin dashboard.
- **(c) Breaks.** Master: only practices total real; participants/income/deltas stubbed. Admin: deltas/
  revenue/rates «—».
- **(d) Backend.** `AdminStatsResponse` was 4 bare counters; no master stats endpoint.
- **Requests.** EXTEND `GET /admin/stats` (deltas/revenue/rates/period); NEW `GET /masters/me/stats?period`.
- **STATUS (2026-06-24): DELIVERED** — master `MasterStatsResponse`(+deltas) (gen:526,
  `getMasterStats(period)` masters.ts:171); admin `AdminStatsOverviewResponse`(deltas/revenue/rates/
  period) (gen:113) + `/admin/metrics/{check-in,feedback,return}` + `AdminRevenueResponse` (gen:97).

### E8 — Notifications: contract + delivery. **P1 (contract) / P2 (delivery).**
- **(a) Why.** The master notifications screen exposes 9 types + a delivery schedule, but the contract
  carries only the four user keys. Push delivery itself is also unwired.
- **(b) Screens.** `MasterNotificationsView` (local-only); user `NotificationsView`; the dashboard bells.
- **(c) Breaks.** The master screen holds all state locally + does not persist; the bell has no feed.
- **(d) Backend.** `NotificationSettings`/`…Update` = exactly four keys (gen:551). No unread-feed.
- **Requests.** EXTEND with `new_booking, booking_cancelled, reminder, new_checkin, new_feedback,
  msg_participants, msg_support, ai_summary, monthly_report` + a `schedule{from,to,days}`; NEW push
  delivery + quiet-hours scheduler; NEW unread-feed for the bell.
- **STATUS (actualised `PROMPT №679`, 2026-08-12): PARTIAL, but the shape of what's open CHANGED —
  read this before assigning anything against the old wording.** **DELIVERED, still true:** the full
  master-notifications contract — `MasterNotificationSettings` (9 toggles) + `NotificationSchedule`
  (`from_`/to/days), persisted under credentials, gated by master capability.
  **DELIVERED, NEW since the last pass:** the unread bell-feed this epic asked for now exists —
  `backend/app/modules/comms_proxy/router.py:84,99,110,121` — `GET /notifications` (keyset inbox),
  `GET /notifications/unread-count`, `POST /notifications/read-all`, `POST /notifications/{id}/read`.
  **ARCHITECTURE CHANGED, not just delivered:** push delivery itself did not land as an in-process
  worker+scheduler the way this epic asked — the whole notifications pipeline was cut over
  (`backend/app/core/events/`) to a transactional outbox that ships events via a Redis Stream to an
  EXTERNAL comms microservice (`core/events/relay.py:79-176`); delivery and quiet-hours logic now
  live there, outside this repo. `comms_proxy/router.py:141-228` does carry a real quiet-hours
  contract (`schedule{from,to,days}`), forwarded to that external service.
  **⚠ DEAD WORK, worth flagging rather than silently carrying:** the 9 master toggles
  (`new_booking`, `booking_cancelled`, etc.) are stored and returned by `GET/PATCH /users/me`
  (`backend/app/modules/users/service.py`, `router.py`) but read by **nothing** — no emit site or
  relay code in this repo ever checks them; the actually-live category gating is a separate
  mechanism inside the external comms service. Whether these toggles should be wired to gate
  emit-time (our side) or are meant to be superseded by the comms-service's own preference store is
  an open product/architecture question, not resolved by this pass.

### E9 — Admin oversight endpoints. **P0 (data) / P1 (rich).**
- **(a) Why.** The admin role is built to the design; most admin lists/details have no endpoint or a
  minimal one lacking the rich fields.
- **(b) Screens.** All admin screens.
- **(c) Breaks.** Lists honest-empty; rich fields «—»; withdrawal hero shows holder/«—»; 2FA is UI-only.
- **(d) Backend.** Mix of EXTEND + NEW (per item).
- **Requests.** EXTEND `/admin/masters/list`+`/{id}` (rich + application profile + docs[] + history +
  edit-fields + doc view/download; verify/reject already real); EXTEND `/admin/reports` (category/
  priority/date/reporter_name); EXTEND `/admin/users` (participants rich + filters); EXTEND
  `AdminWithdrawalResponse` (+master_display_name) + NEW real 2FA; NEW `/admin/metrics/*`; NEW
  `/admin/revenue`; NEW `/admin/practices`(+/{id}).
- **STATUS (actualised `PROMPT №679`, 2026-08-12): PARTIAL, several sub-items moved since the last
  pass.** DELIVERED, unchanged: `/admin/practices`(+/{id}), `/admin/revenue`, `/admin/metrics/*`,
  verify/reject.
  **DELIVERED, NEW:** masters `/{id}` rich application profile + edit-master-fields —
  `backend/app/modules/admin/users/schemas.py:53-75` `AdminMasterDetail` now carries
  methods/experience_years/bio/display_name/email/phone/languages/certifications, and
  `PATCH /admin/masters/{user_id}/profile` exists (`admin/masters/router.py:184-209`). Participants
  rich fields + filters — but at a DIFFERENT endpoint than originally asked: not an extended
  `GET /admin/users`, a new sibling `GET /admin/participants` (`admin/participants/router.py:31-49`,
  `filter=all|new|active`, `period=week|month`, `AdminParticipant{practices_count,
  last_login_at,…}`); `GET /admin/users` itself is unchanged.
  **STILL OPEN, unchanged:** reports category/priority/reporter_name (`ReportResponse` still
  reporter_id + status/target_type filters only); `AdminWithdrawalResponse.master_display_name` +
  real 2FA (repo-wide search for 2fa/totp found zero hits); `GET /admin/users/{id}` single-user
  detail (still no such route — see the item below).
  **STILL OPEN, narrower than before:** `documents[]` on the master detail — the rich profile above
  shipped without it; the only `"documents": []` in the codebase is an unrelated internal JSONB stub
  (`admin/users/service.py:337`), not exposed via any schema.
- **Q1 (batch Q, 2026-07-12) — admin masters LIST card rich fields.** `AdminMasterListItem` (gen:67)
  carries only id / name / avatar / role / `master_status` → the `AdminMastersView` cards render EVERY
  rich field as an honest «—» stub (**methods** · Практик/Учеников · К выводу [payout] · Опыт · Заявка
  [applied-at]). EXTEND the LIST response with these so the card fills in (the FE structure already
  consumes them). Priority field: add **`methods: list[str]`** (already stored in `data.profile.methods`)
  so the list card can show **направление + вид** via the batch-L `methodTaxonomy` parse — the SAME
  two-level readonly render now shipped on the master DETAIL (Q2, `AdminMasterReviewView`). Target = the
  operator's rich-card screenshot. ⚠ Adding fields to the list response → grep frozen key-sets in
  `backend/tests` first + regen `generated.ts`.
- **CLOSED-BY-NAV (batch R, 2026-07-14, LIVE c1dbe08) — E9-rich.** `AdminMasterListItem` rich card
  (methods + Практик/Ученики/К-выводу stats) delivered additively, self-built. Do not rebuild.
- **NEW `GET /admin/users/{id}` — admin single-user detail (PROMPT №372, 2026-07-12).** Today
  `/admin/users` (list) and `/admin/users/{id}/make-master` (action) exist, but there is no
  single-user GET. This blocks `AdminReportDetailView`'s clickable-target fix (master/practice
  targets already link out; `target_type=user` stays plain text — no user-detail screen to
  navigate to). **P2.**

### E10 — Promo module (verify-only). **P2.**
- **(a) Why.** Mostly already built; flagged so the small gap (a master's own list + delete) is closed.
- **(b) Screens.** `MasterPromocodesView` / `MasterNewPromocodeView`.
- **(c) Breaks.** Sample data + stubbed taps (frontend wrappers unwritten).
- **(d) Backend.** POST promos + `PaginatedPromosResponse` + `promo_code` on booking exist.
- **Request.** ADD `GET /masters/me/promos` (list) + `DELETE /masters/me/promos/{id}`.
- **STATUS (2026-07-01): DELIVERED + FRONTEND-WIRED (batch №227).** `POST` + **`GET /masters/me/promos`**
  (list_my_promos, router.py:72) + **`PATCH /masters/me/promos/{id}/deactivate`** (router.py:88) all exist;
  frontend wired (`api/promos.ts`, `MasterPromocodesView` active-list + soft-deactivate). A hard `DELETE`
  was NOT added (PATCH-deactivate covers it) — reopen only if a real hard-delete need surfaces.
- **CLOSED-BY-NAV (batch R, 2026-07-14, LIVE c1dbe08) — E10-promo.** Master-promo create crash fixed.
  Delete remains a soft-deactivate by design; no hard-delete endpoint is needed.

### E11 — One-offs.
- NEW master-side `DELETE` of a participant's booking (refund + notify) — `cancelBooking` is self-only. **P1.**
  **STILL OPEN, confirmed `PROMPT №679`:** `bookings/router.py`'s `DELETE /{booking_id}` is
  explicitly owner-only (self-cancel). Master-side cancellation only exists whole-practice
  (`practices/router.py:658`, refunds ALL participants) or as a side-effect of blocking a student —
  no targeted single-booking master delete.
- NEW support-ticket intake `{ topic, message, attachments[] }` + upload (max 5 / 5 MB, server-side). **P1.**
  **STILL OPEN, confirmed `PROMPT №679`:** no `SupportTicket` model/router exists anywhere under
  `backend/app/modules/`. The new `chats` module (see E4) is a generic DM-thread pointer with no
  `topic`/`priority`/`status` — a different thing, not this ticket system.
- **ACTUALISED `PROMPT №679` — connection-link is now PARTIAL, was fully OPEN.** The ~10-minute
  pre-start TIMING scaffold exists: `backend/app/core/events/reminders.py:85-90,127-155` schedules a
  `booking.reminder_10m` notification at `scheduled_at - 10min`. But its `action_data` carries only
  `practice_id`/text — no Zoom join/connection link is generated or attached. So the delivery
  *trigger* is built; the *link itself* is still not. **P2.**
- ~~NEW `DELETE /masters/me/payout` — only `PATCH` exists.~~ **DONE, `PROMPT №679`.**
  `backend/app/modules/masters/router.py:289-320` `delete_payout_details` — clears `data["payout"]`,
  204 response.
- NEW **card payout method** (card storage + one-time payout) — `savePayout` stubs `method==='card'` → toast «Выплата по номеру карты появится позже»; bank_transfer / PayPal / Revolut **already persist** via `PATCH /masters/me/payout`. So "doesn't save the card" = the card method only. ⟳ recon item #3 (2026-06-25). **P2.**
  **STILL OPEN, confirmed `PROMPT №679`:** `masters/schemas.py:130-141` `PayoutDetailsUpdate.method`
  remains freeform `str`, docstring only documents bank_transfer/paypal/revolut. No card storage.
- **ACTUALISED `PROMPT №679` — the earlier STATUS line below claiming this DELIVERED was WRONG; the
  claim never matched the code it cited.** EXTEND real account deletion + balance forfeiture. **P2.**
  `backend/app/modules/users/router.py:139-155` `DELETE /me`'s own docstring: *"this does **NOT**
  erase data or deactivate the account. It resets the onboarding flag... old data intact."* It calls
  `reset_user_to_onboarding`, which touches no balance/forfeiture field at all (grepped, zero hits).
  Whatever the frontend wiring at the old `users.ts:50` citation does, it is not calling anything
  that forfeits a balance or erases data — this item is genuinely still open, not delivered.
- EXTEND `UserResponse.email` (capture + expose). **P1.** *(Already correctly marked DONE below — unchanged by this pass.)*
- **Master-application → profile data exposure (⟳ recon 2026-06-25, EditProfile).** (a) **`methods`** — onboarding
  captures the master's `methods` and the profile response carries a `methods?` field; the frontend renders
  locked method-chips gated on `profile.methods.length > 0` → VERIFY the backend COPIES the application's
  `methods` onto the profile, else the chips never render (recon item E2). (b) **application PHOTO** — there is
  **NO** `photo` / `photo_url` field anywhere in the contract (verified, grep); the profile avatar falls back to
  the Telegram `avatar_url`. To show an onboarding-captured photo, the application must capture + store a photo and
  expose it on the profile — contract undefined → define + spec (frontend defers, does not invent). **P2** (recon item E3).
  **Not re-verified this pass** — outside the scope of what the merge plausibly touched; carry as-is.
- NEW i18n EN catalog + language render layer + date-format pref + formatter. **P2.**
  **STILL OPEN, confirmed `PROMPT №679`:** `backend/app/core/i18n.py` is only a language-code
  whitelist (`SUPPORTED_LANGUAGES`/`normalize_language`), not a translation catalog. No locale/.po
  files anywhere. The new comms microservice owns template rendering for its own channel, per its
  own module docstring — a separate concern from a user-facing EN catalog.
- ~~EXTEND `PracticeResponse` per-card `{ attended, no_show }` aggregate.~~ **DONE, `PROMPT №679`.**
  `backend/app/modules/practices/schemas.py:732-733` — `attended: int | None`, `no_show: int | None`,
  owner-only aggregate, filled by the service. **P2.**
- **STATUS (2026-07-04, email SELF-BUILT — PACK#3, PROMPT №280):** `UserResponse.email` capture+expose
  is DONE, additive credentials-JSONB (phone/bio pattern, NO column, NO migration): `"email"` added to
  `_JSONB_CREDENTIAL_FIELDS`, `UserResponse.email` computed_field, `UserUpdate.email` (soft
  email-validator; "" clears). `EditProfileView` email field enabled. Regenerated generated.ts.
  **ZOD HEADS-UP (Q1=А collision note):** Velo orc self-built this in `users/` (Zod's nominal E8 lane).
  It is **additive only** (one credentials key + one response field + one PATCH field) — no schema/
  column/migration, no conflict with E8's `master_notifications`. users/ was re-checked remote-cold at
  build (origin/main 0-ahead vs test, no in-flight users/ push). Reconcile-before-push still mandatory
  at deploy.
- **STATUS (actualised `PROMPT №679`, 2026-08-12): PARTIAL.** DELIVERED: `UserResponse.email`;
  `DELETE /masters/me/payout`; per-card `{attended,no_show}` aggregate.
  **OPEN, corrected:** real account deletion + forfeiture (the "DELIVERED (forfeit)" claim this line
  used to carry was never true against the code — see the item above); master-delete-participant
  booking; support-ticket intake + upload; card payout method; i18n EN (partly frontend).
  **PARTIAL:** connection-link (timing exists, link generation doesn't — see the item above).

### E12 — Check-in count aggregate. **P1. STATUS: DELIVERED (`PROMPT №679`, 2026-08-12) — do not rebuild.** `practices/schemas.py:731` + `enrichment_service.py:136-226`.

### E13 — Master-application document upload (NEW post-audit). **P2.**
- **(a) Why.** The master-application flow shows document tiles, but there is no upload.
- **(b) Screens.** `MasterApplyView` (intake) + admin master-review (view/download — ties to E9 docs[]).
- **(c) Breaks.** `MasterApplyView` renders static placeholder tiles and always sends `documents: []`;
  no file input, no upload endpoint.
- **(d) Backend.** `MasterApplyRequest.documents` (gen:475) is a freeform JSON array in the apply body
  — no file-upload intake / storage. Ties to support-upload (E11) / E4 attachments.
- **Request.** NEW document upload intake + storage; surface on the admin master-review (E9 docs[]).
- **EXTEND (slice-2 2026-06-27):** the redesigned Step-3 also adds a **profile photo** (public) upload
  — no `photo_url` on `MasterProfileResponse` (gen:486). Build the UI (drop-zone + uploaded-chip),
  tap = honest «недоступно» until storage ships. Add `photo_url` intake on apply + surface on profile.
- **STATUS (2026-06-24): OPEN — Zod (exception to the 2026-07-15 lane rule — see below). P2.**
- **REASSIGNED (operator exception, 2026-07-15):** back to Zod, but NOT because document upload is his
  kind of feature — it is not messaging/notifications, and under the lane rule above would otherwise
  stay OWNED-BY-NAV. It is Zod's because its blocker is infrastructure he owns and has not yet built:
  **S3 is not connected, and there is no file storage anywhere in this project.** Revisit if storage
  ever lands independently of Zod's build.

### E14 — Master-application rejection reason, surfaced (NEW post-audit). **P2.**
- **(a) Why.** A rejected applicant should see *why* (`MasterPendingView` shows a hardcoded «Причина: …»).
- **(b) Screens.** `MasterPendingView`.
- **(c) Breaks.** No `rejection_reason` on any DTO the applicant can read.
- **(d) Backend.** `RejectMasterRequest.reason` (gen:885) is admin **input** only; it is **not exposed**
  on `MasterProfileResponse` (gen:486) / `MasterApplyResponse`.
- **Request.** Surface `rejection_reason` on the applicant-readable profile/apply response.
- **EXTEND (slice-2 2026-06-27):** the redesigned «Отказ» screen renders the specific reason + keeps a
  «Подать новую заявку» path (operator fork-4=Б). Confirm a rejected applicant's role/status keeps the
  rejected screen REACHABLE and the re-apply path allowed after rejection.
- **STATUS (2026-07-01): SELF-FIXED (batch №227) — see SELF-FIX LOG.** `rejection_reason` projected onto
  `MasterProfileResponse` from `data.account.rejection_reason`; `MasterPendingView` renders the real reason.
- **CLOSED-BY-NAV (batch R, 2026-07-14 + follow-up 2026-07-15, LIVE) — E14-reject.**
  `rejection_reason` had ALREADY shipped (see above; re-verified 2026-07-15 at
  `backend/app/modules/users/router.py:63-73` → `MasterPendingView.vue:131,145` -- genuinely reaches
  the frontend, not a doc-trust claim). R2 (batch R, `cb6d8bf`, 2026-07-14) fixed a real
  `masterPendingGuard` gap — but that was NOT the whole bug, as the operator's own device testing
  found on 2026-07-15: R2 only ALLOWED a rejected applicant onto `/master/pending` if they reached it;
  nothing actually ROUTED them there. A returning rejected applicant (different session, 24-48h later)
  landed on `/user/dashboard` and never saw the screen the guard now permitted. Closed 2026-07-15:
  `roleRedirect` now routes a rejected, not-yet-seen applicant to `/master/pending` once (operator
  decision: show the verdict, then treat them as an ordinary user). Nothing owed to Zod — both gaps
  were frontend-only.

### E15 — Master-onboarding "completed" flag. **P2. STATUS: DELIVERED (`PROMPT №679`, 2026-08-12) — do not rebuild.** `users/schemas.py:406,585` + `service.py:56`.

### E16 — Master-application "languages" field (NEW slice-2 2026-06-27). **P2.**
- **(a) Why.** The redesigned Step-2 «Опыт» adds a «Язык проведения практик» control (Русский /
  English). Operator fork-3=А: build the full UI now, persist later.
- **(b) Screens.** `MasterApplyView` step 2; later the public/admin master profile.
- **(c) Breaks.** `MasterApplyExperience` / `MasterApplyRequest` (gen:472) has no `languages` field;
  `MasterProfileResponse` (gen:486) has no `languages`. The control persists nothing until added.
- **Request.** Add `languages: string[]` to the apply experience intake + surface on the profile.
- **STATUS (2026-07-04): SELF-BUILT (PACK#3, PROMPT №280).** Additive JSONB `data.profile.languages`
  (mirror `methods`, NO migration): `MasterApplyExperience.languages` (default []) + on
  `MasterProfileResponse`; apply UI wired (`langRu`/`langEn` → experience.languages). Q2=А: FREELY
  editable on the profile (no moderation) via new `PATCH /api/v1/masters/me/languages` +
  `EditProfileView` languages chips. Regenerated generated.ts. HELD (accumulate-then-deploy).

### E17 — Master web auth (Phase A) (NEW slice-3 2026-06-27). **P3 (future web build).**
- **(a) Why.** The Figma Phase A is a standalone WEB master portal: Landing / Login (email+password) /
  Recover-password (request + set-new). The Telegram Mini App authenticates via `initData` and has NO
  password concept, so Phase A has no place in the Telegram flow. Built now as PARKED, INERT screens
  (unlinked `/auth/*` routes, no fake auth) so they exist in the project and wait for the web build.
- **(b) Screens.** new `views/auth/{Landing,Login,RecoverPasswordRequest,RecoverPasswordSet}View.vue`.
- **(c) Breaks.** No email/password auth surface exists: no register/login-by-password endpoint, no
  password hashing/sessions, no password-reset email flow. The current only auth is `/auth/telegram`
  (initData). The parked screens render fields but submit is a no-op / «недоступно».
- **Request.** When the standalone web build is real: email/password registration + login + session +
  password-reset email. Wire the parked `/auth/*` screens to it. Entirely a future web-build concern.
- **STATUS (2026-06-27): OPEN — PARKED.** (Frontend inert screens built; not wired; no Telegram impact.)
- **LANE (2026-07-15):** OWNED-BY-NAV when unparked — not messaging/notifications. Stays parked/P3;
  no urgency, recorded only so it isn't mis-assigned to Zod if it ever moves.

### E18 — Zoom link on `PracticeSummary` (NEW 2026-07-01). **P2.**
- **(a) Why.** The user «Ближайшая практика» (dashboard) + «Мои бронирования» booking cards have a Zoom
  button. The booking object (`BookingWithPracticeResponse.practice`) embeds a `PracticeSummary`, which
  has NO `zoom_link` — so the button cannot open the meeting without a second round-trip.
- **(b) Screens.** `UserDashboardView` (Zoom button); `MyBookingsView` / booking cards.
- **(c) Breaks.** `UserDashboardView.onZoomClick` is an honest stub (toast «Ссылка появится ближе к
  началу») — we deliberately do NOT fire a per-click `GET /practices/{id}` just to read the link. (The
  in-session `PracticeLiveView` already opens the real link — it fetches the full `PracticeResponse`.)
- **(d) Backend.** `zoom_link` exists on `PracticeResponse` (gen:799) but is **absent** on
  `PracticeSummary` (gen:775 — the same object that lacks `checkin_count`, E12).
- **Request.** ADD `zoom_link` to `PracticeSummary` so booking cards can open Zoom without a separate GET;
  then wire `platform.openLink(...)` on the user dashboard (master screens already open it via the full
  `PracticeResponse`).
- **STATUS (2026-07-01): SELF-FIXED (batch №227) — see SELF-FIX LOG.** `zoom_link` added to `PracticeSummary` (from_attributes, no migration) + `generated.ts` + Zoom wired. No Zod action.

### E19 — Master methods change-request workflow (NEW 2026-07-01, operator PE-3). **P2.**
- **(a) Why.** On the master «Редактировать профиль» screen the operator wants the onboarding methods shown,
  LOCKED, and changeable only via an admin-approved request. The operator's mockup (PE-3, image 2 — the
  design spec) shows a **two-level taxonomy** «Направление» (direction, e.g. Йога) → «Вид» (kind, e.g.
  Хатха) per method, each editable via a pencil → inline edit → auto-submitted change request → a
  **«Ожидает подтверждения»** (pending) badge until an admin approves, with the note «Изменение направления
  или вида практики требует подтверждения администратора. Запрос отправляется автоматически. Обработка
  запроса обычно занимает не более 3 рабочих дней.»
- **(b) Screens.** `EditProfileView` (master variant) methods block; an admin approve/reject surface.
- **(c) Breaks.** The current data is a **flat `string[]`** — `MasterProfileResponse.methods` (fed from the
  apply `AVAILABLE_METHODS`, e.g. "Йога","Медитация"). There is NO Направление→Вид (direction→kind) pairing,
  NO method-change-request entity, NO pending/approval status. None of the mockup's structure or workflow
  exists. **Frontend today ships the honest locked flat-chip display** (`EditProfileView` §methods:
  read-only `VChip`s + «Изменить методы можно через поддержку»); it does NOT fake the taxonomy or the
  pending state (no-fake rule).
- **(d) Backend.** Needs: (1) a two-level methods model — each method = { direction, kind } instead of a
  flat string; surface it on `MasterProfileResponse`. (2) A method-change-request endpoint (master submits a
  proposed direction/kind edit). (3) An admin approval/rejection workflow. (4) A per-method **pending**
  status the profile response exposes so the frontend can render «Ожидает подтверждения» until resolved.
- **Request.** Design + build the taxonomy model + change-request + admin-approval + pending status; image 2
  (PE-3) is the visual spec. Then the frontend upgrades the locked flat-chip display into the mockup's
  editable-with-approval rows. Until then the honest locked display stands.
- **STATUS (2026-07-04): SELF-BUILT FLAT (M3, PROMPT №278) — two-level taxonomy DEFERRED / out of scope.**
  Operator locked F-M3-1=А (FLAT `string[]`, no direction→kind nesting) after recon surfaced that this E19
  entry contradicted the flat decision. Shipped additively (no migration): JSONB
  `data.profile.method_change_request` + 4 endpoints mirroring the master-application verify/reject loop
  — `POST /masters/me/method-change-request` (master submit), `GET /admin/masters/method-change-requests`
  (admin list-pending), `POST /admin/masters/{id}/method-change-request/approve|reject`. Exposed on
  `MasterProfileResponse.method_change_request` (optional). Frontend: `EditProfileView` master methods block
  upgraded from locked-chips to an editable flat set + «Ожидает подтверждения» pending badge + auto-submit
  note; new admin `AdminMethodRequestsView` moderation screen. The **two-level Направление→Вид taxonomy**
  from the operator's PE-3 mockup (per-method pencil-edit, per-method pending) remains **OPEN / deferred** —
  revisit if the operator re-prioritises the nested design.

---

## B) PER-ENDPOINT TABLE (with STATUS)

| Endpoint (method + path) | NEW/EXTEND | Fields | Prio | Status (2026-06-24) |
|---|---|---|---|---|
| GET /practices/{id}/reviews | NEW | reviewer_name, avatar, rating, comment, date; attention | P0 | DELIVERED (gen:663) |
| GET /masters/me/reviews (cross-practice feed) | NEW | + practice_title; attention filter | P1 | DELIVERED — feed + attention param (gen:615); FE wired №280 (AnalyticsView attention=true) |
| GET /masters/me/income?period | NEW | income_cents, delta | P0 | DELIVERED (gen:442) |
| GET /masters/me/transactions | NEW | title, date, counterparty, amount (signed) | P0 | DELIVERED (gen:536/679) |
| GET /masters/me/students (+/{id}) | NEW | name, avatar, counts, checkins[], feedbacks[] | P0 | DELIVERED (gen:671/966) |
| GET /masters/me/stats?period | NEW | practices, participants, income + deltas | P1 | DELIVERED (gen:526) |
| ~~GET /masters/me/weekly-summary~~ | — | superseded 2026-07-15 (PROMPT №420) — not built, not needed; `MasterSummaryView` calls the two existing endpoints below directly | — | see E6 STATUS |
| ~~GET /users/me/weekly-summary~~ | — | superseded 2026-07-15 — insight is the only piece, stays a static placeholder (no AI provider); see E6 STATUS | — | see E6 STATUS |
| POST /practices (recurrence) | EXTEND | recurrence{…} + generation | P1 | DELIVERED (gen:350/876) |
| PATCH /practices/{id} (recurrence) | EXTEND | add recurrence to UpdatePracticeRequest + regen | P1 | OPEN (gen:1032 lacks it) |
| POST /practices/{id}/cancel (scope) | EXTEND | scope: this \| this_and_future | P1 | DELIVERED (gen:253) |
| GET /conversations (+messages, POST, unread) | NEW | peer, preview, time, unread, messages[] | P1 | **DELIVERED, `PROMPT №679`** — shipped as `chats/router.py` (thread not "conversation"), see E4 |
| NotificationSettings (+Update) | EXTEND | +9 keys + schedule{from,to,days} | P1 | DELIVERED — 9 toggles + schedule contract shipped; see E8 for what's still open |
| push delivery + quiet-hours | NEW | scheduler honours window / days | P2 | **ARCHITECTURE CHANGED, `PROMPT №679`** — moved to an external comms microservice; the 9 toggles above are stored but unread by anything in this repo; see E8 |
| notifications unread-feed | NEW | bell feed + badge | P1 | **DELIVERED, `PROMPT №679`** — `comms_proxy/router.py` `GET /notifications`+`/unread-count`, see E8 |
| GET /admin/stats | EXTEND | deltas, revenue, rates, pending, period | P1 | DELIVERED (gen:113) |
| GET /admin/masters/list + /{id} | EXTEND | rich + application profile + docs[] + history[] | P1 | **PARTIAL, `PROMPT №679`** — rich detail + edit DELIVERED (`AdminMasterDetail`); `documents[]` still absent; see E9 |
| admin edit-master-fields | NEW | save Направление / Вид | P2 | **DELIVERED, `PROMPT №679`** — `PATCH /admin/masters/{id}/profile`, see E9 |
| GET /admin/reports | EXTEND | category, priority, date, reporter_name | P1 | OPEN (confirmed `PROMPT №679`, still reporter_id only) |
| GET /admin/users (participants) | EXTEND | practices_attended, last_active, joined, filters | P1 | **DELIVERED, `PROMPT №679`, at a DIFFERENT endpoint** — `GET /admin/participants`, not an extended `/admin/users`; see E9 |
| GET /admin/users/{id} | NEW | single-user detail; unblocks report user-target link | P2 | OPEN (confirmed `PROMPT №679`, still no such route) |
| AdminWithdrawalResponse + 2FA | EXTEND + NEW | master_display_name; real 2FA step | P2 | OPEN (confirmed `PROMPT №679`) |
| GET /admin/metrics/check-in\|feedback\|return | NEW | rate, totals, series, low/distribution/top | P0 | DELIVERED |
| GET /admin/revenue | NEW | revenue, commission, payable, per-master (= E2) | P0 | DELIVERED (gen:97) |
| GET /admin/practices (+/{id}) | NEW | global list + detail + roster | P0 | DELIVERED (gen:567/59) |
| GET /masters/me/promos + DELETE | NEW | list; delete | P2 | GET DELIVERED; DELETE deliberately not built (PATCH-deactivate covers it, per E10 — not an open item) |
| DELETE participant's booking (master) | NEW | refund + notify | P1 | OPEN (confirmed `PROMPT №679`) |
| POST support ticket + upload | NEW | topic, message, attachments[] | P1 | OPEN (confirmed `PROMPT №679` — no SupportTicket model anywhere; the new chats module is a different thing) |
| connection-link auto-gen | NEW | link generation + delivery | P2 | **PARTIAL, `PROMPT №679`** — the 10-min-pre-start TIMING scaffold exists (`core/events/reminders.py`); the link itself still isn't generated; see E11 |
| DELETE /masters/me/payout | NEW | remove payout method | P2 | **DELIVERED, `PROMPT №679`** — `masters/router.py:289-320` |
| DELETE /users/me (real) | EXTEND | forfeit balance + erase semantics | P2 | **CORRECTED, `PROMPT №679` — the old "DELIVERED" here was WRONG.** Still a soft onboarding-reset, no forfeiture, no erasure (docstring says so); see E11 |
| UserResponse.email | EXTEND | email capture + expose | P1 | SELF-BUILT №280 (credentials JSONB, no column/migration; UserUpdate.email) |
| i18n EN + date-format pref | NEW | locale catalog + format pref + formatter | P2 | OPEN (confirmed `PROMPT №679`) |
| PracticeResponse {attended, no_show} | EXTEND | per-practice card aggregate | P2 | **DELIVERED, `PROMPT №679`** — `practices/schemas.py:732-733` |
| PracticeResponse.checkin_count (E12) | EXTEND | «😊 N/M» aggregate | P1 | **DELIVERED, `PROMPT №679`** — see E12 |
| apply document-upload (E13) | NEW | file intake + storage | P2 | OPEN (confirmed `PROMPT №679`, no S3 anywhere) |
| application rejection_reason — expose (E14) | EXTEND | surface on profile/apply response | P2 | **CORRECTED, `PROMPT №679` — this row contradicted E14's own STATUS.** E14 has been CLOSED-BY-NAV since 2026-07-14/15 (`users/router.py:63-73` → `MasterPendingView.vue`) — this table row was simply never updated when the epic closed |

---

## C) CROSS-ZONE DEDUP NOTES

- **E1** = ONE endpoint serving three master screens. The cross-practice needs-attention feed is the
  same E1 work (do not build a separate "#3").
- **E2 (income/ledger) ≡ E9 admin revenue** — same ledger layer. *(Both DELIVERED.)*
- **E4 (messaging)** = ONE module: master ↔ participant + admin → user + user → master + support thread.
- **E7 (period stats)** — master `/masters/me/stats` and admin `/admin/stats` = the same period-summary
  contract. *(Both DELIVERED.)*
- **email** — on the apply profile; two exposure points: `UserResponse` (E11) + admin master-review (E9).
- **connection-link** — master Create «Подключение» + user dashboard "Zoom недоступен" = same backend.
- **documents** — E13 upload intake feeds the E9 admin master-review `documents[]` view/download.

## D) NOT A ZOD TASK (frontend-only — do NOT build)

- **E1 per-practice `attention` filter — frontend-wiring, not backend.** The backend filter EXISTS on
  `GET /practices/{id}/reviews` (test-verified, `test_reviews_attention_filter` passes); the frontend
  wrapper `getPracticeReviews` (practices.ts) just doesn't pass it. Do NOT rebuild it. *(The genuine
  backend gap is the cross-practice **filter param** on `/masters/me/reviews` — see E1 STATUS.)*
- **Promo wiring** — the backend POST/list DTOs exist (E10); the `api/promos.ts` GET/DELETE wrappers +
  view connection are frontend. **Stale as written — corrected (2026-07-15):** `GET /masters/me/promos`
  was already delivered by Zod and is frontend-wired (see E10 STATUS); the `DELETE` was deliberately
  NOT built (PATCH-deactivate covers it, per the E10-promo CLOSED-BY-NAV note). Nothing left here for
  anyone — not a live task, Zod's or ours.
- **E2 income attribution** — income/transactions are consumed by `AnalyticsView`, NOT
  `MasterFinanceView` (Finance = payout/withdrawal). Frontend-coordination note, no backend change.
- **Currency ₽ / €, SHELL debts, standalone top-up entry, withdrawal «Выплаты» list (option Б over the
  existing `GET /admin/withdrawals`)** — frontend / operator product decisions, no new backend.

---

## Delivered OUTSIDE the E-epic set (not E-numbered — recorded for coordination)

- **Auto-complete practice by duration (prod-critical lifecycle worker) — DELIVERED.** The backend
  autofinalize worker transitions `scheduled`/`live` → `completed` on `scheduled_at + duration`,
  resolves attendance, and releases frozen funds (autofinalize.py present + enabled). Not in
  `generated.ts` because it is a worker, not an endpoint. *(Was a round-2/3 prod-critical add, not an
  original epic.)*
  - **⟳ VERIFY 2026-06-25 (recon item 4).** On TEST a past-dated practice (e.g. 16 июня, today the 19th)
    still shows `scheduled` and stays in the master's «Предстоящие» (the list filters by status only, no
    date guard; «Прошедшие» is `completed`-only). Since the worker is DELIVERED, this is likely either
    the autofinalize worker not enabled/running on TEST, or a seed artifact (a practice seeded as
    `scheduled` with a past `scheduled_at`, which the worker may not retroactively finalize). Please
    verify the worker is enabled on TEST and finalizes already-past practices (or fix the seed). Per the
    environment note above this may be a seed/env gap, not a contract gap — the frontend deliberately
    ships no hack that would hide a non-completed practice from both tabs.
- **#1 (self-fix, NOT Zod):** `StudentDetailResponse.name` + `avatar_url` added (deployed).
- **#2 (self-fix, NOT Zod):** `test_admin_metrics.py` made seed-tolerant (test-isolation, not a contract
  bug). Optional follow-up (LANE 2026-07-15: OWNED-BY-NAV, not messaging/notifications): harden
  `conftest` isolation (transactional rollback / clean DB).

---

**Summary (actualized 2026-06-28 vs live `origin/test=4713c60`).** Epics E1–E11 + new E12–E17. Of E1–E11:
E1/E2/E5/E7 DELIVERED; E9 core delivered (rich remainder open); E3/E8/E10/E11 PARTIAL; E4/E6 OPEN.
E12–E17 OPEN (E17 PARKED — master web-auth, future web build). **Only delta since 2026-06-24: E8 OPEN →
PARTIAL** (master-notifications contract + capability gate delivered; push/feed open). No regression.
Auto-complete-by-duration + W-6/W-7 (user dashboard) delivered outside the epic set. This is the current
state to hand to Zod against his own numbering.

---

## 2026-07-03 — ROLE_SWITCH_ENABLED removed (heads-up for YOUR docs)

**What changed (commit `15d5b0d`, held batch on `d01f6f9`, PROMPT №256):** the TEST-only
`ROLE_SWITCH_ENABLED` flag is REMOVED entirely (config field, the 404 router gate on
`POST /users/me/role`, the W-4 startup warning + its test file, and the seeded
`credentials.role_switch.allowed_roles` allow-lists — now ignored). Role-switch security is
capability-derived (`derive_allowed_roles` in `app/modules/users/schemas.py`, single source of
truth for the write path AND the `role_switch` block in `GET /users/me`): USER always ·
+MASTER with a verified MasterProfile · admin keeps all three via a server-written
`credentials.role_switch.home_role` round-trip marker; a non-admin can NEVER switch to admin
(CLI `velo setrole` only). The endpoint is always on; a plain user derives `{USER}` and can do
nothing. `ROLE_SWITCH_ENABLED=False` in the TEST `.env` is inert and can be dropped.

**Stale references left in YOUR docs (we don't edit them — please align on your next pass):**
- `VELO-Backend.md:36` — W-4 summary line («громкий security-WARNING при `role_switch_enabled=True`») — the flag and the warning no longer exist.
- `VELO-Backend.md:1202` — same W-4 warning note.
- `VELO-Backend.md:1244` — «эндпоинт 404 в проде при `role_switch_enabled=False`» — the 404 gate is gone; security = derived policy.
- `VELO-Technical-Specification.md:2726` — W-4 checklist entry.
- `VELO-Technical-Specification.md:3146` — W-4 mention in the hardening summary list.

**Optional one-line follow-up in YOUR `set_role.py`:** demoting an admin (→user/master) while
they are role-switched away leaves a stale `credentials.role_switch.home_role="admin"` marker
(they could self-return to admin via the switch). Clearing the marker in your demote path
closes the edge; operator accepted the edge as-is for now (№257 ruling), so this is optional.

---

## 2026-07-03 — zoom_link exposure matrix: test-debt cells (tied to your E18/M-3/Z-6/Z-7 batch)

Pre-push audit (PROMPT №262) mapped `test_zoom_link_visibility.py` onto the full exposure matrix.
The gate itself verified fail-closed (only the two builders set the field). Six cells have NO test —
small additive cases, your file/conventions:

1. `GET /bookings/{id}` — the booking-detail response wipes zoom_link via
   `model_copy(update={"zoom_link": None})` (bookings/router.py:281) — untested.
2. Finalize response — same wipe at bookings/router.py:392-395 — untested.
3. Practice detail for an ATTENDED booking — only CONFIRMED is asserted today
   (test_detail_zoom_link_gated_by_booking); the ATTENDED branch of
   ZOOM_VISIBLE_BOOKING_STATUSES on the DETAIL surface is uncovered.
4. NO_SHOW booking — not asserted on any surface (should be None everywhere).
5. Public catalog list (`GET /practices`) for a user who HAS a confirmed booking —
   the list is unconditionally None even for eligible users (list builder never
   passes visibility); asserting that pins the design.
6. Admin surfaces — zoom_link is structurally absent from all admin serializers
   (grep-verified); one assert would guard against a future admin schema gaining it.

Note: we added the owner-mutation-response cells ourselves in №263
(`test_owner_create_response_shows_zoom_link` / `test_owner_update_response_shows_zoom_link`)
after making the four owner-only CRUD responses in practices/router.py pass
`zoom_link_visible=True` (F1) — consistent with your Z-6 owner-always-sees rule.

---

## 2026-07-03 — U4 no-show reflection: persist endpoint + booking flag (frontend shipped on a stub, PROMPT №269)

The User frontend now has a full **no-show reflection** flow, built entirely on a
**stub** (no backend calls). A booking with `status = no_show` («Не состоялась») now shows
a dashboard banner → `/user/reflection/:practiceId` → `ReflectionView` (FormShell, comment
only, NO rating) → submit. The submit path is a client no-op
(`diaryStore.submitReflection`, `TD-REFLECTION`) that resolves ok and dismisses the banner
**client-side for the session only** (`bookingsStore.dismissedReflections`, mirrors the
existing `dismissedCheckins`). Nothing persists yet. Please wire the backend to make it real:

**1. Persist endpoint — mirror the feedback endpoint shape.**
- `POST /api/v1/practices/{practice_id}/reflection` — body `{ "comment": string | null }`
  (NO rating — a no-show reflection does not rate the practice).
- Upsert semantics, one per `(practice, user)`, like feedback.
- **Eligibility (mirror the feedback gate, inverted status):** `booking.status == no_show`,
  within the window `scheduled_at + duration_minutes .. + 72h`
  (`FEEDBACK_WINDOW_H`, identical to feedback — frontend uses `isInFeedbackWindow`).
- Response can mirror `FeedbackResponse` (a `ReflectionResponse` sibling); the frontend does
  not yet read the response body, so its exact shape is your call.
- May project a diary-feed event (like feedback/check-in) — optional; the frontend does not
  depend on it for the stub.

**2. Booking flag — `has_reflection: bool` on `BookingWithPracticeResponse`.**
- Mirror `has_feedback`: `true` once the user has submitted a reflection for that booking.
- This **replaces** the client-only session dismiss. When the field ships, the frontend will
  switch the dashboard `reflectionAlert` computed from `dismissedReflections.includes(...)`
  to `!b.has_reflection` (one-line swap, symmetrical to `feedbackAlert` reading
  `has_feedback`), and `generated.ts` regenerates then (NOT now — the stub adds no types).

**⚠ DEPLOY-GATE WARNING (has burned us before):** adding `has_reflection` to
`BookingWithPracticeResponse` grows the response key-set. **Before** you add the field,
`grep backend/tests` for frozen **exact-key-set** assertions on the bookings serializers
(e.g. `assert set(data.keys()) == {...}`) and update them in the same commit — the local
pre-push gate skips pytest, so a stale key-set only fails at deploy, not locally.

**Frontend wiring already in place (nothing for you to touch there):**
`utils/reflectionVariants.ts` (copy pool, stable per practiceId), `ReflectionView.vue`,
`stores/diary.ts::submitReflection` (the stub to flip to a real `upsertReflection` call),
`stores/bookings.ts::dismissedReflections`, dashboard `reflectionAlert` + banner, route
`user-reflection`. `generated.ts` UNTOUCHED by the frontend batch.

---

### E20 — Admin-editable catalog (directions / practice types / methods). **P2. STATUS: OWNED-BY-NAV (navigator tail T2) — NOT Zod's lane. Do not start.**

**(a) Why.** Today the taxonomy is code-frozen: adding a practice **direction**, a **practice
type**, or a master **method** requires a code edit + redeploy (see `core/config.py:112`,
`docs/seed-context.md:208-212`). The operator wants an **admin catalog section** to add / edit /
remove entries at runtime — WITHOUT a heavy relational join-table redesign (operator decision **Б:
config-driven editable catalog, grandfather existing data**).

**(b) Screens.** A new admin **«Каталог»** editor (three lists: Направления / Виды практик /
Методы, each with add-edit-remove); the picklists it feeds — `CreatePracticeView`/`EditPracticeView`
(direction + type), `MasterApplyView`/`EditProfileView` (methods).

**(c) What exists today (all code-level constants, NONE are tables — recon PROMPT №314):**
- **Directions:** Python `PracticeDirection(StrEnum)` `practices/models.py:67-88` + runtime allow-list
  `settings.practice_allowed_directions` `core/config.py:139`; stored per-practice in JSONB
  `data.taxonomy.direction` (not a column). FE mirrors: `utils/practiceOptions.ts` `DIRECTION_OPTIONS`,
  `utils/displayHelpers.ts` `DIRECTION_LABEL`, `api/types.ts` `PracticeDirection`.
- **Practice types:** Python `PracticeType(StrEnum)` `practices/models.py:43-53` + allow-list
  `settings.practice_allowed_types` `core/config.py:113`; persisted as a validated `String(20)` column.
- **Methods:** free `list[ShortStr]` (1–200 chars, **no catalog enforcement**) `masters/schemas.py:63`,
  stored JSONB `data.profile.methods`. The only "catalog" is a **frontend-only** const
  `utils/methods.ts` (6 RU strings) — the backend accepts arbitrary strings today.

**(d) Backend — decision Б (config-driven, minimal migration). SUPERSEDED 2026-07-14 by the
operator's R5 Decision 1 = А: TWO FK-linked tables (`practice_directions` + `practice_styles`), on the
grounds that a style is never nested deeper than one level under a direction, so the tree-shaped
`catalog_entries` design below is overkill. The live schema (seed + admin CRUD + read endpoint +
editable admin UI + auto-promote-with-confirm) shipped in batch R, LIVE at c1dbe08 — see the
CLOSED-BY-NAV note at the end of this epic. Building `catalog_entries` now would add a THIRD schema
on top of the two already live. The (d.1)-(d.4) text below is kept as historical record, not a live
spec:**
1. **Catalog store.** A single persisted, admin-mutable catalog for the three lists — a small
   `catalog_entries` table (`kind ∈ {direction, practice_type, method}`, `value`, `label`,
   `active`, `sort`) **or** a JSONB config row — seeded from the current enum / settings values so
   day-one behaviour is identical. No per-practice/per-master data migration.
2. **Rewire the validators** that currently read `settings.practice_allowed_directions` /
   `_types` (`practices/schemas.py:290,466`, `practices/router.py:100`) to read the catalog store
   instead. **⚠ Collision flag: CLEARED (2026-07-15) — the lane is OWNED-BY-NAV (T2), not Zod's, so
   two agents will not be in these validators at once;** `practices/schemas.py:290,466` and
   `practices/router.py:100` are T2's working surface, same as (d.1)-(d.4) above. The underlying
   technical risk stands regardless of who holds the lane: these validators gate practice creation —
   changing their source is load-bearing; a bad catalog row would reject valid `POST /practices`.
3. **CRUD + admin auth.** `GET/POST/PATCH/DELETE /admin/catalog/{kind}` (+ the FE editor screen).
4. **Grandfather / soft enforcement (operator Б):** existing master free-text `methods` stay VALID;
   the catalog drives the **picklist for NEW selections only**; the backend still ACCEPTS
   already-stored off-catalog values (no forced migration, no hard "catalog-only" rejection).
   Strict enforcement (reject off-catalog) = a **later toggle**, not now.

**(e) Notes.** Removing a catalog entry must NOT orphan practices/masters already using it (soft
delete / `active=false` so historical rows still render their label). Directions additionally carry a
FE icon map (`DIRECTION_ICON`, Partial+fallback) — a new direction with no icon falls back gracefully
(`TD-CAL-DIRECTIONS-EXPAND`), so the catalog can add directions ahead of icons. This epic supersedes
the "manual code edit + migration" note in `docs/seed-context.md:208-212` once shipped.

**(f) Deep-scout confirmation (PROMPT №360) + FE read-only ALREADY SHIPPED (batch P).**
Forensic re-verify of the self-vs-Zod hinge — all confirmed:
- The `PracticeDirection` enum is **NOT a gate**: it appears only as docstring/typing mirror
  (`practices/models.py:14,67,75`, `core/config.py:137`) — never a DB column type, `server_default`,
  CHECK, or `PracticeDirection(v)` coercion. Direction is stored as JSONB `data.taxonomy.direction`
  (schema-on-read `@property`, `models.py:201`). New directions store/validate without touching the enum.
- Validation is **soft, per-request**: `v not in settings.practice_allowed_directions /
  _styles_by_direction` inside per-request validators (`schemas.py:290,466,114`, `router.py:100`,
  `_flat_allowed_styles` `schemas.py:84`) — read at REQUEST time, so the read SOURCE can be swapped.
- **No config/settings/kv store exists** (migrations are all domain tables) → a migration is unavoidable.
  **⚠ Historical claim, since overtaken — see below:** this was true when written (PROMPT №360); a
  store now exists (batch R). Kept for context, not as a live statement.
- **T2 scope (navigator, was "Minimal Zod scope" — re-headed 2026-07-15, each part re-verified against
  current code before carrying forward):**
  1. ~~store = 1 migration~~ — **DEAD, already live.** The store this item asked for already exists:
     `practice_directions` + `practice_styles` (batch R migration
     `2026_07_14_1a2b3c4d5e6f_create_practice_taxonomy_tables.py`, LIVE c1dbe08), seeded with values
     matching the `PracticeDirection` enum exactly (`meditation`, `yoga`, …) — table names and seed
     values confirm it was built as the shared taxonomy store, not a methods-only table. T2 does not
     create anything here; it points the practice-creation side at what already exists.
  2. **endpoints — mostly already exist, verify scope not build fresh.** `GET /api/v1/taxonomy`
     (public/master read) and `GET/POST/PATCH /api/v1/admin/taxonomy/*` (admin CRUD) already exist
     (R5) on the SAME tables. T2's work here is confirming these already cover the direction+style
     axis for practice-creation, not standing up `GET /catalog` from scratch.
  3. **validation source-swap — DONE (`PROMPT №679`, 2026-08-12).** The validators moved and were
     rewired in the same refactor: `practices/service.py:346-444` (`_validate_taxonomy`,
     `_direction_in_catalog`, `_catalog_styles_for_direction`) now check the UNION of
     `settings.practice_allowed_directions`/`_styles` **and** the active `TaxonomyDirection`/
     `TaxonomyStyle` DB tables (`service.py:332-343`). The old cited locations
     (`practices/schemas.py` `direction_must_be_valid`, `router.py` `_validate_directions`) no longer
     exist — this is not a new build sitting on top of the old validators, the old validators were
     replaced.
  4. **FE async-fetch — DONE.** `CreatePracticeView.vue:519,717,731` now calls
     `ensureTaxonomyCatalog()`/`catalogDirectionOptions`/`catalogStylesForDirection`, catalog-first;
     `utils/practiceOptions.ts:181`'s `DIRECTION_OPTIONS` is now only the offline/cold-cache fallback,
     not the live source.
  - **Scope caveat, not covered by (1)-(4) above:** the taxonomy tables only cover the
    direction+style axis. `PracticeType` (session **format** — a separate axis, validated in
    `router.py`'s `_validate_types`, persisted as a real `String(20)` column, see (c) above) has NO
    table and NO seed at all — closing (2)-(4) does not close the `practice_type` half of this epic.
- **ACTUALISED `PROMPT №679` — the FE catalog editor is no longer read-only.**
  `AdminCatalogView.vue` now has real `addDirection`/`addStyle` handlers calling
  `POST/PATCH /api/v1/admin/taxonomy/*` — the "read-only, honest note" description below is
  superseded; kept for context only.
- **CLOSED-BY-NAV (batch R, 2026-07-14, LIVE c1dbe08) — E20-catalog, MASTER-METHODS SCOPE ONLY.**
  DB-backed taxonomy self-built: 2 tables (directions/styles) + seed + admin CRUD + read endpoint +
  picker consuming it + editable admin UI + custom-method auto-promote with admin confirmation.
  **⟳ ACTUALISED `PROMPT №679` — the practice-creation scope (directions/styles validators + FE
  fetch) is now ALSO DELIVERED, see items 3/4 above.** Only genuinely remaining: `PracticeType`
  (session **format** — a separate axis) still has no table and no seed at all — closing the
  direction/style side above does not close the `practice_type` half of this epic. **E20 STATUS as
  of this pass: DONE for directions/styles (both methods-side and practice-creation-side); STILL
  OPEN only for the `practice_type` axis.**

### E21 — Zoom attendance tracking. **OWNED-BY-NAV. STATUS: CODE-COMPLETE (`PROMPT №679`, 2026-08-12).** Full pipeline at `backend/app/modules/zoom/` (report-polling, `registrant_id`-ladder matching, 50%-duration threshold, verdict write-back at `bookings/service.py:733-820`).
- **⚠ OPEN — operational, not a code gap:** no server has real Zoom credentials configured
  (`config.py`), so `zoom_tracked` (`bookings/service.py:820`) is false everywhere today and every
  practice still finalizes via the legacy clock-driven path. Activates the moment real S2S
  credentials land.
- **OPEN — a research question left in the code itself:** whether `include_registrant_id` on Zoom's
  report variant is reliable is marked "unconfirmed (E21 research)" (`attendance_service.py:216-223`).

---

## 2026-07-07 — admin «Revoke master» self-added (heads-up for YOUR role lane, A1)

**Self-built (additive, JSONB, NO migration) — do not rebuild, avoid colliding in the role/auth
lane.** New admin endpoints mirror CLI `scripts/set_role.py to_user` **exactly** so the two stay one
behavior:
- `POST /api/v1/admin/masters/{user_id}/revoke` — soft-freeze: `User.role -> user` (only if currently
  master) + clear the switched-away-admin marker (`credentials_without_admin_home`, R-1); profile
  `data.account.status -> "suspended"`, `data.availability.is_accepting -> False`. **Every row is
  preserved** (no delete). Capability keys on `status=="verified"` (`users/service.user_has_master_
  capability`), so suspending drops it → the account logs in user-only.
- `GET /api/v1/admin/masters/{user_id}/revoke-preview` → `RevokeMasterAdvisory` (future scheduled/live
  practices, balance, pending withdrawals). Operator decision **Б: WARN-not-block** — the CLI's
  downgrade guard is surfaced as advisory only; the revoke never blocks.
- **Re-grant** reuses the EXISTING `make_master` re-verify branch (`admin/users/service.py:282-296`,
  the "Сделать мастером" button): a `suspended` profile → `status="verified"` + `role=master`, data
  intact. Verified end-to-end; no change needed there.

If you add a durable revoke/suspension concept later, reconcile with this JSONB soft-freeze so CLI +
admin + your path agree on `status=="suspended"` as the parked state.

---

## 2026-07-07 — admin F-batch backend-blocked items (F2/F6, F4) — REASSIGNED OWNED-BY-NAV 2026-07-15

The admin F-batch shipped its self/FE parts (F1/F5/F3 masters status filter, F7 moderation reset).
Two items were backend-blocked and originally deferred to Zod; both are OWNED-BY-NAV now (2026-07-15
lane policy — neither is messaging/notifications). Recorded here, historical heading kept for context.

### F2/F6 — master card + detail showing «Направление» + «Вид». **STATUS: DONE (`PROMPT №679`, 2026-08-12).** `AdminMastersView.vue`/`AdminMasterReviewView.vue` via `methodTaxonomy.ts` parsing. E19's own schema+workflow ask stays separately open, see E19.

### F4 — self-deleted master candidate → `cancelled_by_user` archival. **NEW. P2. STATUS: OWNED-BY-NAV (backend, 2026-07-15) + FE branch (self, unchanged).**

**Target.** When a user with a **pending** master application deletes their account, the application
row STAYS in the DB, flips to auto-status `cancelled_by_user`, and the admin moderation queue shows
«Аккаунт удалён» with Approve/Reject **disabled**.

**Reality (recon 2026-07-07).** The precondition does **not** exist: `DELETE /api/v1/users/me`
(`users/router.py:139`) → `reset_user_to_onboarding` (`users/service.py:283`) is a documented
**no-op** — it only clears `onboarding_completed`; `is_active` untouched, all data stays, the account
still logs in. Nothing writes `cancelled_by_user` for masters (it is only a booking/diary event
today). No «Аккаунт удалён» UI branch exists.

**What F4 needs:**
1. **Backend — real deletion hook** (the single change-point is already earmarked inside
   `reset_user_to_onboarding`, `users/service.py:287-299`): on account deletion, find the user's
   MasterProfile and if `data.account.status == "pending"` write `status = "cancelled_by_user"`
   (JSONB deepcopy + `set_jsonb`, mirroring `reject_master` `admin/masters/service.py:298-303`).
   ⚠ **`MasterProfile.user_id` FK is `ondelete="CASCADE"` (`masters/models.py:59`)** — a real
   hard-delete of the User would DROP the profile row (opposite of the target). So either soft-delete
   the User (needs an `is_deleted`/`deleted_at` column = migration) or leave the User row and only
   flip the status (no migration). Decide the deletion semantics first.
2. **Frontend (self, ready to wire once the status exists):** `masterStatusLabel` already maps
   `cancelled_by_user → «Аккаунт удалён»` and the masters filter has an «Удалены» tab (F3, currently
   count 0). Still to add: an `isCancelledByUser` branch in `AdminMasterReviewView` that shows
   «Аккаунт удалён» and disables Approve/Reject (note `verify/reject_master` already 409 on
   non-pending via `_load_pending_profile`, so the guard exists server-side — the UI must disable
   rather than call).

**Dependency:** F3's «Удалены» tab stays empty until this ships; «Заблокированы» already populates
from A1's `suspended`.

---

## 2026-07-09 — USER SUPPORT screen shipped (frontend-only stub) → needs a ticket backend (P1)

**Frontend shipped this batch (I3, no backend touch):** a real user Support screen at route
`user-support` (`frontend/src/views/user/SupportView.vue`), reached from the profile hub «Поддержка»
(previously a stub toast). Topic picker + message + honest terminal screen. **No server call** — submit
logs a future-ready payload and points to `mailto:support@velo.app` as the live channel (mirrors the
MasterSupportView stub; it does NOT claim server delivery).

**Topic catalog (user-facing labels) + INTERNAL priority** (priority is NOT shown to the user — it is
our routing/sort signal):

| value | label | priority |
|---|---|---|
| `payment` | Проблема с оплатой / транзакцией | P1 |
| `complaint_master` | Жалоба на мастера | **P0** |
| `practice` | Проблема с практикой | P1 |
| `technical` | Технический вопрос | P2 |
| `other` (+ free-text) | Другое | P2 |

**What Zod needs to build (ticket intake):** **Lane (operator, 2026-07-15): stays Zod's** — support is
delivered THROUGH the messaging module Zod is building, not a standalone form; it is a consumer of
that module. The lane test is "ships through the messaging module", not "contains text".
- A `SupportTicket` model + migration with at least: `id`, `user_id`, `topic` (the value above),
  `priority` (**a real column** — `P0|P1|P2` or an int severity — so the queue can route/sort by it),
  `custom_topic` (nullable, for `other`), `message`, `status` (open/…); optional attachments later.
- `POST /api/v1/support/tickets` (auth = current user) accepting `{topic, message, custom_topic?}`;
  the server derives/validates `priority` from the topic (do NOT trust a client-sent priority — the
  frontend sends it only as a future-ready hint; the server is the source of truth for routing).
- Admin queue to list/sort tickets by `priority` (P0 first). MasterSupportView is the SAME stub and can
  share the ticket model once this exists.
- When live: wire `SupportView.onSubmit` to the real POST (replace the console.info stub + the honest
  terminal copy can then legitimately say the request was received).

The MASTER support form (`MasterSupportView`) is the same stub and should fold into this ticket model
too (its topics are master-oriented: withdrawal / add_direction / rejected — keep both catalogs).
