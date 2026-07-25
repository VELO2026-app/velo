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
-->

<template>
  <Teleport to="body">
    <Transition name="v-sheet">
      <div v-if="open" class="v-sheet__overlay" @click.self="onOverlay">
        <div class="v-sheet__panel velo-kbd-scroll" role="dialog" aria-modal="true">
          <div class="v-sheet__handle" aria-hidden="true" />
          <h2 v-if="title" class="v-sheet__title">{{ title }}</h2>
          <div class="v-sheet__body">
            <slot />
          </div>
          <button
            v-if="saveLabel"
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
  }>(),
  {
    title: '',
    saveLabel: '',
    saveDisabled: false,
    closeOnOverlay: true,
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
