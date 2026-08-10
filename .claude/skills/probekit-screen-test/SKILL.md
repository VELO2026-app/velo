---
name: probekit-screen-test
description: "Generate and audit Vitest tests for Vue 3 screens (views) and route-transition logic. Mounts real SFCs in happy-dom, asserts the loading/error/empty/content ladder, and exercises route guards bare. No browser, no server, no network. Use when: writing tests for a view/screen, covering an untested view, auditing screen tests, testing route guards or role transitions. Triggers on: 'test this screen', 'screen tests', 'view tests', 'покрой экран тестами', 'тесты экрана', '/probekit-screen-test', 'пробкит экран'."
---

# screen-test v1.9.0

Generates working Vitest tests for VELO's screens (`frontend/src/views/**`) and its
route-transition logic (`frontend/src/router/guards.ts`). Produces real, passing tests —
not templates. Runs them and iterates until green.

<!-- v1.1.0 (PROMPT №439): folded in the seven gaps that cost the skill's first outside
     user (11 screens, PROMPT №432-434) real time. Each was re-verified against the repo
     before being written here. The expensive ones: SC-13 (teleported overlays survive
     unmount), Step 3's Pattern C, and the NBSP trap. Knowledge an orc paid for belongs
     in this file, not in its head. -->


Scope boundary vs the rest of the family:
- `probekit-unit-test` — pure modules (utils, stores, composables). Already covers those.
- `probekit-integration-test` — API/DB/service seams.
- **`probekit-screen-test` (this)** — the SFC render layer and the guard layer. The gap:
  76 screens, 0 tests.

## Configuration

<!-- VELO-tuned at birth (PROMPT №431). Written against the idiom actually in the
     repo, verified by reading all 23 existing test files -- NOT against the
     probekit family defaults, which assume a separate tests/ tree and
     @vue/test-utils. Both are wrong here. See references/velo-idiom.md. -->
test_output_dir: colocated -- `Foo.vue` -> `Foo.test.ts` in the SAME directory. Not a separate tree.
source_dir: frontend/src/views
guards_file: frontend/src/router/guards.ts
report_dir: .tmp/probekit-review
test_command: `cd frontend && npm run test`

## Hard constraints (do not negotiate these)

- **No browser.** No Playwright/Cypress/puppeteer. happy-dom only (`vitest.config.ts:25`).
- **No server, no network, no Telegram, no secrets.** Every boundary is mocked at its seam.
- **No new dependencies.** The harness is `vitest` + `happy-dom` + `vue`, all installed.
  `@vue/test-utils` and `@pinia/testing` are in `package.json` but **deliberately unused** —
  do not introduce them (see references/velo-idiom.md §1).
- **Never touch product code.** If a screen cannot be mounted without a product change,
  STOP and report it. Do not add a seam, do not refactor the screen, do not weaken the test.
- **Never weaken a test to make it pass.** A generated test that fails is either a bug in
  the generation or a real find. Decide which, and say which.

## Execution Steps

**Step 1 — Identify input and mode**

- A `.vue` path under `views/` → generate a screen test.
- `guards.ts` or "transition"/"guard"/"role" in the request → generate a guard test.
- A directory → enumerate, then rank by Step 2 and ask which to take.
- `--audit` → audit existing screen tests against references/screen-antipatterns.md; skip generation.
- No input → run Step 2 and propose the top-ranked untested screens.

**Step 2 — Rank (which screens are worth testing first)**

76 screens are not equal. Score each untested screen; take the highest first.

| Signal | Weight | How to detect |
|---|---|---|
| Irreversible action | +5 | the screen fires an action the user cannot undo: approve/reject a payout, delete, publish, cancel a booking. A bug here cannot be walked back by reloading — it is the highest weight for that reason. `AdminWithdrawalDetailView` (approve → money leaves) is the type case. **Detect it by following the call to the API wrapper and the backend — NEVER from a comment, a button label, or the word "delete".** This is the ONE signal most likely to be scored wrong, because "irreversible" is a property of the endpoint, not of the UI: `EntryView`'s delete looks final and is a SOFT delete with `restoreDiaryEntry` as its inverse (`api/diary.ts:249`); `CheckinView.vue:125` claims "One check-in per booking (hard rule)" while `api/diary.ts:51-55` documents the same call as an **upsert** — "repeated calls overwrite". Both were scored +5 from the UI and both were wrong. An action with an inverse is not irreversible, however permanent the button looks. |
| Touches money | +4 | imports `@/api/payments`, `@/stores/payments`, balance/topup/promo/withdrawal in path or imports. **Also a hard signal for the NBSP trap — see velo-idiom §11.** |
| Has a real state ladder | +3 | template has `v-if` on `loading` AND (`error` OR empty) |
| Store- or API-backed | +2 | imports `@/stores/*` or `@/api/*` |
| Behind a role guard | +2 | its route has `beforeEnter` in `router/index.ts` |
| Branching computed logic | +2 | `computed(` count >= 3 in `<script setup>` |
| Reads wall-clock time | +1 | `Date.now()` / `new Date()` — nondeterministic, so a test earns its keep |
| Inert stub | -5 | every handler is a toast; no store/API/onMounted (e.g. `views/auth/*`) |
| Pure presentation | -3 | no store, no API, no onMounted, no computed |

