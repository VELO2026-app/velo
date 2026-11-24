<!--
  @velo/ui -- VBottomSheet Component (Phase-3 master DS; migrated FE-145
  P6b -- the modal family batch: VModal, VBottomSheet, VConfirmDialog)

  Flush bottom sheet (operator SVG 2026-06-11): grab handle, big title, content,
  optional primary "save" footer. Differs from VModal (a floating, all-corners
  dialog with an X): this is flush to the bottom edge, rounded top only, NO close
  button — dismissed by tapping the scrim. Reuses VModal's teleport + slide
  transition + scroll-lock + Escape pattern.

  Migrated with NO i18n seam to cut: every label it renders (title, save,
  cancel) is caller copy, so the kit component is pure as-is. The §7.2
  attrs-root seam IS cut by the move: inheritAttrs:false + an explicit
  v-bind merge onto the teleported OVERLAY root (see the titleStrong
  paragraph below for the fallthrough gap that retires). The ref-counted
  body-scroll lock is the kit's own (src/useBodyScrollLock.ts, landed in
  P5). Escape goes through the kit's Escape stack (src/escapeStack.ts,
  FE-215): only the top open overlay closes on one press.

  Usage:
    <VBottomSheet :open="open" title="Practice date" save-label="Save"
                  @save="commit" @close="open = false">
      ...content...
    </VBottomSheet>

  Optional `compactTitle` (PROMPT №609, G11): steps the title font-size
  down from --text-xl (32px) to --text-lg (20px), for a caller whose title
  is long enough to wrap onto two lines (ReportUserSheet's title,
  i18n:report.title -- the longest title of this component's 10 callers).
  Deliberately scoped to an opt-in prop rather than changing the shared
  default: every other caller's title is short enough to already fit fine
  at --text-xl, and changing the shared size would shrink 9 titles that
  were never asked about to fix the one that needed it. Default false,
  every pre-existing caller renders byte-identically.

  Optional `cancelLabel` (PROMPT №610, owner Q3): this component had NO
  cancel button at all -- dismissed only by tapping the scrim or Escape.
  When set (together with saveLabel), renders a two-button ROW instead of
  the single full-width save button: cancel at ~39% width (emits the
  EXISTING `close` event, same as the scrim tap -- no new event needed)
  and save at ~61% (measured, ReportUserSheet's i18n:ui.cancel /
  i18n:common.submitSend pair).
  Default '' = byte-identical to every other caller; only ReportUserSheet
  sets this today.

  Optional `cancelVariant`/`saveVariant` (T24-27/37, PROMPT №634): the
  owner's position-based colour rule -- LEFT (cancel) BLUE, RIGHT (save)
  CORAL, with exactly one owner-ruled exception (Modal E,
  i18n:shared.groups.addTitle: swapped). The paired row's colours were
  already exactly this (cancel primary blue, paired-save --velo-error coral,
  both measured PROMPT №610) -- these props only let a caller INVERT them
  for the one exception; every existing caller (ReportUserSheet) keeps the
  same colours it already had. Defaults 'primary'/'danger' = byte-identical.

  Optional `titleStrong` (T24-25/32, PROMPT №634): a prop, NOT a `:deep()`
  override from the caller's own scoped style -- at the time this component
  lived in the app, its Teleported root silently dropped a caller's `class`
  fallthrough (confirmed the hard way: `[Vue warn]: Extraneous non-props
  attributes (class) were passed to component but could not be automatically
  inherited because component renders fragment or text or teleport root
  nodes`), so a scoped `:deep()` selector from outside could never reach
  `.v-sheet__title`. The FE-145 §7.2 attrs-root merge now lands caller
  attrs on the overlay deliberately; the prop stays (it is the component's
  own variant knob, not a styling escape hatch). Applies the app-wide
  hairline-stroke faux-bold (global.css `.velo-text-strong`'s own recipe,
  reused as a class here rather than via that global class directly, since
  this stays scoped to THIS component). Default false = byte-identical to
  every other caller.
-->

<template>
  <Teleport to="body">
    <Transition name="v-sheet">
      <!-- §7.2 attrs-root: caller attrs merge HERE, onto the teleported
           overlay -- inheritAttrs is false above, so nothing rides Vue's
           (Teleport-blind) fallthrough. -->
      <div
        v-if="open"
        ref="overlayEl"
        class="v-sheet__overlay"
        v-bind="attrs"
        @pointerdown="backdrop.onPointerdown"
        @pointerup="backdrop.onPointerup"
        @pointercancel="backdrop.onPointercancel"
        @click="backdrop.onClick"
      >
        <div
          ref="panelEl"
          class="v-sheet__panel velo-kbd-scroll"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          @touchstart="onTouchStart"
          @touchmove="onTouchMove"
          @touchend="onTouchEnd"
          @touchcancel="onTouchCancel"
        >
          <div
            class="v-sheet__handle"
            aria-hidden="true"
            @pointerdown="onGrabDown"
            @pointermove="onGrabMove"
            @pointerup="onGrabEnd"
            @pointercancel="onGrabCancel"
          />
          <h2
            v-if="title"
            class="v-sheet__title"
            :class="{
              'v-sheet__title--compact': compactTitle,
              'v-sheet__title--strong': titleStrong,
            }"
            :data-velo-compact="compactTitle || undefined"
            :data-velo-strong="titleStrong || undefined"
            @pointerdown="onGrabDown"
            @pointermove="onGrabMove"
            @pointerup="onGrabEnd"
            @pointercancel="onGrabCancel"
          >
            {{ title }}
          </h2>
          <div class="v-sheet__body">
            <slot />
          </div>
          <div v-if="cancelLabel && saveLabel" class="v-sheet__actions">
            <button
              type="button"
              class="v-sheet__cancel"
              :class="{ 'v-sheet__cancel--danger': cancelVariant === 'danger' }"
              :data-velo-variant="cancelVariant"
              @click="requestDismiss"
            >
              {{ cancelLabel }}
            </button>
            <button
              type="button"
              class="v-sheet__save v-sheet__save--paired"
              :class="{ 'v-sheet__save--primary': saveVariant === 'primary' }"
              :data-velo-variant="saveVariant"
              :data-velo-disabled="saveDisabled || undefined"
              :disabled="saveDisabled"
              @click="$emit('save')"
            >
              {{ saveLabel }}
            </button>
          </div>
          <button
            v-else-if="saveLabel"
            type="button"
            class="v-sheet__save"
            :data-velo-disabled="saveDisabled || undefined"
            :disabled="saveDisabled"
            @click="$emit('save')"
          >
            {{ saveLabel }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, onDeactivated, useAttrs } from 'vue'
