# Diary screen — target behaviour spec

**Authored by Navigator-41 from the owner's rulings, 2026-08-03.** This is the companion to
`diary-behaviour-map.md`, which describes what the screen does TODAY. This file describes what it
must do, and it is the thing a build is graded against.

**Why it exists.** Five build attempts on the diary composer/keyboard problem were rejected on the
owner's device. He ordered the order reversed: describe the behaviour, agree it with him, record it,
and only then build. This file is the record. Nothing in it may be inferred from code — every line
here is either the owner's ruling or is explicitly marked OPEN.

**Code state this spec is written against:** `origin/main` = `2d4fb6ce`, worktree clean. All
`file:line` references verified against that state at authoring time.

---

## §1. The four rulings

Put to the owner as forks on 2026-08-03; his answers, verbatim in effect:

**Ruling 1 — write mode starts on TAP.** The moment the user taps the input field is the start of
write mode: the keyboard rises and the fog is laid over the feed. Not the first keystroke.
*(Owner's own words: "I pressed the input field. That is the start of write mode.")*
The Navigator's stated decision was a split trigger (field on tap, fog on first keystroke); the
owner overruled it, and ruling 2 removed the only reason that split had. Recorded as overruled, not
as agreed — the difference matters if this is ever revisited.

**Ruling 2 — the header never moves. Ever.** The header pill (back arrow, title, menu) stays exactly
where it is, in every state, including while the keyboard is open and while text is being typed.
*(Owner: "the back arrow, the header is in effect always in place — why remove it at all?")*
Today's behaviour, where it leaves the screen on Android when the keyboard opens, is a defect and
nothing else. There is no state in which the header is expected to move, shrink, or hide.

**Ruling 3 — SUPERSEDED THE SAME DAY, and the reversal is stated rather than rewritten.**
~~The keyboard CLOSES after Send.~~ It was ruled on the reasoning that *"the diary is a record of an
event, not a conversation"*. **The owner then redefined the diary AS a conversation** — "сообщения мы
пишем как в Telegram, внутри дневника" — which removes the premise the ruling rested on.
**RULING 3b (owner-ruled 2026-08-03): after Send the keyboard STAYS OPEN, and the feed scrolls so the
just-created entry sits visibly above the keyboard.** Both of his requirements are real — write
several entries in a row, and see that the entry landed — and only this shape serves both. It is also
what his own Telegram reference does.

**Ruling 4 — the pills stop floating and take their own place in the layout, keeping the glass.**
The frosted material and blur stay. What goes is the floating: the header and the composer are no
longer absolutely-positioned islands overlapping the feed — they occupy their own space, and the
feed lives between them.
⚠ **This is the structural ruling and it is the one to re-confirm at the approval gate below.** Its
consequence, stated plainly so it cannot arrive as a surprise: the feed will no longer slide UNDER
the header and composer, so the fade-under-glass effect is lost. The material remains; what it is
laid over changes.
**AMENDED 2026-08-03, after the owner SAW the consequence drawn (`.tmp/` preview, `№661`/`№662`) —
ruling 4 stands, plus a softening he chose over accepting the hard edge:** the feed keeps a **soft
fade at its OWN top and bottom edges**, so cards pale as they approach the boundary instead of being
cut off flat.
⚠ **This is NOT the old 4-zone mask brought back, and the difference is the whole point.** The old
mask existed to hide the fact that cards passed UNDERNEATH floating islands. The new fade serves
appearance only: it is a fade on the feed row's own edge, it requires no overlap, and it requires no
knowledge of the keyboard. A build that reintroduces overlap or a viewport-derived value in order to
achieve it has misread this amendment.
The owner accepted, in exchange, that a card fades rather than physically travelling under glass —
he was told that difference is visible close up before he chose.

**Why it was put as a fork at all, and the measured fact behind it:** the only version of this
screen ever reported as working had no keyboard computation whatsoever — a flat
`position: absolute; bottom: 0`. Every version since computes a `bottom` from live viewport signals
(`1ba4b7cd` -> `88dadca9` -> `a75a9f93` -> `212a3698`), and every one of them has been reported
broken on a device. The floating construction is what forces the computation; ruling 4 removes the
forcing.

> 🔴 **RULING 5 IS DEAD — REVERSED BY RULING 6 ON THE SAME DAY IT SHIPPED (`c122fae5`). READ RULING 6
> FIRST; DO NOT REINSTATE THE FREEZE.** It is kept here in full, struck rather than deleted, because
> a future reader finding the freeze in git and no record of why it went would put it back.
> **Why it died:** the freeze existed so that content moving UNDER THE FOG did not read as random
> jumping. Ruling 6 removes the fog, and once the movement is visible it is not random — it is the
> ordinary behaviour of a message list being pushed up by a growing input, which is exactly what the
> owner asked for. The freeze would now FIGHT the requirement instead of serving it.

~~**Ruling 5 — WHILE COMPOSING, EVERYTHING BEHIND THE FOG IS NAILED DOWN (owner-ruled 2026-08-03).**~~
In English: *"Why does it move at all when the text moves? We covered it with the fog — that's it, it
must stand still. Nailed down. Until we send the entry to the diary."*
> Verbatim original, kept as EVIDENCE of what was actually ruled rather than as prose — a paraphrase
> cannot be checked against him later, which is the one thing a ruling record is for. Enumerated and
> justified per `Claude-Profile-Rules` LANGUAGE; every other line of this file is English:
> *"Зачем он вообще движется при движении текста? Мы его перекрыли туманом, всё, он должен статично
> стоять. Прибитый намертво. Пока мы не отправим введённое сообщение в дневник."*
From the moment write mode begins until the entry is sent (or write mode ends), **nothing behind the
fog may move, resize, re-scroll or re-fade.** The feed is covered and dimmed — it is not being read —
so it has no business shifting when the composer grows by a line.

**The mechanical cause, DEVICE-MEASURED, not inferred:** the composer grows upward by taking space
from the feed row's `flex: 1 1 auto`. Owner's screenshots, prod `68d66890`: composer `rect.top`
**434.71** at one line, **335.69** at six. Every candidate for the visible "jump" — the edge-fade
mask's percentage stops riding the row's moving bottom edge, the fog's `backdrop-filter` re-sampling
shifted content, scroll anchoring — is a CONSEQUENCE of that one box changing size. **Freeze the box
and all of them go, which is why this ruling makes diagnosing the jump unnecessary.**

⚠ **THE TRAP, named because it is the failure that has bitten this screen five times:** a naive
height-lock on the feed row makes the column taller than the viewport when the composer grows, which
pushes the composer BELOW the fold — the original defect, restored. Whatever mechanism is chosen must
keep the composer anchored above the keyboard, the 300px cap intact, and ruling 4's no-overlap-at-rest
intact. **Verify the jump is actually gone on a device; do not assume the freeze implies it.**

**Ruling 6 — NO FOG. THE DIARY IS A CONVERSATION, AND IT BEHAVES LIKE ONE (owner-ruled 2026-08-03,
with Telegram screenshots as the reference).** This supersedes ruling 4's fog work AND ruling 5
entirely. Four requirements, his:
1. **The blur / frosted wash over the feed is REMOVED.** So is the feed's 70% dim. **The diary's
   content stays fully visible and unobscured the whole time he is writing** — that is the point, and
   it is the opposite of everything the fog was built to do.
2. **Activating the field PUSHES the feed content UP, and it keeps pushing as the text grows.** The
   list behaves like a message list: anchored to the bottom, riding above a growing composer.
3. **The composer field itself MAY carry a slight frost**, and only it — so the text being typed reads
   clearly against whatever is behind it.
4. The header stays where it is (ruling 2, unchanged).

⚠ **WHAT DIES WITH THIS, named so nobody restores it by accident:** the full-viewport `position:fixed`
scrim (`№665`), the feed's `opacity: 0.7` dim, and the `composing` height-freeze on the feed row plus
the composer's compose-time `position: absolute` (`№667`). **The fog and the freeze were one idea; both
go together.** What SURVIVES untouched: the baseline keyboard detection, the live-height column
(`calc(var(--velo-vvh) - var(--velo-content-safe-top))`), `--velo-content-safe-top` itself, BG-ROOT,
and the composer's 300px autogrow cap.

⚠ **THE HONEST NOTE FOR WHOEVER READS THIS COLD:** rulings 4, 5 and 6 were all made within one day,
and 6 reverses much of 4 and all of 5. That is not churn for its own sake — each ruling was made on
what the previous build actually looked like on his device, which is the order he asked for after five
source-reasoned failures. The pattern to copy is "he looks, then he rules", not "the spec is unstable".

---

## §2. Target behaviour, state by state

Same twelve steps as `diary-behaviour-map.md` §1, so the two can be read side by side. "TARGET" is
what must be true after the build. "CHANGE" names what differs from today.

| # | State | TARGET behaviour | CHANGE from today |
|---|---|---|---|
| 1 | Diary opened | Header at the top in its own space, composer at the bottom in its own space, feed between them. Immersive mode unchanged: no tab bar, exit via the menu. | Header and composer stop overlapping the feed (ruling 4). |
| 2 | Scrolling the feed | Feed scrolls between the two pills. No content passes under them. Cards **pale toward the feed's own top and bottom edges** (ruling 4 amendment) — appearance only, no overlap, no keyboard-derived value. | The 4-zone mask that hid cards passing UNDER the pills is retired and REPLACED by a plain edge fade serving a different purpose. Not a removal. |
| 3 | Field tapped | Write mode begins HERE: fog over the feed, feed dims, field takes focus, keyboard rises. Header does not move. | Trigger is unchanged (already tap). Header no longer shifts (ruling 2). |
| 4 | Keyboard opening | Composer stays above the rising keyboard throughout the animation. Header stays put. | Today the composer is positioned by a formula recomputed every animation frame; under ruling 4 the layout holds it without a formula. |
| 5 | Keyboard fully open | Composer sits directly above the keyboard. Header fully visible in its original place. No buttons below the field. | This is the reported defect on Android and is the point of the whole rebuild. |
| 6 | First character typed | Send button appears in the action slot. Nothing else moves. | Unchanged. |
| 7 | Text grows past one line | Field grows upward, taking space from the feed, not from the header and not from the keyboard. Buttons stay level with the field's bottom. | Growth must not be able to push the field down behind the keyboard — today the field's own growth and the `bottom` computation are unproven against each other. |
| 8 | Text grows past the cap | Field stops growing at the owner's ~300px figure and scrolls internally. | Unchanged; the 300px is the owner's own number (`DiaryComposer.vue:83-92`), not derived from the keyboard. |
| 9 | Tap outside the field | Write mode ends: fog off, feed undimmed, keyboard dismissed, draft preserved as a collapsed preview if non-empty. Header, as always, does not move. | Unchanged except that the header has nothing to restore. |
| 10 | Send | Entry posts, field empties, **keyboard closes** (ruling 3), feed visible with the new entry. | Today the keyboard stays open. |
| 11 | Keyboard closes | Composer returns to rest at the bottom. Header, as always, unmoved. | Symmetric to 4. |
| 12 | Navigate away | Focus dropped, keyboard state reset, no geometry leaked onto the next screen. | Unchanged — the existing 350ms suppression window is correct and stays. |

---

## §3. What ruling 4 removes, and what it must not break

**Expected to become unnecessary** (to be confirmed by the build, not assumed here):
- the composer's computed `bottom` (`DiaryFeedView.vue:924-926`);
- the header's compensating `top` (`DiaryFeedView.vue:692-694`, added last cycle);
  > ⚠ **Both ranges read `:924-927`/`:692-695` when this file was authored — inherited from
  > `diary-behaviour-map.md`, which swept in the trailing blank line. Corrected 2026-08-03 after
  > Orchestrator-81 measured them at `№661` and I re-derived per line. The map still carries the
  > wrong ranges; this file is the corrected one.
- the dependence of `DiaryComposer.autogrow` on the live visible height for anything except its cap.

**Must not break — each of these is a prohibition with a history:**
- **BG-ROOT.** `#app-bg` fixed at body level (`5a3be00`) fixed the background jumping under the
  keyboard, device-confirmed on Android AND iOS, after it had returned ten times. Nothing in this
  rebuild touches `#app`, `html`, or `body`.
- **The frozen app height** (`--velo-frozen-vh`, `useBackgroundStabilizer`) is a whole-app mechanism,
  not a diary one. `B29` is a separate open defect against it and is NOT in scope here.
- **`useKeyboardFieldScroll` and `useSafeArea`** serve other screens and a different signal family.
  Out of scope, untouched.
- **The fog's tuned pair.** The wash and the 70% feed fade were tuned together in one commit
  (`2b28f2c7`) and are one look, never either alone.

---

## §4. Still OPEN — not resolved by these rulings

1. ~~Does the owner's Android pan the visual viewport, or shrink it?~~ **ANSWERED 2026-08-03 BY
   DEVICE MEASUREMENT — five screenshots of the diagnostic panel on prod `2d4fb6ce`, Android,
   `devicePixelRatio` 2.98, `screen.height` 932. This is the first device measurement in the whole
   saga; everything before it was an argument from source.** The device does BOTH, and the app is
   blind to each half for a different reason:

   **(a) THE KEYBOARD IS NEVER DETECTED AT ALL — this is the root cause.**
   `isKeyboardOpenFrom` (`useViewportGeometry.ts:62-70`) takes `delta = nativeDelta ?? (layoutHeight
   − visualHeight)` and returns `delta > 150` (`constants.ts:99`). `keyboardSignal` read **`native`**,
   so `nativeKeyboardDelta()` (`:53-56`) supplied it: `viewport.stableHeight() − viewport.height()`.
   Measured with the keyboard UP: `WebApp.viewportHeight` **523.7** and `WebApp.viewportStableHeight`
   **523.7** — Telegram reports the shrunken height as the STABLE one, so the delta is **0**, and
   `0 > 150` is false. **`keyboardOpen` read `false` with the keyboard visibly open, and
   `html.is-keyboard-open present: false`.** The browser fallback fails identically: `innerHeight`
   523 against `visualViewport.height` 523.7 move together, delta ≈ 0.
   ⇒ **Neither CSS rule (`:692-694`, `:924-926`) has EVER matched on this device.** They are not
   wrong; they are never invoked. Five fixes refined formulas behind a gate that never opens.

   **(b) THE DISPLACEMENT IS REAL AND READ FROM THE WRONG PROPERTY.** `visualViewport.pageTop` =
   **263.53** with the keyboard up — the browser scrolls the page to reveal the focused field. The
   module reads `visualViewport.offsetTop` instead (`:106`, `:119`), which measured **0** in every
   state, so `--velo-vv-offset` was **`0px`** throughout. The panel prints both, adjacent, and labels
   `pageTop` "not tracked by the module" — the previous cycle shipped the answer in the instrument's
   own output.

   **(c) THE ARITHMETIC, from his numbers.** `--velo-frozen-vh` **828.235px**, never changes;
   `--velo-vvh` **523.697px** with the keyboard up. The composer is pinned to the frozen box's bottom
   (`composer computed bottom: 0px`, `rect.bottom` **828.24**), i.e. ~**304px below the visible
   bottom**. The browser's own 263.53 scroll drags it back to ~564.7 against a visible bottom of
   523.7 — **~41px still under the fold**, which is exactly "visible field, clipped send button". The
   header, pinned to the same box's top with the page scrolled 263.53, is carried **fully off the top
   edge**. Both reported symptoms, reproduced as arithmetic.

   ⚠ **WHAT THIS CHANGES ABOUT RULING 4, and it is not a detail: NORMAL FLOW ALONE DOES NOT FIX
   THIS.** The diary's column is `height:100%` of a box ultimately sized by `--velo-frozen-vh` = 828.
   Make the header and composer plain flex rows and the composer still lands at 828 while 523.7 is
   visible — the same bug, restructured. **The missing piece is that the diary's own column must be
   sized by the LIVE visible height, not the frozen one.** That is ONE value, not a formula, and it
   is precisely what the old iOS-only "working" version got for free: WebKit resized the layout
   viewport itself, so `bottom: 0` was already the bottom of what you could see. Ruling 4 remains
   correct and necessary — it removes the per-frame math — but it must be built against the live
   height or it inherits the defect.
2. **The fog's visible side edges.** Leading explanation, UNVERIFIED: `AppFrame.vue:53-54` caps the
   whole app at `--velo-screen-width` = **402px** (`variables.css:265`) and centres it, so on any
   device wider than 402 CSS px the un-fogged background shows as a strip down each side the moment
   the fog paints. Settled by one number — the owner's screen width. Not settled by anything in this
   repo.
3. **The diagnostic panel owes removal.** It is on production, unconditional, on the diary screen.
   It comes out the moment the screenshot lands. Carried as a debt, not as a feature.

---

## §5. The approval gate — the owner's own requirement

**Owner's instruction, 2026-08-03:** the Orchestrator is to walk him through it step by step — what
happens, when, who enters what, and every state — so that he can agree them BEFORE it is built.

That is binding on the build and it is not satisfied by a description in prose. Concretely:

- The Orchestrator produces a `.tmp/` preview that renders **every state in §2 that is visually
  distinguishable**, each labelled with its step number, viewable at a URL on the `tmp-static`
  server — the house convention for visual approval.
- It STOPS there and reports. **No implementation commit happens before the owner has seen the
  states and said so.**
- **Ruling 4 is called out explicitly in that report**, in one plain sentence naming what the feed
  will no longer do, so the owner is agreeing to the consequence and not only to the phrase.
- Only after his confirmation does the build proceed, and it is then graded against §2 line by line.

**Standing:** anything in §2 that the build cannot deliver is a STOP and a question, never a
substitution. Five attempts have been lost to reasoning that shipped; this file exists to make the
agreement precede the code.