Report the ranking to the operator before generating in bulk. Never silently pick.

**Step 3 — Classify the screen's pattern** *(this decides the whole test's shape)*

Read the `<script setup>` block. VELO has THREE screen patterns — identify which:

- **Pattern A — store-backed.** State lives in a Pinia store (`store.loading`, `store.error`,
  `store.items`). Example: `views/user/MyBookingsView.vue`.
  → Use a REAL Pinia store (`setActivePinia(createPinia())`), mock the **API seam the store
  imports**, drive the ladder by setting store state directly.
  → **A real Pinia must be installed even when you mock every store the screen reads.**
    Children are not stubbed (velo-idiom §2) and they resolve stores of their OWN; with no
    active Pinia they throw `getActivePinia() was called but there was no active Pinia` and
    the mount dies before the first assertion. Mocked stores never reach Pinia, so the two
    coexist: mocks for what this screen reads, a real Pinia underneath so the real children
    mount. Verified on `PracticeDetailView.test.ts:191-204`.
- **Pattern B — local-ref.** State lives in the component (`const loading = ref(true)`), fed by
  a direct `@/api/*` call in `onMounted`. Example: `views/master/MasterStudentsView.vue`.
  → No pinia needed. Mock the `@/api/*` module the screen imports. Drive the ladder by
  controlling the mock's resolve/reject.
- **Pattern C — HYBRID: store-backed data + a local-ref form.** The screen reads server data
  from a store AND owns local form state in its own refs. Examples: `views/user/TopupView.vue`
  (`useBalanceStore` + `selectedCents`/`customMode`/`customValue` refs, `.vue:88-139`),
  `views/master/MasterFinanceView.vue` (`useMasterStore` + `showPayoutForm`/`submitting`/
  `historyOffset` refs, `.vue:250-530`).
  → Treat the two layers SEPARATELY: mock the store seam for the data half, drive the form
  half by real DOM interaction (type into the input, click the chip). **Mocking one layer for
  both guts the test** — mock the form's state and you assert your own fixture; drive the data
  through the DOM and you have no seam to fail. This misclassification is what a Pattern-C
  screen punishes you for.

Getting this wrong produces a test that mocks the wrong layer and asserts nothing.

**Step 4 — Inventory the mount requirements**

Before writing, grep the screen for each and plan a seam:

**Prove ABSENCE too, and say so in the banner.** Most screens have none of these. If you grepped
`v-show`, the wall clock, `formatMoney` or an overlay and found nothing, write that in the banner —
otherwise the next agent cargo-cults `vi.setSystemTime` and an overlay purge onto a screen with
neither, and dead setup carrying a false justification is worse than no setup. Precedent:
`MasterPracticesView.test.ts` (records that its panes are `v-if`, unlike AnalyticsView's `v-show`, so
nobody copies the scoping across).