import { lockBodyScroll, unlockBodyScroll } from '../../useBodyScrollLock'
import { useEscapeLayer } from '../../escapeStack'
import { useBackdropDismiss, useOverlayLayer } from '../../overlayA11y'
import { useSheetDrag } from '../../useSheetDrag'

defineOptions({ inheritAttrs: false })
const attrs = useAttrs()

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    saveLabel?: string
    /** Disables the save button (P3, PROMPT №592 -- e.g. the report form's
     *  send button (i18n:common.submitSend) until a reason is chosen).
     *  Default false -- every pre-existing caller renders byte-identically
     *  to before this prop existed. */
    saveDisabled?: boolean
    closeOnOverlay?: boolean
    /** Sizing-only fix for a long title (PROMPT №609, G11) -- see the file
     *  header. Default false = byte-identical to before. */
    compactTitle?: boolean
    /** Adds a cancel button beside save (PROMPT №610, owner Q3) -- see the
     *  file header. Default '' = byte-identical to before. */
    cancelLabel?: string
    /** Paired-row cancel button colour (T24-27/37, PROMPT №634) -- see the
     *  file header. Default 'primary' (blue) = byte-identical to before
     *  this prop existed. */
    cancelVariant?: 'primary' | 'danger'
    /** Paired-row save button colour (T24-27/37, PROMPT №634) -- see the
     *  file header. Default 'danger' (coral) = byte-identical to before
     *  this prop existed. */
    saveVariant?: 'primary' | 'danger'
    /** Hairline-stroke title weight (T24-25/32, PROMPT №634) -- see the
     *  file header. Default false = byte-identical to before. */
    titleStrong?: boolean
    /** False: every way a PERSON leaves (scrim, Escape, swipe, cancel button)
     *  emits `dismissAttempt` instead of `close` -- for a form with unsaved
     *  edits (FE-233). Does NOT guard the parent's own `open=false`, nor a
     *  route change or a tab switch (`onDeactivated`): those close the sheet
     *  without asking. Default true = byte-identical to before. */
    dismissible?: boolean
  }>(),
  {
    title: '',
    saveLabel: '',
    saveDisabled: false,
    closeOnOverlay: true,
    compactTitle: false,
    cancelLabel: '',
    cancelVariant: 'primary',
    saveVariant: 'danger',
    titleStrong: false,
    dismissible: true,
  },
)

