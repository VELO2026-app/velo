# Probekit sweep — 2026-08-10

**Run:** `PROMPT №673` (wave 1, Orchestrator-82), `№674`/`№675` (waves 2-3, Orchestrator-83).
**Graded by:** Navigator-42, per wave. **Code state:** `4e549a70`, tree clean throughout; no fix was
applied and no file was generated during the sweep.

**Why this file exists.** The skills write their reports to `.tmp/probekit-review/`, which is
git-ignored (`.gitignore:25`). Without this file the findings would live only in an untracked
directory and in chat. The board (`Agent-Velo/DS-build-plan.md`) keeps a pointer; detail lives here,
where there is no size ceiling.

**Scope, and why it is not the stock pipeline.** The owner ruled a sweep of *everything that can
actually say something about this project*, rejecting the orchestrator skill's `full` mode after
being shown that it (a) includes two stages that are structurally mute here — `e2e-bdd-test` has no
browser robot to drive (the owner cancelled it 2026-07-16) and `perf-test` has no local API, its only
reachable targets being the live TEST and PROD servers — and (b) excludes the four audits written for
VELO's own surfaces. `i18n-audit` was skipped as paused (no multi-language surface; it would report a
vacuous pass). `zoom-audit` was skipped as freshly run 2026-07-29 with all three findings since
closed.

Ran, in three waves: arch-review · type-audit · code-audit · security-audit · dependency-audit ·
design-audit · responsive-audit · a11y-audit · screen-test · health-audit · comprehension-debt ·
project-hygiene · unit-test · integration-test.

**Two rules governed the whole run.** Auto-fix OFF — the sweep finds, it does not fix, because fixes
from fourteen audits landing together are neither readable nor gradeable, and a sweep that mutates
while it measures cannot be trusted about either. And: a finding is not a finding until the matched
line has been read, with false positives reported and every clean stage stating what it would have
missed.

---

## 1. Confirmed findings

`[N]` marks the ones the Navigator re-derived personally rather than accepting from the report.

### Backend

1. **`main.py:388-402` — `/health` swallows both probe failures silently.** `[N]` The DB and Redis
   checks each catch a bare `Exception`, set `"degraded"`, and log nothing at all. This is the
   endpoint the deploy script polls for `{ok,ok,ok}`, so a real outage produces a status word and no
   diagnostic trail anywhere.
2. **`payments/webhook_router.py:84` — `except Exception` where `BadRequestError` is meant.** `[N]`
   The two *expected* Stripe failures do log one frame down (`payments/stripe.py:294-302`:
   `stripe_webhook_invalid_payload`, `stripe_webhook_signature_failed`), so routine bad signatures
   are traceable. What vanishes silently is a genuinely unanticipated error — e.g. a
   `_configure_stripe()` misconfiguration — which returns a 400 "Invalid signature" that is not one.
3. **No lock file for the backend** (`pyproject.toml`, range specifiers only). Pre-existing and
   unchanged. This is the owner-PARKED `SEC-1`; reported because the skill still finds it, NOT
   re-opened.
4. **Function-scoped imports to dodge a module-load cycle** (`bookings/router.py:173-177,258-259`,
   with an in-code comment admitting it). The import graph shows this is systemic across
   `bookings`/`practices`/`masters`/`zoom`, not a one-off. Managed, not a live bug.
5. **SQL in routers instead of the service layer** — `ai/router.py:52-54`,
   `payments/purchase_router.py:85,99,120-122`, `reports/router.py:112-127`,
   `practices/router.py:312-313,379,385-386,448`. All simple fetch/count/paginate with no business
   logic inline; consistent enough to read as undocumented convention drift.
6. **No app-level rate limiting beyond `/auth/telegram`** on withdrawal-create, purchase-create and
   practice create/update. Fund safety is covered separately by row-level locking, so this is
   availability and cost exposure, not a double-spend risk.
7. **Large modules:** `practices/service.py` 1515 LOC, `bookings/service.py` 1430 LOC. `[N]` Cohesion
   holds; flagged as a judgement call, not a defect.
8. **Docker log rotation is unconfigured** — `docker-compose.yml` has no `logging:` block. `[N]`
   REPO-DERIVED: the absence is a fact about the file. Whether it is currently costing disk on the
   box is a MACHINE-CLAIM and needs a command run there.

### Frontend

9. **Placeholder text fails contrast everywhere.** `[N]` `--velo-text-muted` is
   `rgba(76,101,137,0.5)`; composited over `--velo-bg-card-solid` (`#ffffff`) it is rgb(166,178,196)
   = **2.15:1**, against 4.5:1 for body text and 3:1 even for UI components. It is the placeholder
   colour of every `VInput` and `VTextarea` in the app. One token, whole-app visual consequence —
   an owner decision, not an agent one.
10. **`useKeyboardFieldScroll.ts:49-53` leaks its `visualViewport` listener.** `[N]` It is removed
    only on the field's own `blur`, and the 65-line file has no unmount hook, so navigating away
    with the keyboard open — the exact case the file exists for — leaves it attached. **Consumers
    include `VInput` and `VTextarea`, i.e. every form field in the app**, which is wider than the
    audit reported. Harmless per instance (`scrollIntoView` on a detached element is a no-op).
11. **Touch targets below the 44px bar:** `.v-btn--sm` is `min-height: 36px` `[N]` and `size="sm"`
    appears in exactly 40 files `[N]`.
12. **`viewport-fit=cover` is absent** from the viewport meta — `viewport-fit` occurs zero times in
    `frontend/index.html` `[N]` (the meta does carry `interactive-widget=resizes-visual`). Impact is
    a device claim and is unverified.
