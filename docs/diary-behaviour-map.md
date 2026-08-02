# Diary screen — behaviour map

**PROMPT №660.** Five build attempts on the diary composer/keyboard problem, none accepted by the
owner. He ordered a full stop and a written description of what this screen actually does today,
before anyone writes another line of code. This file is that description. It is not a proposal and
it fixes nothing — where today's behaviour is obviously wrong, that is said in one clause and left
alone.

**How to read this if you are picking this up cold (a fresh Navigator or Orchestrator):** start with
§1 (the sequence) and §7 (open questions). §5/§6 are reference material — read them when a specific
mechanism needs checking, not front-to-back. Every claim here is either measured (I read the file, ran
a command, or read a commit) or explicitly marked UNRECORDED / UNVERIFIED — those two words are used
consistently through this document and mean exactly what they say.

**Code state this document describes:** `origin/main` = `23f600d5` (deployed, green) plus the
uncommitted work of this same prompt (the diagnostic panel made unconditional). All `file:line`
references are to that state.

---

## §1. The sequence — state by state

For each step: what the code does today, which mechanism drives it, what the user sees, and the
owner's recorded intent where one exists (his own words, from commit bodies or this cycle's rulings).
"UNRECORDED" means no commit, ruling, or spec names an intent for that step — those become §7
questions.

### 1. Open the diary (navigate to `/user/diary`)

- **Code:** `DiaryFeedView.vue` mounts inside `UserShell.vue`'s `MobileLayout` in **fill mode**
  (`UserShell.vue:62`, `isFillRoute` true for `user-diary`). Fill mode means: no floating header
  island from `MobileLayout` itself, no tab bar, `padding: 0` on the scroll container
  (`MobileLayout.vue:289-294`) — the diary owns 100% of its own chrome (header, composer, scrim) as
  absolutely-positioned children of `.diary-feed` (`DiaryFeedView.vue:650`).
- **Mechanism:** `useBackgroundStabilizer.ts` has already frozen `--velo-frozen-vh` at app mount
  (before this navigation); `AppFrame.vue` has already applied the Telegram safe-area top padding
  (`useSafeArea.ts`) above everything, diary included.
- **What the user sees:** the feed loads (cursor-paginated, `useDiaryStore`), header pill
  ("Дневник" + back arrow + "..." menu) at the top, composer pill at the bottom, both floating over
  the feed with no opaque bar.
- **Owner's intent:** recorded — "immersive full-screen mode: no bottom tab bar... exit is via the
  '...' menu" (`UserShell.vue:48-51`).

### 2. Scroll the feed

- **Code:** `.diary-feed__body` (`DiaryFeedView.vue:749`) is the only scrolling element
  (`overflow-y: auto`), masked top/bottom by a 4-zone CSS mask so cards fade in/out under the
  floating header/composer islands instead of hard-clipping (`:756-780`).
- **Mechanism:** plain CSS scroll, no JS involved in the scroll itself; `IntersectionObserver`
  sentinel loads more pages near the bottom.
- **What the user sees:** normal chat-style scroll, entries fade under the header/composer pills.
- **Owner's intent:** recorded — this is the "immersive overlay… glass islands, edge-to-edge feed"
  design (`ed73a45a`), unchanged in spirit since.

### 3. Tap the composer field

- **Code:** `.composer__field`'s `@click="openCompose"` (`DiaryComposer.vue:36`) → if not already
  composing, `setComposing(true)` then focuses the (now-visible) textarea next tick
  (`DiaryComposer.vue:192-196`). The textarea's own `@focus="onFocus"` (`:47`) also calls
  `setComposing(true)` — two paths converge on the same function, idempotent (`if (composing.value
  === on) return`, `:174`).
- **Mechanism:** `setComposing(true)` emits `composingChange` to the parent, which sets
  `composing.value = true` (`DiaryFeedView.vue`, bound via `@composing-change="composing = $event"`),
  which sets the `.diary-feed--composing` class on the root and `.diary-feed__scrim--on` on the
  scrim.
