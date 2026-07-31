<!--
  VELO Frontend -- VBottomSheet Component (Phase-3 master DS)

  Flush bottom sheet (operator SVG 2026-06-11): grab handle, big title, content,
  optional primary "save" footer. Differs from VModal (a floating, all-corners
  dialog with an X): this is flush to the bottom edge, rounded top only, NO close
  button — dismissed by tapping the scrim. Reuses VModal's teleport + slide
  transition + scroll-lock + Escape pattern.

  Usage:
    <VBottomSheet :open="open" title="Дата практики" save-label="Сохранить"
                  @save="commit" @close="open = false">
      ...content...
    </VBottomSheet>

  Optional `compactTitle` (ПРОМТ №609, G11): steps the title font-size
  down from --text-xl (32px) to --text-lg (20px), for a caller whose title
  is long enough to wrap onto two lines (ReportUserSheet's «Сообщить о
  пользователе» -- the longest title of this component's 10 callers).
  Deliberately scoped to an opt-in prop rather than changing the shared
  default: every other caller's title is short enough to already fit fine
  at --text-xl, and changing the shared size would shrink 9 titles that
  were never asked about to fix the one that needed it. Default false,
  every pre-existing caller renders byte-identically.

  Optional `cancelLabel` (ПРОМТ №610, owner Q3): this component had NO
  cancel button at all -- dismissed only by tapping the scrim or Escape.
  When set (together with saveLabel), renders a two-button ROW instead of
  the single full-width save button: cancel at ~39% width (emits the
  EXISTING `close` event, same as the scrim tap -- no new event needed)
  and save at ~61% (measured, ReportUserSheet's «Отмена»/«Отправить»).
  Default '' = byte-identical to every other caller; only ReportUserSheet
  sets this today.

  Optional `cancelVariant`/`saveVariant` (T24-27/37, ПРОМТ №634): the
  owner's position-based colour rule -- LEFT (cancel) BLUE, RIGHT (save)
  CORAL, with exactly one owner-ruled exception (Modal E, «Добавить в
  группу»: swapped). The paired row's colours were already exactly this
  (cancel primary blue, paired-save --velo-error coral, both measured
  ПРОМТ №610) -- these props only let a caller INVERT them for the one
  exception; every existing caller (ReportUserSheet) keeps the same
  colours it already had. Defaults 'primary'/'danger' = byte-identical.

  Optional `titleStrong` (T24-25/32, ПРОМТ №634): a prop, NOT a `:deep()`
  override from the caller's own scoped style -- this component's template
  root is Teleported, and Vue does not forward a caller's `class` fallthrough
  onto a Teleported root (confirmed the hard way: `[Vue warn]: Extraneous
  non-props attributes (class) were passed to component but could not be
  automatically inherited because component renders fragment or text or
  teleport root nodes`), so a scoped `:deep()` selector from outside can
  never reach `.v-sheet__title`. Applies the app-wide hairline-stroke
  faux-bold (global.css `.velo-text-strong`'s own recipe, reused as a class
  here rather than via that global class directly, since this stays scoped
  to THIS component). Default false = byte-identical to every other caller.
-->

<template>
  <Teleport to="body">
    <Transition name="v-sheet">
      <div v-if="open" class="v-sheet__overlay" @click.self="onOverlay">
        <div class="v-sheet__panel velo-kbd-scroll" role="dialog" aria-modal="true">
          <div class="v-sheet__handle" aria-hidden="true" />
          <h2
            v-if="title"
            class="v-sheet__title"
            :class="{
              'v-sheet__title--compact': compactTitle,
              'v-sheet__title--strong': titleStrong,
            }"
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
              @click="$emit('close')"
            >
              {{ cancelLabel }}
            </button>
            <button
              type="button"
              class="v-sheet__save v-sheet__save--paired"
              :class="{ 'v-sheet__save--primary': saveVariant === 'primary' }"
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
import { watch, onMounted, onUnmounted } from 'vue'
import { lockBodyScroll, unlockBodyScroll } from '@/composables/useBodyScrollLock'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    saveLabel?: string
    /** Disables the save button (P3, ПРОМТ №592 -- e.g. the report form's
     *  «Отправить» until a reason is chosen). Default false -- every
     *  pre-existing caller renders byte-identically to before this prop
     *  existed. */
    saveDisabled?: boolean
    closeOnOverlay?: boolean
    /** Sizing-only fix for a long title (ПРОМТ №609, G11) -- see the file
     *  header. Default false = byte-identical to before. */
    compactTitle?: boolean
    /** Adds a cancel button beside save (ПРОМТ №610, owner Q3) -- see the
     *  file header. Default '' = byte-identical to before. */
    cancelLabel?: string
    /** Paired-row cancel button colour (T24-27/37, ПРОМТ №634) -- see the
     *  file header. Default 'primary' (blue) = byte-identical to before
     *  this prop existed. */
    cancelVariant?: 'primary' | 'danger'
    /** Paired-row save button colour (T24-27/37, ПРОМТ №634) -- see the
     *  file header. Default 'danger' (coral) = byte-identical to before
     *  this prop existed. */
    saveVariant?: 'primary' | 'danger'
    /** Hairline-stroke title weight (T24-25/32, ПРОМТ №634) -- see the
     *  file header. Default false = byte-identical to before. */
    titleStrong?: boolean
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
  },
)

