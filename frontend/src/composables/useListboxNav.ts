/**
 * useListboxNav -- keyboard navigation for a search field that owns a list of
 * suggestions (the ARIA combobox pattern with `aria-activedescendant`).
 *
 * DOM focus stays in the input. ArrowDown/ArrowUp move a virtual highlight
 * through the options (wrapping), Enter picks the highlighted one. With
 * nothing highlighted, Enter is left to the caller. The input is bound with
 * `comboboxAttrs`; each option takes `optionAttrs(i)` and the list container
 * `role="listbox"` plus `:id="listId"`.
 *
 * The pattern follows the combobox handling of vercel-labs/ui (Apache-2.0,
 * https://github.com/vercel-labs/ui); this implementation is VELO's own.
 */

import {
  computed,
  nextTick,
  ref,
  useId,
  watch,
  type ComputedRef,
  type Ref,
  type WatchSource,
} from 'vue'

/** Inputs of `useListboxNav`: how many options exist and what Enter does. */
export interface ListboxNavOptions {
  /** Number of options currently rendered. */
  count: () => number
  /** Called with the highlighted option's index when Enter picks it. */
  onSelect: (index: number) => void
  /** Whether the list is currently shown (drives `aria-expanded`). */
  expanded?: () => boolean
  /**
   * A reactive source that changes whenever the option list changes (the
   * query, the filtered rows, ...). The highlight is cleared on every change,
   * so it never lands on a different row than the one the user chose.
   */
  resetOn?: WatchSource
}

/** What `useListboxNav` hands back: highlight state and the attributes to bind. */
export interface ListboxNav {
  /** Id of the list container (`role="listbox"`). */
  listId: string
  /** Index of the highlighted option, -1 when none. */
  activeIndex: Ref<number>
  /** Attributes for the input element. */
  comboboxAttrs: ComputedRef<Record<string, string | boolean | undefined>>
  /** Attributes for the list container: its id and `role="listbox"`; `labelledBy` is the id of its visible label. */
  listAttrs: (labelledBy?: string) => Record<string, string | undefined>
  /** Attributes for option `index`: id, role, `aria-selected` from `selected`, and the highlight class while it is the active one. */
  optionAttrs: (index: number, selected?: boolean) => Record<string, string | boolean>
  /** Clear the highlight (call when the list changes). */
  reset: () => void
  /**
   * Keydown handler for the input. Returns true when it consumed the key, so
   * a caller can fall back to its own Enter behavior otherwise.
   */
  onKeydown: (event: KeyboardEvent) => boolean
}

/**
 * Wires a search input and the list of options below it for keyboard
 * navigation. ArrowDown/ArrowUp move a highlight through the options and wrap
 * around, Enter picks the highlighted one, and DOM focus never leaves the
 * input (ARIA combobox with `aria-activedescendant`). Returns the attributes
 * to bind on the input, the list container and each option, plus the keydown
 * handler for the input.
 */
export function useListboxNav(options: ListboxNavOptions): ListboxNav {
  const uid = useId()
  const listId = `${uid}-list`
  const optionId = (i: number): string => `${uid}-opt-${i}`
  const activeIndex = ref(-1)

  function reset(): void {
    activeIndex.value = -1
  }

  if (options.resetOn) watch(options.resetOn, reset)

  function move(delta: 1 | -1, root: Node | null): void {
    const n = options.count()
    if (n <= 0) {
      activeIndex.value = -1
      return
    }
    const cur = activeIndex.value
    // From "nothing": Down lands on the first option, Up on the last.
    const next = cur < 0 ? (delta > 0 ? 0 : n - 1) : (cur + delta + n) % n
    activeIndex.value = next
    void nextTick(() => {
      // The field's root: the document, or the shadow root it lives in.
      if (root instanceof Document || root instanceof ShadowRoot) {
        root.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' })
      }
    })
  }

  function onKeydown(event: KeyboardEvent): boolean {
    if (event.isComposing) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.count() <= 0) return false
      event.preventDefault()
      move(
        event.key === 'ArrowDown' ? 1 : -1,
        event.target instanceof Node ? event.target.getRootNode() : null,
      )
      return true
    }
    if (event.key === 'Enter') {
      const i = activeIndex.value
      if (i < 0 || i >= options.count()) return false
      event.preventDefault()
      options.onSelect(i)
      return true
    }
    return false
  }

  const comboboxAttrs = computed(() => {
    const open = options.expanded ? options.expanded() : options.count() > 0
    const i = activeIndex.value
    return {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': open,
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && i >= 0 && i < options.count() ? optionId(i) : undefined,
    }
  })

  function listAttrs(labelledBy?: string): Record<string, string | undefined> {
    return { id: listId, role: 'listbox', 'aria-labelledby': labelledBy }
  }

  // Options are not tab stops (tabindex -1): per the WAI-ARIA combobox pattern
  // Tab leaves the field, and the arrow keys reach the options.
  function optionAttrs(index: number, selected = false): Record<string, string | boolean> {
    return {
      id: optionId(index),
      class: activeIndex.value === index ? 'velo-listbox-active' : '',
      role: 'option',
      'aria-selected': selected,
      tabindex: '-1',
    }
  }

  return { listId, activeIndex, comboboxAttrs, listAttrs, optionAttrs, reset, onKeydown }
}