- **What the user sees:** the scrim's fog appears (white wash + blur, restored `23f600d5`) over the
  feed; the feed also dims to 70% opacity (`:969`); the field itself gets its own frost. **The
  keyboard has not necessarily opened yet at this instant** — this step is FOCUS, not keyboard-open;
  they are two different signals (§1.4).
- **Owner's intent, UNRECORDED for the exact trigger point:** the owner insists the header "should
  stay until writing actually starts" (this cycle's report). Whether "writing starts" means
  *focus* (this step) or *first keystroke* (step 6) is not settled anywhere in the code or any prior
  ruling — see §7 Q1. Today's code treats FOCUS as the trigger for everything (fog, header shift,
  composer shift all key off `.diary-feed--composing`, which is set on focus, not on typing).

### 4. Keyboard begins to open

- **Code:** the OS/WebView starts animating the on-screen keyboard in. `visualViewport` fires
  `resize`/`scroll` events, rAF-throttled into `useViewportGeometry.ts`'s `setShift()`
  (`useViewportGeometry.ts:129-155`), which recomputes `keyboardOpen`/`visibleHeight`/`offsetTop` and
  writes `--velo-vvh` / `--velo-vv-offset` / `html.is-keyboard-open` on every frame the browser
  reports a change.
- **Mechanism:** this is the ONE place in the tree that reads the raw signal now (§5). During the
  animation, intermediate frames can report partial heights — nothing in the code waits for the
  animation to finish before repositioning; every frame's value is applied immediately.
- **What the user sees:** **UNVERIFIED, device-only.** Whether the composer/header animate smoothly
  alongside the real keyboard or jump/lag is not something this codebase's own test suite can show
  (happy-dom has no real layout engine — a standing, accepted limitation, not new to this cycle).
- **Owner's intent:** UNRECORDED. No ruling addresses the transient/animating state at all — every
  fix across this whole saga (T24-1 through this rebuild) reasoned about the STEADY state
  (keyboard fully open or fully closed), never the animation in between.

### 5. Keyboard fully open

- **Code:** `html.is-keyboard-open` is set; two CSS rules key off it, both scoped
  `html.is-keyboard-open .diary-feed--composing`:
  - Composer (`:924-927`): `bottom: calc(var(--velo-frozen-vh) - var(--velo-vvh) - var(--velo-vv-offset))`.
  - Header (`:692-695`, added this cycle): `top: var(--velo-vv-offset, 0px)`.
- **Mechanism:** both formulas assume `.diary-feed`'s own box top/bottom coincide with the FROZEN
  box's edges, and both were built to correct for a documented gap (visual-viewport pan/offset) that
  no earlier version of this code ever read. See §4 for exactly what's new here.
- **What the user sees, per the owner's own most recent report (before this rebuild's deploy):** the
  composer sits at/below the keyboard rather than above it, rising only partially once typing begins;
  the header (back arrow, title, menu) leaves the screen. **This is reported to persist on the
  rebuilt code (`23f600d5`) too** — see §6, §7 Q6.
- **Owner's intent:** recorded, in his own words this cycle — composer above the keyboard, header
  stays visible while composing, no buttons show below the field.

### 6. First character typed

