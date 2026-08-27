<!--
  VELO Frontend -- Composer (shared, PROMPT №740, track 2)

  ONE composer serving both DiaryComposer (diary entries) and ChatThreadScreen
  (DM messages). Extracted after the .tmp/composer-unification.html preview
  was approved by the owner -- this component IS what that preview showed,
  built for real: B38 (bubble spans full width, send control lives INSIDE it,
  not as an outside sibling) / B47 (placeholder is a caller-supplied string,
  wired per consumer) / B48 (the send control renders only once there is
  text -- v-if, not a disabled state) / B50 (solid white fill via the
  existing --velo-bg-card-solid token) / B40 (bounded growth + internal
  scroll, `growCap`, structural to this component; see below).

  PROMPT №741 (track 3) restored what track 2 left as an unused extension
  point: `growCap` is now WIRED by both wrappers from
  `useComposerGrowCap.ts` (the live visual-viewport signal), and the field
  also scrolls itself into view on focus via `useKeyboardFieldScroll`
  (chat had this through VTextarea before track 2 removed the wrap; diary
  never had it -- both get it now, DS-wide default, additive only). Neither
  of these touches `#app-bg` / AppFrame's freeze mechanism (BG-ROOT, closed,
  do not reopen) -- both read an EXISTING published signal
  (`useViewportGeometry.ts`'s `visibleHeight`) or call the browser's own
  `scrollIntoView`, no new viewport machinery.

  What it absorbs from the two call sites it replaces (recon №735):
  (a) `send` is a PROP (text) => Promise<{ok, error?}> -- no store/API import
      here at all; each consumer supplies its own persistence.
  (b) `draftKey` is OPTIONAL. Set -> localStorage-persisted draft (diary's
      existing behaviour, unchanged in shape: `velo:diary:draft:${entryType}`
      lives in the DiaryComposer wrapper, not here). Unset -> no persistence
      at all -- chat drafts are NOT persisted, a deliberate decision, not an
      oversight (see the DONE report for why).
  (c) `composing-change` emits on focus/blur, unconditionally. DiaryFeedView
      depends on this from DiaryComposer; chat's wrapper simply does not
      listen to it. One emit, two consumers, one that uses it.
  (d) the viewport-aware autogrow diary had is NOT reproduced (track 3); what
      IS reproduced is the extensibility point (`growCap` as a prop, not a
      hardcoded formula) so track 3 can wire it in without touching this file
      again.

  `showDraftPreview` (diary-only, opt-in): when blurred with unsent text, show
  a single-line "start of the draft + ellipsis" instead of the placeholder --
  this is DiaryComposer's existing collapsed-preview behaviour (pre-dates this
  extraction, not one of B38/B47/B48/B50/B51, not shown in the approved
  preview). Preserved because nothing asked for its removal; off by default,
  chat does not use it.
-->

