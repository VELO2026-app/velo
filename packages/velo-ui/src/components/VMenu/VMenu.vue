<!--
  VELO Frontend -- VMenu (kebab "..." button + popover panel)

  Reusable action menu: a round "..." trigger that toggles a popover panel of
  round icon buttons (VMenuItem). Extracted from the duplicated kebab+popover
  in EntryView (edit / delete) and DiaryFeedView (filter / search) so the
  open/close mechanics, outside-click + Esc dismissal, positioning and styling
  live in one place.

  Usage:
    <VMenu aria-label="Menu">
      <template #default="{ close }">
        <VMenuItem :icon="IconPen" aria-label="Edit"
                   @click="startEdit(); close()" />
        <VMenuItem :icon="IconTrash" aria-label="Delete"
                   @click="onDelete(); close()" />
      </template>
    </VMenu>

  The default slot receives { close } so each action can dismiss the panel
  after running. The trigger defaults to a kebab (IconDots); override it via
  the #trigger slot if a different glyph is needed. The #trigger slot receives
  { open } so a custom glyph can reflect the open/closed state (e.g. the diary
  rotates its dots when the menu opens).

  Keyboard (FE-205, the WAI-ARIA menu-button pattern): the panel is a
  role="menu" labelled by the trigger, items are role="menuitem" with
  tabindex=-1 and focus moves between them with the arrows. ArrowDown/ArrowUp
  on the trigger open the menu on the first/last item; a keyboard
  Enter/Space opens it on the first item (a pointer tap leaves focus where it
  was). Inside the panel: ArrowDown/ArrowUp wrap, Home/End jump, Escape
  closes and returns focus to the trigger, Tab closes and moves on from the
  trigger. Escape on an open menu is the menu's alone (FE-213): inside a
  VModal or VBottomSheet it closes the menu and leaves the overlay open. Focus leaving the menu for another element (Tab after a pointer
  open, screen-reader swipe navigation) closes it too.
-->
<template>
  <div ref="rootEl" class="v-menu" @focusout="onRootFocusout">
    <button
      :id="triggerId"
      ref="triggerEl"
      type="button"
      class="v-menu__trigger"
      :class="{ 'v-menu__trigger--open': open }"
      :aria-label="ariaLabel ?? t('ui.menuAria')"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-controls="open ? panelId : undefined"
      @click="onTriggerClick"
      @keydown="onTriggerKeydown"
    >
      <slot name="trigger" :open="open">
        <IconDots :size="20" />
      </slot>
    </button>

    <div
      v-if="open"
      :id="panelId"
      ref="panelEl"
      class="v-menu__panel"
      role="menu"
      aria-orientation="vertical"
      :aria-labelledby="triggerId"
      @keydown="onPanelKeydown"
    >
      <slot :close="close" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../i18n'
import { onDocumentEvent, offDocumentEvent, activeElement } from '../../platform/dom'
import { ref, onBeforeUnmount, watch, nextTick, useId } from 'vue'
import { IconDots } from '../../icons'

// The localized default resolves at RENDER time, not as a props default:
// a withDefaults evaluation runs at module load, which is BEFORE any
// configureUi({ t }) wiring (the app barrel's init) -- the raw key would be
// frozen into every instance (the VAccordion render-time pattern).
defineProps<{
  /** Accessible label for the kebab trigger. */
  ariaLabel?: string
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLButtonElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const triggerId = useId()
const panelId = useId()

function focusInPanel(): boolean {
  const focused = activeElement()
  return !!focused && !!panelEl.value?.contains(focused)
}

/** Close without touching focus (an outside tap, Tab moving on). */
function dismiss(): void {
  open.value = false
}

/** Focus the trigger without scrolling it into view (Android would jump the
 *  screen back to the trigger after a tap on an item). */
function focusTrigger(): void {
  triggerEl.value?.focus({ preventScroll: true })
}

/** Close; focus that sat on an item goes back to the trigger instead of
 *  falling to <body> when the panel unmounts. Synchronous, so an action
 *  that focuses its own target on nextTick (the diary search bar) wins. */
function close(): void {
  const restore = focusInPanel()
  dismiss()
  if (restore) focusTrigger()
}

// Focus moved to an element OUTSIDE the menu: close. A null relatedTarget
// (focus fell to <body>, e.g. a tap on a non-focusable spot, or Safari not
// focusing a tapped button) is ignored on purpose -- outside taps are the
// document pointerdown's job, and closing here would unmount the panel
// between pointerdown and click, swallowing a tap on an item or the trigger.
function onRootFocusout(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (open.value && next && !rootEl.value?.contains(next)) dismiss()
}

function menuItems(): HTMLElement[] {
  return Array.from(panelEl.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
}

/** Focus the item at `index`, wrapping both ways (-1 is the last item). */
function focusItem(index: number): void {
  const items = menuItems()
  if (items.length === 0) return
  items[(index + items.length) % items.length]?.focus()
}

async function openOn(index: number): Promise<void> {
  open.value = true
  await nextTick()
  focusItem(index)
}

// A keyboard Enter/Space on a <button> fires a click with detail 0: that
// opening lands on the first item; a pointer tap (detail >= 1) does not move
// focus.
function onTriggerClick(event: MouseEvent): void {
  if (open.value) {
    dismiss()
  } else if (event.detail === 0) {
    void openOn(0)
  } else {
    open.value = true
  }
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    void openOn(event.key === 'ArrowDown' ? 0 : -1)
  }
}

function onPanelKeydown(event: KeyboardEvent): void {
  const items = menuItems()
  const current = items.indexOf(event.target as HTMLElement)
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      focusItem(current + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      // From outside the items (current = -1) ArrowUp lands on the last one.
      focusItem(current === -1 ? -1 : current - 1)
      break
    case 'Home':
      event.preventDefault()
      focusItem(0)
      break
    case 'End':
      event.preventDefault()
      focusItem(-1)
      break
    case 'Tab':
      // Hand focus to the trigger first and let the browser's own Tab move
      // on from there: the panel is about to unmount, and moving on from a
      // removed item can send focus to the top of the document (WebKit).
      focusTrigger()
      dismiss()
      break
  }
}

// Dismiss on outside click / Esc. Listeners are attached only while open and
// removed on close or unmount so there is no leak and no global cost at rest.
function onDocPointerDown(event: PointerEvent): void {
  const root = rootEl.value
  if (root && !root.contains(event.target as Node)) dismiss()
}

// An open menu owns Escape (FE-213): VModal and VBottomSheet close on a
// document keydown too (the Escape stack, src/escapeStack.ts), bound when
// the overlay opens -- before this menu opens -- so a bubble-phase
// stopPropagation here would run too late. The listener sits in the CAPTURE
// phase, which reaches the document before the key goes down to its target
// and back up, and stops the event there: one press closes the menu and
// leaves the overlay under it open.
function onDocKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  event.stopPropagation()
  close()
}

watch(open, (isOpen) => {
  if (isOpen) {
    onDocumentEvent('pointerdown', onDocPointerDown)
    onDocumentEvent('keydown', onDocKeydown, true)
  } else {
    offDocumentEvent('pointerdown', onDocPointerDown)
    offDocumentEvent('keydown', onDocKeydown, true)
  }
})

onBeforeUnmount(() => {
  offDocumentEvent('pointerdown', onDocPointerDown)
  offDocumentEvent('keydown', onDocKeydown, true)
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