| Found | Do this |
|---|---|
| `useRouter` / `useRoute` | mock `vue-router` → `{ push: vi.fn(), back: vi.fn(), replace: vi.fn() }`. Never build a real router. |
| `useToast` | mock `@/composables/useToast` and assert the call |
| `Date.now()` / `new Date()` | `vi.setSystemTime(new Date('...'))` — a FIXED instant, or badges/sorting are nondeterministic |
| `Intl.DateTimeFormat` with `timeZone` | pin the timezone in fixtures; assert on a fixed tz |
| a `Teleport to="body"` child (modals, sheets) | TWO separate obligations: **query** `document.body`, not the mount root (SC-07, `CalendarFilterModal.test.ts:49`) — AND **reap** it in `afterEach`, because a closed overlay survives `app.unmount()` (SC-13). Skipping the reap is the single most expensive mistake in this skill's history. |
| `window.location.href = …` | happy-dom does not navigate, but assigning still throws or warns depending on the value. Stub it: `Object.defineProperty(window, 'location', { value: { href: '' }, writable: true })` and assert the href the screen set. Live case: `TopupView.vue` (redirect to the payment provider). |
| `navigator.clipboard` | **absent in happy-dom** — `navigator.clipboard.writeText(...)` throws `Cannot read properties of undefined`. It is not a stub-if-you-like; the mount or the click dies without it. Define it: `Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true })`. Live cases: `MasterPromocodesView.vue`, `AdminMasterInviteView.vue`. |
| `window.history.state` read at **setup or `onMounted`** | **Seed it BEFORE mount** — the screen reads it while mounting, so seeding after is too late and it sees `null`. VELO hands whole objects between routes this way. Live cases (verified): `AdminWithdrawalDetailView.vue:117` (a `ref()` initialiser), `AdminReportDetailView.vue:199` (`onMounted(loadReport)`), `AdminMasterReviewView.vue:559` (`onMounted(loadMaster)`). |
| `window.history.state` read in an **event handler** | Seed any time before the click — "before mount" is not required. The `onBack()` family reads it only when tapped: `CreatePracticeView.vue:428`, `EditPracticeView.vue:327`, `FeedbackView.vue:137`, `ReflectionView.vue:120`. *(v1.1.0 lumped these in with the row above, having grepped for `history.state` without checking WHEN it is read. Corrected in v1.3.0 — the grep found the string; the truth was one level down, inside the function.)* |
| `IntersectionObserver` / `ResizeObserver` | **PRESENT in happy-dom but INERT — presence is not the test.** `typeof IntersectionObserver === 'function'` passes, `new IntersectionObserver(...)` succeeds, `observe()` succeeds — and the callback fires **ZERO** times, forever (no layout engine to intersect with). This is nastier than a missing global: a missing one throws and you notice, whereas this one lets a sentinel-driven test drive **nothing** and pass vacuously. Stub it with a capturing class that hands you the callback, then fire it by hand — that is TEST setup, not product code. Verified by direct probe; live case: `DiaryFeedView.test.ts` (infinite-scroll feed). |
| `scrollHeight` / `scrollTop` / any layout read | happy-dom has **no layout**: `scrollHeight` is hard `0`. Scroll-compensation branches therefore "pass" while proving nothing — do not assert on them, and say so in the banner (`DiaryFeedView.test.ts` does). |
| `getComputedStyle` / `visualViewport` | happy-dom returns empty strings / undefined. Only matters if read during mount — check. |
| `waitUntilReady()` transitively | `__setReadyForTest(true)` — testTimeout is 5s, READY_TIMEOUT_MS is 10s |
| money rendered anywhere (`formatMoney`) | the ru locale groups thousands with U+00A0 — normalise before asserting (velo-idiom §11). Any amount over 999 fails a normally-typed assertion. |

**Step 5 — Generate** (read references/velo-idiom.md and follow it exactly)

Write the file colocated, `Foo.test.ts`. Open with the repo's `====` banner comment block
stating WHY this test exists and any order/time dependence. Then:

Screens — assert the ladder, one `it()` per rung:
1. **loading** — renders the loader on initial load
2. **error** — renders the error state AND surfaces the real message (not a hardcoded string)
3. **empty** — renders the empty state when the fetch returns nothing
4. **content** — renders what the store/API actually said (assert on real values, not counts alone)
5. **behaviour** — the screen's own logic: sorting, badges, filtering, the preview cap
6. **navigation** — a click pushes the RIGHT route with the RIGHT params

**The ladder assumes a screen that FETCHES A RECORD. A pure create form has none** — there is no
loading rung because there is nothing to load. Do not manufacture one, and do not skip the step:
assert the **inverse**, which is the real property such a screen has —

7. **the form is never gated by its dependencies** — an in-flight or FAILING dependency (the
   taxonomy catalog, a template list) must not block, blank, or disable the form. The user can
   still fill it in and submit.
8. **what can NEVER reach the API** — every validation gate, asserted as "the endpoint was not
   called", plus the exact request body via one `toEqual` when it IS called. For a create form
   this is the whole point: it is the last thing standing between a typo and a live record.

Live precedent: `CreatePracticeView.test.ts` (no ladder; gates + body), `MasterNewPromocodeView.test.ts`.

Guards — assert both directions, per `guards.test.ts`:
1. right role passes (`toBe(true)`)
2. wrong role is redirected (`toEqual({ path: '...' })`)
3. negative space — the guard does NOT touch stores it shouldn't (`expect(fn).not.toHaveBeenCalled()`)

**Step 6 — Run and iterate**

`cd frontend && npm run test`. The suite must be green overall — a red suite blocks deploys
(`frontend/Dockerfile:33`, gate restored in `fda4b9e`). If a generated test fails:
- generation bug → fix the test
- real find → STOP, report it, do not fix product code
- untestable without a product change → STOP, report it

**Step 7 — Report**

Write to `.tmp/probekit-review/`. State: screens covered, ladder rungs asserted per screen,
any real finds, any screens rejected as untestable and why.

## References

- `references/velo-idiom.md` — the mount/mock idiom, verbatim from the repo. Read before generating.
- `references/screen-antipatterns.md` — what makes a screen test worthless.
- `../probekit-core/references/severity-format.md` — family format. *(This skill has no local
  copy, unlike its siblings; v1.0.0 pointed at a `references/severity-format.md` that does not
  exist here. Path corrected to the real file rather than duplicating it.)*

## Anchor

[*] screen-test v1.9.0 * ready
[>] | NEXT: user command
