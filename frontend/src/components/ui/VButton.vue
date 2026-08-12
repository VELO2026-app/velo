<!--
  VELO Frontend -- VButton Component (Phase F2.1)

  Primary action element. VELΘ pill-shaped glass design.

  Variants: primary | secondary | danger | ghost | outline (alias -> secondary)
  Sizes:    sm | md (default) | lg (alias -> md)
  States:   disabled, loading (shows spinner + prevents clicks)

  Usage:
    <VButton variant="primary" @click="save">Save</VButton>
    <VButton variant="danger" size="sm" :loading="saving">Delete</VButton>
    <VButton block>Full width</VButton>
-->

<template>
  <button
    :class="[
      'v-btn',
      `v-btn--${normalizedVariant}`,
      `v-btn--${normalizedSize}`,
      {
        'v-btn--block': block,
        'v-btn--loading': loading,
      },
    ]"
    :disabled="disabled || loading"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" class="v-btn__spinner" />
    <span :class="{ 'v-btn__content--hidden': loading }">
      <slot />
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline'
    size?: 'sm' | 'md' | 'lg'
    block?: boolean
    disabled?: boolean
    loading?: boolean
  }>(),
  {
    variant: 'primary',
    size: 'md',
    block: false,
    disabled: false,
    loading: false,
  },
)

defineEmits<{
  click: [event: MouseEvent]
}>()

const normalizedVariant = computed(() =>
  props.variant === 'outline' ? 'secondary' : props.variant,
)
const normalizedSize = computed(() => (props.size === 'lg' ? 'md' : props.size))
</script>

<style scoped>
.v-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-family: var(--font-body);
  /* Button labels a touch heavier (operator 2026-06-17). Marmelad is single-
     weight (400), so 600 is the lightest step the browser synthesizes heavier. */
  font-weight: 600;
  border: 1px solid var(--velo-glass-border);
  cursor: pointer;
  transition: all var(--transition-base);
  text-decoration: none;
  position: relative;
  white-space: nowrap;
  border-radius: var(--radius-full);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
}

/* -- Sizes -- */
.v-btn--sm {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-xs);
  /* 44px touch-target bar (PROMPT №679); reuses the existing --velo-size-44
     token rather than a raw px, sitting between VInput's 40px affix height
     and .v-btn--md's 50px, inside the app's existing size range. */
  min-height: var(--velo-size-44);
}

.v-btn--md {
  padding: 12px 24px;
  font-size: var(--text-sm);
  min-height: var(--velo-size-50);
}

/* -- Variants -- */
.v-btn--primary {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.v-btn--secondary {
  background: var(--velo-glass-blue-60);
  color: var(--velo-text-primary);
}

.v-btn--danger {
  background: var(--velo-pink-300);
  color: var(--velo-white);
}

.v-btn--ghost {
  background: var(--velo-glass-white-01);
  color: var(--velo-text-primary);
}

/* Hover fills only on real pointer devices: on touch (Telegram WebView) :hover
   sticks after a tap and leaves the button looking "filled" — most visible on the
   ghost «Показать ещё» (operator PROMPT №162). Desktop hover unchanged. */
@media (hover: hover) {
  .v-btn--primary:hover:not(:disabled) {
    background: var(--velo-primary-dark);
  }

  .v-btn--secondary:hover:not(:disabled) {
    background: var(--velo-glass-blue-15);
  }

  .v-btn--danger:hover:not(:disabled) {
    background: var(--velo-error);
  }

  .v-btn--ghost:hover:not(:disabled) {
    background: var(--velo-glass-blue-15);
  }
}

/* -- Modifiers -- */
.v-btn--block {
  width: 100%;
}

.v-btn:disabled {
  cursor: not-allowed;
}

/* Disabled (non-loading): one clear neutral state for EVERY variant — muted
   glass fill + muted text, flat (no glow / no blur). Replaces the old
   opacity:0.5 that just washed the variant colour and read as "broken".
   DS-wide: applies to all VButton usages. Loading keeps its variant colour +
   spinner (excluded via :not(.v-btn--loading)). */
.v-btn:disabled:not(.v-btn--loading) {
  background: var(--velo-nav-inactive-bg);
  color: var(--velo-text-muted);
  border-color: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* -- Loading -- */
.v-btn--loading {
  cursor: wait;
}

.v-btn__content--hidden {
  visibility: hidden;
}

.v-btn__spinner {
  position: absolute;
  width: 18px;
  height: 18px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: var(--radius-full);
  animation: v-btn-spin 0.6s linear infinite;
}

@keyframes v-btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