<template>
  <div
    class="composer"
    :class="{ 'composer--composing': composing, 'composer--single': singleLine }"
  >
    <div class="composer__field" @click="focusField">
      <textarea
        v-show="!showingPreview"
        ref="inputEl"
        v-model="text"
        class="composer__input"
        :placeholder="placeholder"
        :aria-label="placeholder"
        rows="1"
        :maxlength="maxLength"
        :disabled="submitting"
        :style="growCap != null ? { maxHeight: `${growCap}px` } : undefined"
        @input="autogrow"
        @focus="onTextareaFocus"
        @blur="onBlur"
      />
      <span v-if="showingPreview" class="composer__preview">{{ previewText }}</span>

      <!-- [owner pass] The send control is ALWAYS rendered -- supersedes B48's
           v-if-while-empty: Telegram-style permanence. An empty tap is a
           no-op (onSend's canSend guard), never a send. B48's other half
           stands: no disabled mic/kb placeholder ever (T24-3). -->
      <div class="composer__slot">
        <button
          type="button"
          class="composer__btn"
          aria-label="Отправить"
          :data-testid="sendTestId"
          :disabled="submitting"
          @pointerdown.prevent
          @click="onSend"
        >
          <IconSend :size="20" />
        </button>
      </div>
    </div>

    <!-- [owner pass] Voice-message STUB, flag-gated: a Telegram-style mic
         disc OUTSIDE the field -- a sibling on the same line, to the field's
         right, VISUALLY IDENTICAL to the send disc (same solid fill, same
         geometry, its own icon). It is what narrows the input from the
         right. EMPTY FIELD ONLY (Telegram's own rule): the first real
         character unmounts it and the field springs back to full width --
         as if the disc never existed; clearing the text brings it back.
         NOT functional -- no click handler at all (pointerdown.prevent only,
         so a stray tap never steals the field's focus/keyboard); wire the
         real recorder or delete this when voice messages land.
         v-if, not visibility: off (flag or text) = zero reserved space. -->
    <button
      v-if="voiceStub && !canSend"
      type="button"
      class="composer__btn composer__btn--side"
      aria-label="Голосовое сообщение"
      @pointerdown.prevent
    >
      <IconMic :size="20" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { IconSend, IconMic } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'

export interface ComposerSendResult {
  ok: boolean
  error?: string
}

const props = withDefaults(
  defineProps<{
    placeholder: string
    maxLength?: number
    /** (a): the consumer's own persistence -- this component calls it and
     *  interprets the result, never a store/API of its own. */
    send: (text: string) => Promise<ComposerSendResult>
    /** (b): set -> localStorage-persisted draft under this exact key;
     *  unset/null -> no persistence. */
    draftKey?: string | null
    /** (d): px cap for the bounded-growth textarea. Undefined leaves the CSS
     *  token (--velo-textarea-autogrow-max) as the sole mechanism -- the
     *  extension point for a future viewport-derived value, not exercised
     *  by either consumer today. */
    growCap?: number
    /** Diary-only opt-in, see file banner. */
    showDraftPreview?: boolean
    /** Preserves the `chat-send` test hook without a caller needing to know
     *  this component's internal class names. */
    sendTestId?: string
    /** [owner pass] Voice-message VISUAL STUB (see COMPOSER_VOICE_STUB in
     *  constants): a mic disc OUTSIDE the field, on its line to the right,
     *  narrowing the input. Empty field only -- any real text unmounts it.
     *  No functionality -- the tap is deliberately inert. v-if: unset/false
     *  never reserves space (width as before the stub existed). */
    voiceStub?: boolean
  }>(),
  {
    maxLength: 4000,
    draftKey: null,
    growCap: undefined,
    showDraftPreview: false,
    sendTestId: undefined,
    voiceStub: false,
  },
)

const emit = defineEmits<{
  sent: []
  composingChange: [composing: boolean]
}>()

const toast = useToast()
// DS-wide default (VInput/VSelect/VTextarea already use it): scrolls the
// field into view once the keyboard settles. Merge-safe -- Vue fires this
// AND the component's own `onFocus` below, same pattern those components use.
const { onFieldFocus } = useKeyboardFieldScroll()

const text = ref('')
const submitting = ref(false)
const composing = ref(false)
const inputEl = ref<HTMLTextAreaElement | null>(null)

// [owner pass] Capsule state: while the text is ONE line the field is a
// narrow, fully-round-ended pill; from the second line on it is the spacious
// 22px glass card. Measured (not newline-counted): a wrapped-only line is
// still "2 lines" to the eye, and scrollHeight is the truth the height
// itself already uses. See autogrow() for the threshold.
const singleLine = ref(true)

const canSend = computed(() => text.value.trim().length > 0)

// (b) draft persistence -- opt-in via draftKey, unchanged shape from the
// diary composer this replaces.
function loadDraft(): void {
  if (!props.draftKey) {
    text.value = ''
    return
  }
  try {
    text.value = localStorage.getItem(props.draftKey) ?? ''
  } catch {
    text.value = ''
  }
  void nextTick(autogrow)
}

watch(text, (val) => {
  if (!props.draftKey) return
  try {
    if (val) localStorage.setItem(props.draftKey, val)
    else localStorage.removeItem(props.draftKey)
  } catch {
    /* storage unavailable (private mode / quota) -- ignore, draft is best-effort */
  }
})

watch(() => props.draftKey, loadDraft)

onMounted(() => {
  loadDraft()
})

// Diary-only: collapsed single-line preview when blurred with unsent text.
const showingPreview = computed(
  () => props.showDraftPreview && !composing.value && text.value.trim().length > 0,
)
const previewText = computed(() => text.value.replace(/\s*\n\s*/g, ' ').trim())

// [FE-9] The autogrow INLINE HEIGHT is session state, not persistent state.
// Left in the element across a blur (textarea v-show-hidden behind the
// preview span), it went stale: on re-focus the field showed the old
// multi-hundred-px height, the cap sliced a ~137px window at a half-line
// scroll offset (the "top empty line"), and the first keystroke re-grew the
// container from the full scrollHeight ("container big again after delete").
// Hide -> reset to the natural one-line height; show -> recompute from the
// LIVE layout (the element is back in flow, scrollHeight is real again) and
// park the scroll on the caret's end.
watch(showingPreview, (hidden) => {
  const el = inputEl.value
  if (!el) return
  if (hidden) {
    el.style.height = ''
    el.scrollTop = 0
    // The collapsed preview is a ONE-LINE readout by definition -- the pill
    // collapses back to the capsule regardless of how tall the full draft
    // measures; re-show runs autogrow() and restores the true state.
    singleLine.value = true
  } else {
    void nextTick(() => {
      autogrow()
      el.scrollTop = el.selectionStart === el.value.length ? el.scrollHeight : 0
    })
  }
})

function setComposing(on: boolean): void {
  if (composing.value === on) return
  composing.value = on
  emit('composingChange', on)
}

function onFocus(): void {
  setComposing(true)
}

// Composes this component's own composingChange with the DS-wide
// scroll-into-view default -- both run off the same native focus event.
function onTextareaFocus(e: FocusEvent): void {
  onFocus()
  onFieldFocus(e)
}

function onBlur(): void {
  setComposing(false)
}

function focusField(): void {
  if (composing.value) return
  // [FE-7] Optimistic composing: with unsent text the textarea is hidden
  // behind the collapsed preview span (v-show), and .focus() on a
  // display:none element is a silent no-op in WebKit -- the "keyboard stops
  // opening on the second tap once text exists" bug. Flipping composing
  // FIRST un-hides the field; the focus() one tick later then lands on a
  // visible element. If the programmatic focus is still refused, the field
  // is at least visible, so the user's next tap is a NATIVE focus.
  setComposing(true)
  void nextTick(() => inputEl.value?.focus())
}

// B40: bounded growth, then internal scroll -- the CSS max-height (either the
// `growCap` inline style or the --velo-textarea-autogrow-max token) is the
// cap; this only feeds the textarea's own scrollHeight into it.
// [FE-9] Caret-follow: when typing at the END of a long text (the common
// diary case), keep the caret's line inside the internal scroll window --
// browsers do this inconsistently for programmatically-resized textareas.
function autogrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
  // [owner pass] Capsule threshold: one measured line band is ~29px (16px
  // text @1.3 line-height + 8px textarea padding), two lines ~58px. The 45px
  // cut sits between them with double-margin on both sides -- no font-metric
  // fragility, and it can never disagree with the height the same function
  // just set. Empty field: stays true (never flipped off).
  singleLine.value = el.scrollHeight < 45
  if (el.selectionStart === el.value.length) {
    el.scrollTop = el.scrollHeight
  }
}

async function onSend(): Promise<void> {
  if (!canSend.value || submitting.value) return
  submitting.value = true
  try {
    const result = await props.send(text.value.trim())
    if (result.ok) {
      text.value = ''
      await nextTick()
      autogrow()
      emit('sent')
    } else {
      toast.error(result.error ?? 'Не удалось отправить')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.composer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

/* [Apple Liquid Glass, owner spec] Multi-layer glass -- NOT plain
   glassmorphism: translucent white surface + backdrop blur/saturate (on a
   ::before layer of its own -- the field itself never carries
   backdrop-filter on iOS WebKit, that shimmered), crisp top / soft bottom
   edge highlights, a floating drop shadow, and a separate ::after
   refraction sheen in soft-light. NOTHING animates on scroll: the glass is
   static, only the content moves under it. */
.composer__field {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  /* [voice stub] The field FLEXES (no longer width:100%): the outside side
     disc (mic stub) claims its own column to the right, the field takes
     everything else. Flag off -> no sibling -> full width, byte-identical
     to the pre-stub layout. */
  flex: 1;
  min-width: 0;
  min-height: var(--velo-size-50);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  box-sizing: border-box;
  position: relative;
  /* Owns the ::before/::after layers (relative anchor) and their stacking
     context (translateZ) -- the frost child's z:-1 stays contained. */
  transform: translateZ(0);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 22px;
  background: transparent;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -1px 0 rgba(255, 255, 255, 0.15),
    0 8px 24px rgba(0, 0, 0, 0.08);
  cursor: text;
  /* [owner spec] Focus glow transition: box-shadow / border-color ONLY --
     non-layout properties, zero geometry change, zero layout shift.
     [owner pass] border-radius + padding joined in: the capsule <-> card
     swap (below) animates the same way, still non-composite-cheap and
     layout-stable -- the field's height never animates, only its shape. */
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease,
    border-radius 0.25s ease,
    padding 0.25s ease;
}

/* [owner pass] ONE line = a slim CAPSULE: fully round ends (999px clamps to
   height/2 = a perfect semicircle on the 44px band) and a tight gut -- the
   left padding pushes the text clear of the round end, the right collapses
   so the send disc nests INTO the capsule's cap (Telegram's own collapsed
   bar). The band is genuinely SLIM now: 4px paddings + a 36px disc = 44px
   total (the multi-line card runs ~60px natural). From the second line the
   field is the spacious 22px card above -- driven by the measured
   singleLine state, not newline counting. Glass layers need no touch:
   ::before/::after inherit the radius, so the frost and the sheen follow
   the capsule on their own. */
.composer--single .composer__field {
  min-height: var(--velo-size-44);
  border-radius: 999px;
  padding: var(--space-1) var(--space-1) var(--space-1) 20px;
}

/* [owner pass] The discs shrink with the CAPSULE -- scoped to the root's
   --single state so BOTH discs follow: the send disc inside the field AND
   the outside mic disc. 36px on the 44px band, disc centre on the cap's
   centre circle; the slot reservation follows the send disc (no width jump
   when the line count flips -- everything swaps together with the shape). */
.composer--single .composer__slot {
  width: 36px;
  height: 36px;
}

.composer--single .composer__btn {
  width: 36px;
  height: 36px;
}

/* Optical balance in the small disc: the 20px icon that reads right in the
   44px disc crowds the 36px one -- a hair smaller keeps the same weight. */
.composer--single .composer__btn svg {
  width: 18px;
  height: 18px;
}

/* FE-26 is not sacrificed for the slim look: the visible discs are 36px,
   but a -4px transparent skirt grows each TAPPABLE target back to 44px.
   The buttons are already position:relative (the z:1 glass fix), so the
   skirt is pure hit area -- no visuals, no layout. */
.composer--single .composer__btn::after {
  content: '';
  position: absolute;
  inset: -4px;
}

/* The frost layer: white 12% surface over blur(18) saturate(180). On its own
   child layer (z -1) so the field's text repaints never race the backdrop
   sampling -- the iOS-stable shape for glass over moving content. Its fill
   brightens with focus (below) -- transition lives here, on the base. */
.composer__field::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(255, 255, 255, 0.12);
  transition: background-color 0.2s ease;
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  z-index: -1;
}

/* The refraction sheen: a diagonal light gradient blended soft-light over
   the surface -- the highlight that reads as bent glass. */
.composer__field::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.35),
    rgba(255, 255, 255, 0.05) 45%,
    rgba(255, 255, 255, 0.18)
  );
  mix-blend-mode: soft-light;
}

/* [owner spec] FOCUS = the glass LIGHTS UP FROM INSIDE, not a ring: brighter
   rim (.7), the frost fill lifts 0.12 -> 0.16, the inset top highlight
   sharpens, a hairline white halo and a SOFT COLD glow breathe around the
   pill -- no bright blue border, no neon, no geometry change. */
.composer__field:focus-within {
  border-color: rgba(255, 255, 255, 0.7);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.75),
    inset 0 -1px 0 rgba(255, 255, 255, 0.2),
    0 0 0 1px rgba(255, 255, 255, 0.18),
    0 0 18px rgba(150, 190, 255, 0.2),
    0 8px 30px rgba(0, 0, 0, 0.08);
}