const emit = defineEmits<{
  close: []
  save: []
}>()

function onOverlay(): void {
  if (props.closeOnOverlay) emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}

// Lock body scroll while open. Ref-counted (W16, ПРОМТ №409) -- see
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
)

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
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
  border-radius: 30px 30px 0 0;
  padding: 8px var(--velo-rail-pad-x) 22px;
}

.v-sheet__handle {
  width: 126px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 3.5px;
  background: var(--velo-glass-blue-30);
  margin: 0 auto 14px;
}

.v-sheet__title {
  font-family: var(--font-heading);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 6px 0 18px;
}

/* Opt-in (ПРОМТ №609, G11) -- see this component's own header for why
   this is a modifier, not a change to .v-sheet__title itself. */
.v-sheet__title--compact {
  font-size: var(--text-lg);
}

/* T24-25/32 (ПРОМТ №634) -- see the file header for why this is a prop-
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
  margin-top: 18px;
  border-radius: 24.5px;
  background: var(--velo-primary);
  color: var(--velo-white);
  border: 1px solid var(--velo-glass-border);
  box-shadow: var(--velo-shadow-glow);
  font-family: var(--font-body);
  font-size: var(--text-lg);
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.v-sheet__save:hover:not(:disabled) {
  background: var(--velo-primary-dark);
}

/* Mirrors VButton's own :disabled recipe (P3, ПРОМТ №592). */
.v-sheet__save:disabled {
  cursor: not-allowed;
  background: var(--velo-nav-inactive-bg);
  color: var(--velo-text-muted);
  box-shadow: none;
}

/* Cancel + save ROW (ПРОМТ №610, owner Q3) -- unitless flex-grow ratios
   (39/61, measured) so the gap is handled correctly by the browser
   instead of fighting percentage-basis-minus-gap arithmetic. */
.v-sheet__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: 18px;
}

.v-sheet__cancel {
  flex: 39 1 0%;
  height: 49px;
  border-radius: 24.5px;
  background: var(--velo-primary);
  color: var(--velo-white);
  border: 1px solid var(--velo-glass-border);
  box-shadow: var(--velo-shadow-glow);
  font-family: var(--font-body);
  font-size: var(--text-lg);
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.v-sheet__cancel:hover {
  background: var(--velo-primary-dark);
}

/* T24-37 (ПРОМТ №634, Rule 2's one owner-ruled exception -- «Добавить в
   группу»): cancel repainted coral instead of the default blue. */
.v-sheet__cancel--danger {
  background: var(--velo-error);
}

.v-sheet__cancel--danger:hover {
  background: var(--velo-error);
  opacity: 0.9;
}

/* Paired save (measured: --velo-error fill, not the lone-button's primary
   -- ReportUserSheet's «Отправить», owner-specified, not a mistake to
   "correct" back to primary). Same shape/size as the lone .v-sheet__save,
   just repainted + given its own flex-grow ratio instead of the parent
   flex-column's implicit full-width stretch. */
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

/* T24-37 (ПРОМТ №634, Rule 2's one owner-ruled exception): paired save
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

/* -- Slide-up transition (mirrors VModal) -- */
.v-sheet-enter-active,
.v-sheet-leave-active {
  transition: opacity var(--transition-base);
}

.v-sheet-enter-active .v-sheet__panel,
.v-sheet-leave-active .v-sheet__panel {
  transition: transform var(--transition-base);
}

.v-sheet-enter-from,
.v-sheet-leave-to {
  opacity: 0;
}

.v-sheet-enter-from .v-sheet__panel,
.v-sheet-leave-to .v-sheet__panel {
  transform: translateY(100%);
}
</style>
