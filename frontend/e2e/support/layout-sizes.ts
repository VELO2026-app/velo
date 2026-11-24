/**
 * The screen sizes of the layout sweep (FE-240), in a module with no imports:
 * playwright.config.ts builds one project per size from it, and the
 * detector's checks read it too.
 */

/** A screen size the layout detector judges a screen at. */
export interface LayoutSize {
  width: number
  height: number
}

/**
 * The three sizes: the common phone (iPhone 12-16) first, a narrow one
 * (iPhone SE 1st gen, small Android), a wide one (iPhone Pro Max). Each is a
 * project of its own: the screen LOADS at its size, as on such a phone --
 * a resize of an open page reads as an opening keyboard to the app
 * (src/composables/useViewportGeometry.ts) and keeps the heights it froze at
 * mount.
 */
export const LAYOUT_SIZES: readonly LayoutSize[] = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 430, height: 932 },
]

/** `390x844`. */
export function sizeLabel(size: LayoutSize): string {
  return `${size.width}x${size.height}`
}