.composer__field:focus-within::before {
  background: rgba(255, 255, 255, 0.16);
}

/* Accessibility, same language: keyboard navigation (:focus-visible) gets a
   TOUCH stronger glass -- a firmer hairline and a larger cool glow, still
   Liquid Glass, never a blue ring. :has() degrades gracefully: engines
   without it simply keep the :focus-within glow above. */
.composer__field:has(.composer__input:focus-visible) {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.8),
    inset 0 -1px 0 rgba(255, 255, 255, 0.25),
    0 0 0 2px rgba(255, 255, 255, 0.35),
    0 0 26px rgba(150, 190, 255, 0.32),
    0 8px 30px rgba(0, 0, 0, 0.08);
}

/* [FE-9 kept verbatim below] The send slot lives INSIDE the field; the
   FIXED-PIXEL radius principle (no --radius-full capsule-growth) carries over
   to the 22px Liquid Glass radius above. The old displacement-recipe blocks
   (glass-defs, black frost dial, url() distortion) are retired in favour of
   the owner's Apple Liquid Glass spec at the top of this file. */

.composer__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  /* [owner spec] No browser focus chrome on the textarea itself -- the glass
     field's :focus-within glow (above) IS the focus state, one surface, no
     double indication. */
  -webkit-appearance: none;
  appearance: none;
  resize: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  line-height: 1.3;
  color: var(--velo-text-primary);
  /* [FE-33] Explicit caret colour: without it some engines fall back to a
     computed/inherit chain that renders the caret barely visible on the white
     field. Same token as the text -- dark enough to read at a glance. */
  caret-color: var(--velo-text-primary);
  padding: var(--space-2) 0;
  /* [FE-9] Vertical centring belongs to the FIELD, not the container: the
     field row is flex-end (the send button pins to the bottom edge at every
     height), which used to slam the one-line textarea DOWN -- placeholder
     sat 8px off the bottom with ~13px of dead air above (34px text band vs
     20.8px line). auto margins re-centre the text vertically in the band
     while flex-end keeps the button pinned; when the text grows past the
     band the margins collapse to 0 and the field fills as before. */
  margin: auto 0;
  /* [FE-9] No user text may break the geometry: unbreakable strings (a 2k
     "word", a pasted URL) used to force a horizontal scroll inside the field.
     Wrapping ANYWHERE keeps every glyph inside the column; pre-wrap preserves
     the author's own line breaks; overflow-x is hidden so nothing can ever
     stick out sideways. Vertical growth is capped (B40 below) -> internal
     scroll, never a taller container. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: hidden;
  /* B40: bounded growth, then internal scroll -- token by default, `growCap`
     overrides via inline style (see template). */
  max-height: var(--velo-textarea-autogrow-max);
  overflow-y: auto;
  transition: color var(--transition-fast);
}

/* [FE-25] Readable placeholder token. Was --velo-text-primary + opacity 0.6
   (≈2.57:1 on the white composer bar) -- readable now, and one source of
   truth with VInput/VTextarea instead of a hand-rolled fade. */
.composer__input::placeholder {
  color: var(--velo-text-placeholder);
}

.composer__preview {
  flex: 1;
  min-width: 0;
  align-self: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-body);
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  color: var(--velo-text-primary);
  opacity: 0.85;
}

/* Fixed-width wrapper around the one action slot -- reserves the button's own
   footprint even when the button isn't rendered, so the row never jumps when
   it appears (B48). */
.composer__slot {
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
}

.composer__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  cursor: pointer;
  background: var(--velo-nav-active-bg);
  color: var(--velo-white);
  /* [Liquid Glass fix] position + z 1 lift the disc ABOVE the field's ::after
     soft-light sheen: a positioned pseudo paints over non-positioned
     children, and the white sheen was washing the slate disc out to
     "lost". It renders on top of the glass light now -- and clicks were never
     affected (::after is pointer-events: none). */
  position: relative;
  z-index: 1;
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast);
}

.composer__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.composer__btn:not(:disabled):hover {
  opacity: 0.85;
}
</style>