const emit = defineEmits<{
  close: []
  save: []
  /** A dismissal was asked for while `dismissible` is false. */
  dismissAttempt: []
}>()

// Its screen kept alive off-stage (TabRouterView, a dock tap while open):
// an overlay must not stay over the next screen -- close it like a dismiss.
onDeactivated(() => {
  if (props.open) emit('close')
})

const overlayEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

/**
 * A person asked to leave: scrim tap, Escape, swipe, cancel button. A
 * dismissible sheet closes; otherwise the parent hears `dismissAttempt` and
 * decides (a form with unsaved edits asks first).
 *
 * @returns True when the sheet is closing.
 */
function requestDismiss(): boolean {
  if (props.dismissible) {
    emit('close')
    return true
  }
  emit('dismissAttempt')
  return false
}

// A backdrop tap closes only if the press began on the backdrop too (FE-233).
const backdrop = useBackdropDismiss(() => {
  if (props.closeOnOverlay) requestDismiss()
})

// Focus moves into the sheet and returns to the opener; the page under it is
// inert while open (FE-233).
useOverlayLayer(
  () => props.open,
  () => [overlayEl.value],
  () => panelEl.value,
)

// Escape closes only the top open overlay, not every open one (FE-215).
useEscapeLayer(
  () => props.open,
  () => void requestDismiss(),
)

// Swipe-to-close: from the grab zone (handle + title) always, and from the
// rest of the panel when its content is scrolled to the top. The panel follows
// the finger, resists a pull upward, and springs back with the finger's own
// velocity when released short of the threshold (src/useSheetDrag.ts). Only
// with Telegram's vertical swipes disabled (platform/telegram.ts) does the host
// leave this drag to us.
const {
  onGrabDown,
  onGrabMove,
  onGrabEnd,
  onGrabCancel,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
} = useSheetDrag({ panel: panelEl, onRelease: requestDismiss })

// Lock body scroll while open. Ref-counted (W16, PROMPT №409) -- see
// VModal.vue's identical comment for why (two overlays open at once, whoever
// closes first must not unlock the body out from under the other).
let locked = false
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && !locked) {
      locked = true
      lockBodyScroll()
    } else if (!isOpen && locked) {
      locked = false
      unlockBodyScroll()
    }
  },
  // immediate: an overlay mounted already open locks from the first frame
  // (FE-205) -- a plain watch only saw the later false→true flip.
  { immediate: true },
)

onUnmounted(() => {
  if (locked) {
    locked = false
    unlockBodyScroll()
  }
})
</script>

<style scoped>
.v-sheet__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--velo-scrim);
}

.v-sheet__panel {
  /* Takes programmatic focus on open (tabindex=-1); not a control, no ring. */
  outline: none;
  /* Keyboard-safe (bg-freeze batch): carries .velo-kbd-scroll so a field
     focused inside the sheet (e.g. a reject-reason VTextarea) stays reachable
     -- html.is-keyboard-open .v-sheet__panel (global.css) overrides the
     at-rest 90vh to fit the keyboard-shrunk overlay, same pattern as VModal. */
  position: relative;
  width: 100%;
  max-width: var(--velo-screen-width);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: var(--velo-bg-card-solid);
  /* Flush to the bottom edge -> round the TOP corners only. */
  border-radius: var(--velo-radius-sheet-top);
  padding: var(--space-2) var(--velo-rail-pad-x) var(--velo-gap-21);
  overscroll-behavior: contain;
}

.v-sheet__handle {
  position: relative;
  width: 126px;
  height: 7px;
  flex-shrink: 0;
  border-radius: var(--velo-radius-pill);
  background: var(--velo-glass-blue-30);
  margin: 0 auto var(--space-3);
  touch-action: none;
  cursor: grab;
}

/* The 7px bar is the visual; the finger gets a taller invisible zone. */
.v-sheet__handle::after {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--velo-inset-12)) calc(-1 * var(--space-5));
}

.v-sheet__title {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--velo-gap-6) 0 var(--velo-inset-row);
  touch-action: none;
}

/* Opt-in (PROMPT №609, G11) -- see this component's own header for why
   this is a modifier, not a change to .v-sheet__title itself. */
.v-sheet__title--compact {
  font-size: var(--velo-fs-20);
}