- **Code:** `@input="autogrow"` on the textarea (`DiaryComposer.vue:46`) fires on every keystroke.
  `autogrow()` (`:201-217`) reads the shared `visibleHeight` ref (not its own listener, since this
  cycle's rebuild), computes a cap, and sets the textarea's inline `maxHeight`/`height`.
- **Mechanism:** this is INDEPENDENT of `.diary-feed--composing`/`is-keyboard-open` — it fires purely
  from typing, and can change the composer's total footprint (see step 7) without any keyboard state
  change at all.
- **What the user sees:** the field's placeholder disappears, the send button appears in the
  previously-empty action slot (`DiaryComposer.vue:59-70`, `v-if="canSend"`).
- **Owner's intent:** recorded — "a disabled button teases the same way the mic did… never a
  disabled placeholder" (T24-3, `1ba4b7cd`'s body).

### 7. Text grows past one line

- **Code:** `autogrow()`'s cap while composing is `min(300, visibleHeight − 176)`, floored at 80
  (`DiaryComposer.vue:93-95, 206-210`). The textarea's own `height` grows to fit content up to that
  cap, then the textarea scrolls internally.
- **Mechanism:** because `.diary-feed__composer` has no explicit height of its own, growing the inner
  textarea grows the WHOLE composer container, which is positioned via `bottom:` (see step 5) — a
  taller composer extends further UP from wherever `bottom` places it. **The composer's own formula
  is self-cancelling against `--velo-frozen-vh` errors (proven algebraically in the №657 recon) but
  it was never proven against ITS OWN height changing while `bottom` is being computed** — whether a
  mid-keystroke resize and a mid-typing autogrow can race each other is UNVERIFIED.
- **What the user sees:** the field grows taller, buttons stay level with its bottom
  (`.composer--composing { align-items: flex-end }`, `DiaryComposer.vue:348-350`).
- **Owner's intent:** recorded — "the owner's OWN figure, ~1/3 of the screen… a fixed 300px, not
  derived from the keyboard" (`DiaryComposer.vue:83-92`, ruling 3, №630).

### 8. Text grows past the cap

- **Code:** `el.style.height = Math.min(el.scrollHeight, cap)` (`DiaryComposer.vue:214`) — height
  stops growing, `overflow-y: auto` on `.composer__input` (`:283`) takes over, the field scrolls
  internally.
- **What the user sees:** field height stops changing; further typing scrolls text inside the field,
  invisible from outside.
- **Owner's intent:** recorded — the 300px target + 176px chrome-offset bound (§7 above), unchanged.

### 9. Tap outside the field

- **Code:** `.diary-feed__scrim--on` has `pointer-events: auto` while composing (`:957-963`) and no
  click handler of its own — a tap on it is a tap on a non-focusable element, which browsers resolve
  as a blur of whatever WAS focused. `onBlur` (`DiaryComposer.vue:186-188`) calls
  `setComposing(false)`.
- **Mechanism:** entirely native blur; no explicit "outside tap" handler exists in this code (the
  file's own comment says so, `DiaryFeedView.vue` composer-slot area, and `DiaryComposer.vue:24-27`).
- **What the user sees:** keyboard dismisses, fog/dim/header-shift/composer-shift all revert together
  (all keyed off the same `composing` flag), draft text is preserved as a collapsed one-line preview
  if non-empty (`showPreview`, `DiaryComposer.vue:128-129`).
- **Owner's intent:** recorded — "tapping it… blurs the field -> dismisses the keyboard" comment,
  unchanged since T24-1.

### 10. Send

- **Code:** `onSend()` (`DiaryComposer.vue:217-236`) — guarded against empty/in-flight
  (`submitting`), calls `diaryStore.createEntry`, clears text on success (which also clears the
  localStorage draft via the `watch(text, ...)` at `:145-152`), re-runs `autogrow()`, emits
  `created`.
- **What the user sees:** field empties, collapses back toward the idle cap, keyboard typically stays
  open (send does not blur the field) — **UNVERIFIED** whether the owner finds this correct or
  expects send to also close the keyboard; no ruling on record either way.
- **Owner's intent:** UNRECORDED for the post-send keyboard state specifically.

### 11. Keyboard closes

- **Code:** symmetric to step 4 in reverse — `visualViewport` events fire again as the keyboard
  animates out, `useViewportGeometry.ts` recomputes and eventually `keyboardOpen` flips false,
  `html.is-keyboard-open` is removed, both compensating CSS rules stop matching, composer/header
  return to their `bottom:0`/`top:0` base rules.
- **What the user sees:** **UNVERIFIED**, same animation-frame caveat as step 4.

### 12. Navigate away

- **Code:** `router.afterEach` inside `useViewportGeometry.ts` (`:167-173`) blurs the active element,
  resets keyboard state, and opens a 350ms suppression window (`NAV_SUPPRESS_MS`) during which
  `is-keyboard-open`/`--velo-vvh` are not re-asserted, so a still-closing keyboard from the OLD screen
  can't paint its geometry onto the NEW one. This logic is carried over unchanged in spirit from the
  pre-rebuild `useBackgroundStabilizer.ts` (moved, not altered).
- **What the user sees:** clean transition, no leftover fog/shift on the next screen.
- **Owner's intent:** recorded implicitly — this exists specifically because an earlier version
  DIDN'T have it and leaked state (K3f, referenced in the moved code's own comments).

---

## §2. Old vs new — concrete comparison, not adjectives

Three sentences, as asked, then the supporting detail below them:

**The pre-`1ba4b7cd` composer had ZERO dynamic keyboard-repositioning logic at all** — it was a bare
`position: absolute; bottom: 0`, with the only "keyboard adaptation" being a cosmetic
`padding-bottom` shrink while composing (confirmed by reading `5647eacc`'s own
`DiaryFeedView.vue:848-870`, byte-for-byte). **Every version since (`1ba4b7cd` → `88dadca9` →
`a75a9f93` → this cycle's `212a3698`) has been actively computing a `bottom` offset from live
viewport signals, and every one of those computed versions has been reported broken on a device at
least once** — the OLD, dumber version is the only one that was ever reported as working (on iOS
specifically; Android was never claimed to have worked under either approach). **This suggests the
positioning problem was never really about the FORMULA's sophistication — the old flat `bottom:0`
"worked" on iOS because of an implicit platform behavior (very likely WebKit's own visual-viewport
handling) the app never modeled or controlled, and every attempt since has tried to REPLACE that
implicit behavior with explicit math that keeps missing some piece of what the platform was actually
doing for free.**

Supporting detail:
- `5647eacc` (the DIA rebuild, 2026-07-29) changed the COMPOSER'S OWN internals (one-row layout, mic
  removed, autogrow cap) and explicitly did NOT touch `DiaryFeedView.vue`'s positioning — its own
  commit body states "DiaryFeedView.vue is untouched… there was nothing to fix," which the §657 recon
  already found to be the wrong premise (the composer's OWN growth DOES change its footprint; nothing
  in that commit's reasoning ever traced that through).
- `1ba4b7cd` (T24-1..4, 2026-07-31) is the FIRST commit to add any dynamic composer/header logic at
  all, and its own commit body already states the (later-revised) belief that Android alone needed
  fixing and iOS was fine as-is — a premise this cycle's recon (№653) found reason to doubt, and
  which the owner's own later screenshots (showing overlay-model symptoms on Android) contradicted
  outright.
- The fog/frost history is a SEPARATE thread from positioning: `95b8f2eb` (2026-06-02) introduced it
  at 45%/blur-10/feed-85%, `2b28f2c7` (2026-06-05) retuned to 20%/blur-10/feed-70% (the values
  restored this cycle), `T24-2` (`1ba4b7cd`) stripped the frost entirely reading a note as "remove
  everything," and this cycle restored it. This thread never touched positioning logic and isn't
  entangled with the composer's history despite living in the same files.

---

## §3. `origin/test` — measured, not assumed

`origin/test` = `3116dd22` at measurement time. Diffed against `origin/main` for every diary/keyboard/
viewport-relevant file:
- `frontend/src/stores/diary.ts`, `useKeyboardFieldScroll.ts`: differ only in an un-Latinized
  "ПРОМТ" vs "PROMPT" comment marker — `origin/test` simply predates the repo-wide convert-token
  sweep (`04305786`) that is unrelated to this screen's behavior.
- `backend/app/modules/diary/checkins_service.py`: one-line, unrelated to composer/keyboard behavior.
- Every other diary/keyboard file that differs (`DiaryComposer.vue`, `useBackgroundStabilizer.ts`,
  `useKeyboardOpen.ts`, `useViewportGeometry.ts` — absent entirely on test, `DiaryFeedView.vue`) is
  explained ENTIRELY by `origin/test` not having this cycle's rebuild yet (main and test have not been
  merged either direction; the divergence is `43 28` commits, unrelated to the diary specifically).

**Conclusion: `origin/test` carries nothing relevant to this screen's behavior that main doesn't
already have or supersede.** Not touched, not merged, per instruction.

---

## §4. Every mechanism that can move, size, hide, or blur something on this screen

| # | Mechanism | file:line | Reads | Writes | Knows about the others? |
|---|---|---|---|---|---|
| 1 | `useBackgroundStabilizer` (freeze) | `composables/useBackgroundStabilizer.ts:107-149` | `visualViewport.height` or `innerHeight`, ONCE at mount + on `orientationchange` | `--velo-frozen-vh` | No — deliberately one-shot, guardrailed against ever reading a live signal |
| 2 | `useViewportGeometry` (live) | `composables/useViewportGeometry.ts:99-198` | `visualViewport.height/offsetTop`, `@tma.js/sdk-vue viewport` | `--velo-vvh`, `--velo-vv-offset`, `html.is-keyboard-open`, refs `visibleHeight`/`viewportOffsetTop`/`keyboardOpen`/`keyboardSignal` | Yes — this cycle made it the single canonical source; #3-#7 below all read FROM it, not from raw signals |
| 3 | Composer position rule | `views/user/DiaryFeedView.vue:924-927` | `--velo-frozen-vh`, `--velo-vvh`, `--velo-vv-offset` (all from #2) | `.diary-feed__composer`'s `bottom` | Yes, via CSS vars |
| 4 | Header position rule (new, this cycle) | `views/user/DiaryFeedView.vue:692-695` | `--velo-vv-offset` (from #2) | `.diary-feed__header`'s `top` | Yes, via CSS vars |
| 5 | `DiaryComposer.autogrow` | `components/shared/DiaryComposer.vue:201-217` | shared `visibleHeight` ref (from #2) | the `<textarea>`'s inline `maxHeight`/`height` | Yes, this cycle — used to read `window.visualViewport` on its own |
| 6 | Scrim fog | `views/user/DiaryFeedView.vue:951-963` | `composing` (component state, from focus/blur, NOT from #2) | `.diary-feed__scrim`'s background/blur | No — entirely independent of keyboard state, keyed only on focus |
| 7 | Feed fade | `views/user/DiaryFeedView.vue:969-971` | `composing` (same as #6) | `.diary-feed__body`'s opacity | No — same as #6 |
| 8 | Tab bar hide (other screens, not diary — diary has no tab bar) | `composables/useKeyboardOpen.ts` (now a re-export of #2's `keyboardOpen`) | — | — | Yes, via #2 |
| 9 | `useKeyboardFieldScroll` (OTHER screens, not diary) | `composables/useKeyboardFieldScroll.ts:25-64` | its own `visualViewport` listener | `el.scrollIntoView()` calls | No — deliberately separate, pre-existing, never touches `--velo-vvh`/`is-keyboard-open` |
| 10 | `useSafeArea` (app-wide, not diary-specific) | `composables/useSafeArea.ts:52-66` | `@tma.js/sdk-vue` safe-area signals | nothing written — returns a computed value `AppFrame.vue` binds inline | No — different signal family entirely (safe-area insets, not keyboard) |
| 11 | `AppFrame` (app-wide) | `components/layout/AppFrame.vue:19` | `useSafeArea()`'s `contentSafeTop` (#10) | inline `padding-top` on the whole app | Via #10 only |

**Summary of the "none of them know about each other" defect this whole cycle set out to fix:**
mechanisms #1–#5 now form one coherent chain (#2 is canonical, #1/#3/#4/#5 all consume it). **#6/#7
(the fog/fade) are STILL entirely disconnected from keyboard state** — they key only on `composing`
(focus), never on `is-keyboard-open` or the offset. This is why the fog appears at focus-time (step 3
above) rather than at keyboard-open time, and is exactly the ambiguity in §1 step 3 and §7 Q1.
**#9/#10/#11 are legitimately separate concerns** (different screens, different signal), not part of
the defect, left alone deliberately.

---

## §5. Why the diagnostic panel never rendered — four attempts, no confirmed sighting

Investigated three concrete hypotheses this cycle, from source. Two are **KILLED BY MEASUREMENT**,
not assumed; one remains **UNRESOLVED and is now the leading explanation**.

1. **Pointer-events chain to the (former) tap target.** `.diary-feed__title`'s `pointer-events: auto`
   inside a `pointer-events: none` ancestor structurally mirrors `.diary-feed__back`
   (`DiaryFeedView.vue:716-718`), which is already proven live — the back button works. Grepped every
   layout ancestor (`AppFrame.vue`, `MobileLayout.vue`, `UserShell.vue`, `global.css`) for
   `transform`/`filter`/`backdrop-filter`/`contain`/`will-change` that could hijack the panel's
   `position: fixed` containing block — zero hits. **KILLED as the sole explanation** — the mechanism
   was structurally sound. (Moot now regardless: the gesture is deleted this prompt.)

2. **Telegram fullscreen native chrome physically intercepting the touch before it reaches the
   WebView.** A real, measured phenomenon in this exact codebase — `useSafeArea.ts:21-23` records a
   **device-verified 70px** top band in fullscreen mode (`safeAreaInset.top=44` +
   `contentSafeAreaInset.top=46`, minus a 20px overlap) that belongs to Telegram's own native
   controls, not the web page. **But `AppFrame.vue` applies this exact offset as `padding-top` above
   EVERY screen, diary included** (`App.vue:34`, `AppFrame.vue:19`) — so the diary's header, and the
   (former) title tap target, should already sit well clear of that band (70px AppFrame padding + the
   diary's own 34px header padding = 104px from the true top). **KILLED as the explanation for the
   panel specifically** — though see §7 Q6, because this is the SAME mechanism candidate for why the
   HEADER itself goes off-screen once the keyboard opens, which is a live, unresolved question.

3. **Service-worker / PWA precaching a stale bundle, surviving a normal "clear cache."** **UNRESOLVED
   — the leading candidate.** This app is a PWA (`vite.config.ts:22-51`, `VitePWA` with
   `strategies: 'generateSW'`, `registerType: 'autoUpdate'`). Grepped the entire frontend source for
   any explicit service-worker registration call (`serviceWorker`, `registerSW`, `pwa-register`) —
   **zero hits**; registration is entirely auto-injected by the build plugin, with no app code
   controlling its update lifecycle. `index.html` and other static assets are in the Workbox
   PRECACHE list (`globPatterns: ['**/*.{js,css,html,...}']`), which is a SEPARATE cache from the
   `NetworkFirst` runtime cache also configured. Standard "clear browser cache" on a phone does
   **not** reliably clear Service Worker Cache Storage or force an immediate SW update — that
   typically needs either the SW's own update-and-reload cycle to complete (which depends on how
   `autoUpdate` behaves inside a Telegram Mini App's WebView lifecycle specifically, not a normal
   browser tab) or an explicit "clear site data." **This is the only hypothesis that cleanly explains
   FOUR CONSECUTIVE ATTEMPTS across entirely different mechanisms (role gate, then three different
   tap-gesture tunings) producing IDENTICAL silence** — if the owner has been looking at a cached
   bundle from before any of these changes, no amount of correct code would ever have been observed.
   **UNVERIFIABLE from source alone.** What would establish it: after this prompt's change (panel now
   unconditional, no gesture required at all), if it STILL does not appear, that is strong evidence
   for this hypothesis specifically, since there is no longer any interaction required to fail.

**This cycle's actual fix, independent of the cause:** made the panel render unconditionally (no
gesture, no role, no storage) — §7 Q7 covers what to check next if it still doesn't appear.

---

## §6. The fog's visible side edges — the Navigator's lead, measured

**Lead as given:** `.diary-feed__scrim` is `inset: 0` against `.diary-feed`, which sits inside the
layout's side rail, so the blur would stop at the rail.

**Measured and KILLED as stated.** `.diary-feed` renders inside `MobileLayout`'s **fill mode**
container, and `.mobile-layout__main--fill` explicitly sets `padding: 0`
(`components/layout/MobileLayout.vue:289-292`), overriding the normal 24px
`--velo-rail-pad-x` side padding that non-fill screens carry (`:243-244`). Confirmed by source order:
`--fill`'s rule appears AFTER the base rule and both have equal (single-class) specificity, so the
later rule wins outright. `.diary-feed` itself adds no padding of its own
(`DiaryFeedView.vue:650-654`). **The side rail is not the cause — it doesn't exist for this screen.**

**Alternative, unverified without a device-width reading:** `AppFrame.vue:52-54` caps the WHOLE app
at `max-width: var(--velo-screen-width)` = **402px**, centered (`margin-inline: auto`). On any device
whose CSS viewport width exceeds 402px, this leaves a gutter on each side where `#app-bg`'s
full-viewport photo background shows through. At rest this gutter is invisible (the background is
continuous across the gutter and the 402px frame). **The moment the fog paints — a white wash + blur
INSIDE the 402px frame only — the gutter would become newly visible as a hard-edged, un-fogged strip**,
which would read exactly as "the fog has edges." Whether the owner's device exceeds 402px CSS px is
**UNVERIFIED** — common Android phones range roughly 360–430px depending on device and display
scaling, so this is plausible but not confirmed. §7 Q4.

---

## §7. Open questions for the owner

Phrased for him to answer directly, no code required.

1. **When should "writing mode" (the fog, the header shift, the composer shift) begin — the moment
   you TAP the field, or the moment you TYPE the first letter?** Today it is tap (focus). If you tap
   and then hesitate before typing, today's code already shows the fog and starts moving things.

2. **When you say the header should "stay until writing actually starts" — does that mean it should
   stay fully in place through the ENTIRE time you're composing, or only that it shouldn't disappear
   at the exact instant the keyboard begins to slide up?** These are different behaviors and the
   current code does not distinguish them.

3. **After you tap Send, should the keyboard close automatically, or should it stay open so you can
   write another entry right away?** No prior decision on record either way.

4. **Can you tell us your phone's model or screen width?** (Settings → About phone, or we can walk
   you through reading it.) This settles whether the app's fixed 402px design frame is narrower than
   your actual screen — which is now the leading explanation for the fog's visible edges.

5. **Do you want the diary's frosted-glass "floating pill" header/composer look kept as-is, or would
   you accept a structurally simpler layout** (e.g., reserved, non-overlapping space for the header
   and composer instead of floating absolutely-positioned islands) **if it were more reliable?** This
   is not a proposal to build either one — it's asking which trade-off you'd accept if the current
   visual language turns out to be part of why this keeps breaking.

6. **Once the panel is visible on your screen (this prompt's only code change), can you send one
   screenshot with it up, keyboard open, exactly like your last report?** The two fields that answer
   the standing questions from prior prompts are `viewportOffsetTop` (nonzero = the pan diagnosis
   holds; zero while things are still broken = it's falsified) and `keyboardSignal` (`native` vs
   `browser` — which signal is actually deciding keyboard-open on your device).

7. **If the panel still does not appear after this change, would you be willing to fully close the
   Telegram app (not just navigate back) and reopen it, rather than "clearing cache"?** This would
   help rule in or out the service-worker caching explanation in §5.
