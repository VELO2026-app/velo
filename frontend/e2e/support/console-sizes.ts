/**
 * The browser windows of the console layout sweep (FE-275), in a module with
 * no imports like layout-sizes.ts: playwright.config.ts and the spec read it.
 * Kept out of layout-sizes.ts on purpose -- the CI plan job builds the phone
 * grid from the widths listed there.
 */
import type { LayoutSize } from './layout-sizes'

/**
 * A wide laptop (1440), a small one (1280), a tablet in portrait (768: the
 * menu folds to its icon rail below 1200 and the narrowest window the console
 * opens in is 744, src/utils/console/access.ts).
 */
export const CONSOLE_SIZES: readonly LayoutSize[] = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
]

export { sizeLabel } from './layout-sizes'
