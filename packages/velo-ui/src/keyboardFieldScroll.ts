// =============================================================================
// @velo/ui -- the keyboard field-scroll seam (FE-143, tz-ui-package.md §4 P5)
// =============================================================================
//
// The kit's field components (VInput/VTextarea, P6) bind an @focus handler
// that scrolls the focused field clear of the soft keyboard AFTER it
// settles. The IMPLEMENTATION is host machinery -- the VELO app's version
// reads window.visualViewport through its own platform seam and debounces
// the keyboard's resize frames -- and it stays in the host: a kit must not
// carry platform opinions. Inversion of control, the useToast pattern
// (FE-141): the host provides a factory under
// KEYBOARD_FIELD_SCROLL_INJECTION_KEY once at its root (the app:
// provideKeyboardFieldScroll() in App.vue); every consumer -- kit field or
// host view -- resolves it through useKeyboardFieldScroll().
//
// Contract:
//   - A FACTORY is provided, not an instance: each consumer calls it inside
//     its own setup(), so the host implementation can register per-consumer
//     lifecycle cleanup. The app's real one reaps its visualViewport
//     listener on the OWNING component's unmount -- the exact leak its unit
//     tests pin; one shared root instance would re-introduce it.
//   - The default is a NO-OP: a host that provides nothing (Storybook, a
//     standalone test mount) simply gets no keyboard-aware scrolling.
//     Silent by design, unlike the i18n seam's warn (FE-118): a missing
//     scroll nudge degrades invisibly, a raw i18n key ships broken copy.
// =============================================================================

import { inject, type InjectionKey } from 'vue'

/**
 * The per-field focus surface a host provides: bind onFieldFocus as @focus
 * on a text field so the soft keyboard cannot cover it.
 */
export interface KeyboardFieldScrollApi {
  onFieldFocus: (e: FocusEvent) => void
}

/**
 * What the host provides: a factory the consumer runs in its own setup().
 * Not a shared instance -- see the banner for the per-consumer cleanup
 * reason.
 */
export type KeyboardFieldScrollFactory = () => KeyboardFieldScrollApi

/**
 * FE-143: the injection key -- the host root provides the factory, kit
 * fields and host views inject it via useKeyboardFieldScroll().
 */
export const KEYBOARD_FIELD_SCROLL_INJECTION_KEY: InjectionKey<KeyboardFieldScrollFactory> =
  Symbol('keyboardFieldScroll')

const NO_OP_FIELD_SCROLL: KeyboardFieldScrollApi = { onFieldFocus: () => undefined }

/**
 * Resolve the host's keyboard field-scroll handler, or the no-op default
 * when the host provides none. Call inside a component setup().
 */
export function useKeyboardFieldScroll(): KeyboardFieldScrollApi {
  const create = inject(KEYBOARD_FIELD_SCROLL_INJECTION_KEY, null)
  return create ? create() : NO_OP_FIELD_SCROLL
}
