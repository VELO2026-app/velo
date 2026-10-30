<!--
  VELO Frontend -- VToast Component (Phase F2.1)

  Renders active toasts. Mount once in App.vue.
  Matches mockup .toast styles: fixed bottom, slide up, auto-dismiss.

  Usage (in App.vue):
    <VToast />
-->

<template>
  <Teleport to="body">
    <TransitionGroup name="v-toast" tag="div" class="v-toast-container">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="v-toast"
        :class="`v-toast--${toast.variant}`"
        @click="dismiss(toast.id)"
      >
        <span class="v-toast__message">{{ toast.message }}</span>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<style scoped>
.v-toast-container {
  position: fixed;
  bottom: 80px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  z-index: var(--z-toast);
  pointer-events: none;
}

.v-toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 12px 24px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  max-width: 90%;
  text-align: center;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: var(--velo-shadow-toast);
}

.v-toast--success {
  background: var(--velo-success);
  color: var(--velo-white);
}

.v-toast--error {
  background: var(--velo-error);
  color: var(--velo-white);
}

.v-toast--info {
  background: var(--velo-text-primary);
  color: var(--velo-white);
}

/* -- Transition --
   transform + opacity only; arrive slower than leave. The leaving toast is
   taken out of flow so its neighbour glides (-move) instead of jumping. */
.v-toast-enter-active {
  transition:
    transform var(--velo-dur-sheet) var(--velo-ease-out),
    opacity var(--velo-dur-sheet) var(--velo-ease-out);
}

.v-toast-leave-active {
  position: absolute;
  transition:
    transform var(--velo-dur-sheet-exit) var(--velo-ease-in),
    opacity var(--velo-dur-sheet-exit) var(--velo-ease-in);
}

.v-toast-move {
  transition: transform var(--transition-base);
}

.v-toast-enter-from {
  transform: translateY(16px);
  opacity: 0;
}

.v-toast-leave-to {
  transform: translateY(-8px);
  opacity: 0;
}
</style>
