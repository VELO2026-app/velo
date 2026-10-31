<!--
  VELO Frontend -- VModal Component (Phase F4.1)

  Reusable modal dialog with overlay, close on Escape/overlay click,
  enter/leave transitions. Content via default slot.

  Centered DIALOG at every width, over a frosted scrim (owner ask 2026-09-30:
  «попапы по центру экрана и немного блюрить задний фон»). Form-style sheets
  that dock to the bottom remain VBottomSheet's job -- the two components
  split the DS: VModal = dialog, VBottomSheet = sheet.

  Used by: BookingPopup, CancelBookingPopup, VConfirmDialog, SendMessageModal,
  the FE-87 role popup, and the filter modals.

  Usage:
    <VModal :open="showModal" @close="showModal = false">
      <h2>Title</h2>
      <p>Content</p>
    </VModal>
-->

<template>
  <Teleport to="body">
    <!-- The frosted scrim is its OWN layer, faded on itself: an opacity
         animation on an ANCESTOR of a backdrop-filter makes WebKit drop the
         blur until the fade ends (it pops in). The dialog layer above it is
         transparent, so it can fade/scale freely. -->
    <Transition name="v-modal-scrim">
      <div v-if="open" class="v-modal__scrim" aria-hidden="true" />
    </Transition>
    <Transition name="v-modal">
      <div v-if="open" class="v-modal__overlay" @click.self="onOverlayClick">
        <div class="v-modal__container" role="dialog" aria-modal="true">
          <button
            v-if="showClose"
            class="v-modal__close"
            :aria-label="t('ui.close')"
            @click="$emit('close')"
          >
            <IconClose :size="16" />
          </button>
          <div class="v-modal__scroll velo-kbd-scroll">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { onDocumentEvent, offDocumentEvent } from '@/platform/dom'
import { onMounted, onUnmounted, watch, onDeactivated } from 'vue'
import { IconClose } from '@/components/icons'
import { lockBodyScroll, unlockBodyScroll } from '@/composables/useBodyScrollLock'

const props = withDefaults(
  defineProps<{
    open: boolean
    closeOnOverlay?: boolean
    showClose?: boolean
  }>(),
  {
    closeOnOverlay: true,
    showClose: true,
  },
)

const emit = defineEmits<{
  close: []
}>()

// Its screen kept alive off-stage (TabRouterView, a dock tap while open):
// an overlay must not stay over the next screen -- close it like a dismiss.
onDeactivated(() => {
  if (props.open) emit('close')
})

function onOverlayClick(): void {
  if (props.closeOnOverlay) {
    emit('close')
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) {
    emit('close')
  }
}

// Lock body scroll when modal is open. Ref-counted (W16, PROMPT №409) so a
// second overlay (e.g. a VBottomSheet opened from inside this modal) closing
// first doesn't unlock the body while this one is still open. `locked` tracks
// whether THIS instance currently holds the lock, so lock/unlock stay paired
// 1:1 even if unmounted mid-open.
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

onMounted(() => {
  onDocumentEvent('keydown', onKeydown)
})

onUnmounted(() => {
  offDocumentEvent('keydown', onKeydown)
  // Ensure the lock is released if the component unmounts while open.
  if (locked) {
    locked = false
    unlockBodyScroll()
  }
})
</script>

<style scoped>
.v-modal__scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--velo-scrim);
  /* Light frosted glass over the page (owner ask 2026-09-30, «немного
     блюрить»). -webkit- prefix for the Telegram webviews; a browser without
     backdrop-filter simply keeps the plain scrim. */
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.v-modal__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  /* Centered at EVERY width (owner ask 2026-09-30) -- the bottom-sheet
     posture moved entirely to VBottomSheet. */
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}

.v-modal__container {
  position: relative;
  width: 100%;
  max-width: 420px;
  max-height: 85vh;
  /* Clip the scrollbar to the rounded corners so it never pokes above the
     sheet. The actual scrolling happens on .v-modal__scroll inside. */
  overflow: hidden;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  /* Плавающая шторка (overlay даёт отступ со всех сторон) -> скругляем ВСЕ
     углы. Радиус из DS-токена (--radius-md=15), а не сырой 20px. */
  border-radius: var(--radius-md);
  /* box-shadow: var(--shadow-xl) removed PROMPT №437 (operator ruling: VELO is
     flat). --shadow-xl was `none`, so this asked for a shadow and got nothing --
     a leftover from before the flat decision. Removing it renders identically.
     The modal is separated by its white rim + the scrim behind it. */
}

/* Inner scroll area: holds the padding and owns the vertical scroll, so the
   scrollbar stays within the container's rounded clip. */
.v-modal__scroll {
  max-height: 85vh;
  overflow-y: auto;
  padding: var(--space-5);
}

.v-modal__close {
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
  z-index: 1;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--velo-bg-subtle);
  border-radius: var(--radius-full);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

/* [FE-26] 44px touch-target bar: the × stays 32x32 visually (the modal
   header is deliberately tight); the tappable zone becomes 44x44 via an
   invisible overlay. The overlay is transparent, so it rides over the
   modal's own padding harmlessly. */
.v-modal__close::after {
  content: '';
  position: absolute;
  inset: -6px;
}

.v-modal__close:hover {
  background: var(--velo-border);
  color: var(--velo-text-primary);
}

/* -- Transitions --
   A centred dialog rises a little and settles; it leaves faster and travels
   less than it arrived. transform/opacity only. */
.v-modal-scrim-enter-active {
  transition: opacity var(--velo-dur-sheet) var(--velo-ease-out);
}

.v-modal-scrim-leave-active {
  transition: opacity var(--velo-dur-sheet-exit) var(--velo-ease-in);
}

.v-modal-scrim-enter-from,
.v-modal-scrim-leave-to {
  opacity: 0;
}

.v-modal-enter-active {
  transition:
    opacity var(--velo-dur-sheet) var(--velo-ease-out),
    transform var(--velo-dur-sheet) var(--velo-ease-out);
}

.v-modal-leave-active {
  transition:
    opacity var(--velo-dur-sheet-exit) var(--velo-ease-in),
    transform var(--velo-dur-sheet-exit) var(--velo-ease-in);
}

.v-modal-enter-from {
  opacity: 0;
  transform: translateY(12px) scale(0.985);
}

.v-modal-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.99);
}
</style>
