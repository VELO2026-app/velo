<!--
  VELO Frontend -- VMenu (kebab "..." button + popover panel)

  Reusable action menu: a round "..." trigger that toggles a popover panel of
  round icon buttons (VMenuItem). Extracted from the duplicated kebab+popover
  in EntryView (edit / delete) and DiaryFeedView (filter / search) so the
  open/close mechanics, outside-click + Esc dismissal, positioning and styling
  live in one place.

  Usage:
    <VMenu aria-label="Меню">
      <template #default="{ close }">
        <VMenuItem :icon="IconPen" aria-label="Редактировать"
                   @click="startEdit(); close()" />
        <VMenuItem :icon="IconTrash" aria-label="Удалить"
                   @click="onDelete(); close()" />
      </template>
    </VMenu>

  The default slot receives { close } so each action can dismiss the panel
  after running. The trigger defaults to a kebab (IconDots); override it via
  the #trigger slot if a different glyph is needed. The #trigger slot receives
  { open } so a custom glyph can reflect the open/closed state (e.g. the diary
  rotates its dots when the menu opens).
-->
<template>
  <div ref="rootEl" class="v-menu">
    <button
      type="button"
      class="v-menu__trigger"
      :class="{ 'v-menu__trigger--open': open }"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
    >
      <slot name="trigger" :open="open">
        <IconDots :size="20" />
      </slot>
    </button>

    <div v-if="open" class="v-menu__panel" role="menu">
      <slot :close="close" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onDocumentEvent, offDocumentEvent } from '@/platform/dom'
import { ref, onBeforeUnmount, watch } from 'vue'
import { IconDots } from '@/components/icons'

withDefaults(
  defineProps<{
    /** Accessible label for the kebab trigger. */
    ariaLabel?: string
  }>(),
  { ariaLabel: 'Меню' },
)

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function close(): void {
  open.value = false
}

function toggle(): void {
  open.value = !open.value
}

// Dismiss on outside click / Esc. Listeners are attached only while open and
// removed on close or unmount so there is no leak and no global cost at rest.
function onDocPointerDown(event: PointerEvent): void {
  const root = rootEl.value
  if (root && !root.contains(event.target as Node)) close()
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

watch(open, (isOpen) => {
  if (isOpen) {
    onDocumentEvent('pointerdown', onDocPointerDown)
    onDocumentEvent('keydown', onDocKeydown)
  } else {
    offDocumentEvent('pointerdown', onDocPointerDown)
    offDocumentEvent('keydown', onDocKeydown)
  }
})

onBeforeUnmount(() => {
  offDocumentEvent('pointerdown', onDocPointerDown)
  offDocumentEvent('keydown', onDocKeydown)
})

// Allow the parent to close the menu programmatically if needed.
defineExpose({ close })
</script>

<style scoped>
.v-menu {
  position: relative;
  flex-shrink: 0;
}

.v-menu__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-nav-active-bg);
  color: var(--velo-white);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.v-menu__trigger:hover,
.v-menu__trigger--open {
  opacity: 0.85;
}

/* Popover: a vertical column of round icon buttons below the trigger. */
.v-menu__panel {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  z-index: var(--z-sticky);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