13. **Headings:** ~22 of 84 views render no heading element at all.
14. **Focus outline removed with no replacement** on 4 fields.
15. **`VInput`/`VSelect`/`VTextarea` never pair `<label>` with `for`/`id`.**
16. **`CreatePracticeView.vue` is 1354 LOC** `[N]` — wizard, draft, taxonomy, keyboard handling and
    submission in one file; the least testable of the large modules.
17. **Store-level test gap:** of 9 Pinia stores, the 4 that call the API directly and have no
    dedicated test are `admin`, `calendar`, `master`, `practices` `[N]` (`balance` and `ui` import no
    API at all; `auth`, `bookings`, `diary` have tests). Distinct from view-level mocking.
18. **20 screens have no screen test.** Ranked by the skill; the top candidate performs a
    likely-irreversible action.

### Repository

19. **A byte-identical duplicate asset:** `Design_prototype/assets/backgrounds/background.png` and
    `frontend/public/bg/background.png` share md5 `d7bb4ccbe50b4f928ce98d9e72dd0fbb` `[N]`.
20. **`DESIGN_MIGRATION.md` (48KB) is self-graded "ACTIVELY MISLEADING"** in its own header, by this
    project's own freshness pass on 2026-07-19, and was never archived `[N]`. Its premise — tokens
    sourced from Figma via a migration branch — was killed by the owner's 2026-06-10 ruling that
    dropped Figma permanently. ⚠ Additionally, and not caught by the hygiene skill: it is a tracked
    file written in Russian prose, which the fleet language rule does not allow. Archiving it
    resolves both at once.

## 2. What came back clean, and what that silence does not cover

- **arch-review** (0 critical, 7.4/10): structure only. A cleanly-layered function still computes
  whatever it computes, and a race inside one tidy module is invisible to it.
- **type-audit** (9.6/10): TypeScript is erased at runtime. An API response *declared* as a type is
  trusted; a backend change that alters values rather than shapes cannot be seen.
- **code-audit** (8/10): sampling, not exhaustion — money paths, ownership, auth, webhook signature
  and injection vectors were read deliberately; an un-sampled corner was not.
- **security-audit** (0 critical, 0 high): a source read, not a penetration test. It cannot see
  production log leakage, the deployed nginx config, or fuzzed endpoints.
- **dependency-audit**: it does **not** match CVEs against resolved versions — that is precisely the
  parked `SEC-1` gap. A package with a real disclosed CVE reports clean here by construction.
- **unit-test** (audit mode, 42 non-view files): 0 assertion-free tests and 0 wall-clock-dependent
  tests, both mechanically checked rather than sampled.
- **All backend judgements in this sweep are reads, never executed passes.** The local pytest gate is
  down (`redis_password` undeclared in `Settings`, and pydantic-settings' `extra='forbid'` makes
  `import app.core.config` raise, which kills `conftest.py`). Frontend tests did run: 107 files /
  2132 passing.

## 3. False positives, and what fooled each pattern

Kept deliberately: this is data about the tools, and this home has corrected skills from it before.

- `as any` matched the English words "as any" inside comments; `@ts-expect-error` hits all carried a
  same-line explanation the pattern did not check for; high `!` counts were test files using the safe
  `el!.value = …` idiom after a controlled mount, with no test-file exemption in the rule.
- The orphan-component heuristic called ~130 live UI components unused because it did not know Vue's
  barrel `index.ts` re-export pattern. Exactly one true orphan survived the correction
  (`IconDateLeaf.vue` `[N]`).
- Three endpoints looked unauthenticated from the router signature alone (`GET /practices/zoom/start`,
  `POST /webhooks/stripe`, `POST /auth/telegram`); each is protected by a mechanism a decorator grep
  cannot see — a single-use Redis ticket, Stripe's own signature verification, and HMAC login.
- An LOC threshold mechanically graded two service modules as critical god-modules; the skill's own
  criteria have two further legs (importer count, cohesion) which it had not applied.
- The design probe cited `telegram.ts` hardcoding hex colours — fixed at `PROMPT №437`, with a test
  guarding the fallback against drifting from `variables.css`. A stale citation inside the tool.
- Two grep traps in the a11y pass: image `alt` and form-field `id` attributes were present but split
  across lines by Vue's formatting.
- The ADR probe reports "no decision records" because it greps for `ADR-*.md` filenames;
  `docs/diary-behaviour-spec.md` is a decision record by content and invisible to that pattern.
- Comprehension-debt read a single committer identity (`Artem Balyakno`, 961 commits) as one person.
  It is the whole agent fleet's committer identity, and a run of similar commits is a two-role agent
  workflow, not one human rewriting one file. Its 66.1% churn figure traced to 19 distinct,
  well-labelled commits and does not mean what the raw number implies.

## 4. Standing constraints this sweep did not touch

Recorded so a future reader does not "fix" them: `--velo-frozen-vh` (one-shot) and `--velo-vvh`
(live) are different signals on purpose; `#app-bg` fixed at body level is device-confirmed on Android
and iOS after the bug it fixes returned ten times; `@vue/test-utils` and `@pinia/testing` are
installed and deliberately unused, the harness being bare `createApp` + happy-dom + real Pinia; and
several dead-looking values are kept deliberately (unused enum members, a fallback branch unreachable
under the stub).

## 5. Status

No finding here has been fixed. Triage — which of these become work, in what order — is the owner's,
and this file is the input to it.