/* T24-25/32 (PROMPT №634) -- see the file header for why this is a prop-
   driven class, not a caller-supplied :deep() override. */
.v-sheet__title--strong {
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}

.v-sheet__body {
  flex: 1;
}

.v-sheet__save {
  flex-shrink: 0;
  height: 49px;
  margin-top: var(--velo-inset-row);
  border-radius: var(--velo-radius-pill);
  background: var(--velo-primary);
  color: var(--velo-white);
  border: 1px solid var(--velo-glass-border);
  box-shadow: var(--velo-shadow-glow);
  font-family: var(--font-body);
  font-size: var(--velo-fs-20);
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.v-sheet__save:hover:not(:disabled) {
  background: var(--velo-primary-dark);
}

/* Mirrors VButton's own :disabled recipe (P3, PROMPT №592). */
.v-sheet__save:disabled {
  cursor: not-allowed;
  background: var(--velo-nav-inactive-bg);
  color: var(--velo-text-muted);
  box-shadow: none;
}

/* Cancel + save ROW (PROMPT №610, owner Q3) -- unitless flex-grow ratios
   (39/61, measured) so the gap is handled correctly by the browser
   instead of fighting percentage-basis-minus-gap arithmetic. */
.v-sheet__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--velo-inset-row);
}

.v-sheet__cancel {
  flex: 39 1 0%;
  height: 49px;
  border-radius: var(--velo-radius-pill);
  background: var(--velo-primary);
  color: var(--velo-white);
  border: 1px solid var(--velo-glass-border);
  box-shadow: var(--velo-shadow-glow);
  font-family: var(--font-body);
  font-size: var(--velo-fs-20);
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.v-sheet__cancel:hover {
  background: var(--velo-primary-dark);
}

/* T24-37 (PROMPT №634, Rule 2's one owner-ruled exception --
   i18n:shared.groups.addTitle): cancel repainted coral instead of the
   default blue. */
.v-sheet__cancel--danger {
  background: var(--velo-error);
}

.v-sheet__cancel--danger:hover {
  background: var(--velo-error);
  opacity: 0.9;
}

/* Paired save (measured: --velo-error fill, not the lone-button's primary
   -- ReportUserSheet's send button (i18n:common.submitSend),
   owner-specified, not a mistake to "correct" back to primary). Same
   shape/size as the lone .v-sheet__save, just repainted + given its own
   flex-grow ratio instead of the parent flex-column's implicit full-width
   stretch. */
.v-sheet__save--paired {
  flex: 61 1 0%;
  margin-top: 0;
  background: var(--velo-error);
}

.v-sheet__save--paired:hover:not(:disabled) {
  background: var(--velo-error);
  opacity: 0.9;
}

.v-sheet__save--paired:disabled {
  background: var(--velo-error);
  color: var(--velo-white);
  opacity: 0.5;
  box-shadow: var(--velo-shadow-glow);
  cursor: not-allowed;
}

/* T24-37 (PROMPT №634, Rule 2's one owner-ruled exception): paired save
   repainted blue instead of the default coral. Same specificity as
   .v-sheet__save--paired (one class each) -- source order after it wins. */
.v-sheet__save--primary {
  background: var(--velo-primary);
}

.v-sheet__save--primary:hover:not(:disabled) {
  background: var(--velo-primary-dark);
  opacity: 1;
}

.v-sheet__save--primary:disabled {
  background: var(--velo-nav-inactive-bg);
  color: var(--velo-text-muted);
  box-shadow: none;
  opacity: 1;
}

/* -- Slide-up transition --
   Asymmetric: arrives with a long soft deceleration, leaves quicker with a
   gentle start. The scrim fade carries the same duration (Vue times the
   transition from the overlay, the root). */
.v-sheet-enter-active {
  transition: opacity var(--velo-dur-sheet) var(--velo-ease-out);
}

.v-sheet-leave-active {
  transition: opacity var(--velo-dur-sheet-exit) var(--velo-ease-in);
}

.v-sheet-enter-active .v-sheet__panel {
  transition: transform var(--velo-dur-sheet) var(--velo-ease-out);
}

.v-sheet-leave-active .v-sheet__panel {
  transition: transform var(--velo-dur-sheet-exit) var(--velo-ease-in);
}

.v-sheet-enter-from,
.v-sheet-leave-to {
  opacity: 0;
}

.v-sheet-enter-from .v-sheet__panel,
.v-sheet-leave-to .v-sheet__panel {
  transform: translate3d(0, 100%, 0);
}
</style>
