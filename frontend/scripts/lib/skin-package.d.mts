// Types of scripts/lib/skin-package.mjs for the TypeScript side
// (src/platform/skin.ts, read by vite.config.ts). The module is plain ESM so
// the Node scripts load it without a build step.

export interface SkinFont {
  family: string
  /** Package-relative path, `assets/fonts/<name>.woff2`. */
  file: string
  weight: number | string
  style: 'normal' | 'italic'
}

export interface SkinBrand {
  displayName: string
  shortName: string
  themeColor: string
  backgroundColor: string
  fonts: SkinFont[]
  /** Contract 2.1: pairs the package keeps under the contrast floor. */
  contrastExceptions: SkinContrastException[]
  /** Contract 2.2: the brand's support address; null = the record has none. */
  supportEmail: string | null
  /** Contract 2.2: what the support conversation's mark shows; null = the
   *  record has none (the reader's default is the logo set). */
  supportMark: SupportMark | null
}

export type SupportMark = 'logo' | 'icon'

export interface SkinContrastException {
  /** Token path of the text, e.g. `velo.text.secondary`. */
  text: string
  /** Token path of the surface under it, e.g. `velo.bg.card.solid`. */
  surface: string
  reason: string
}

/** One node of a mood icon tree (contract 2.3): the closed SVG vocabulary of
 *  `parseMoodSvg`. The root is the `svg`, its attrs the viewBox and fill. */
export interface MoodSvgNode {
  tag: string
  attrs?: Record<string, string>
  children?: MoodSvgNode[]
}

/** The five mood keys, worst to best (utils/moodScale.ts MoodScaleKey). */
export type MoodKey = 'bad' | 'low' | 'neutral' | 'good' | 'fire'

/** The mood icon set of a package: the five trees. */
export type MoodIconSet = Record<MoodKey, MoodSvgNode>

export interface LoadedSkinPackage {
  problems: string[]
  contract: string | null
  brand: SkinBrand | null
  /** `[cssName, cssValue]` in the golden cascade order. */
  decls: Array<[string, string]>
  files: string[]
  /** Contract 2.3: the package's mood icons; null = it ships none. */
  moodIcons: MoodIconSet | null
  /** The weight of headings and buttons: `--velo-fw-heading` resolved over the
   *  package's overrides (FE-278); null = it comes to no number. */
  headingWeight: number | null
}

export const SKIN_CONTRACT_MAJOR: number
export const SKIN_CONTRACT: string
export const CORE_DISPLAY_NAME: string
export const CORE_THEME_COLOR: string
export const MANIFEST: string
export const BRAND_EXTENSION: string
export const SUPPORT_MARKS: SupportMark[]
export const MANDATORY_ASSETS: string[]
export const LOGO_ASSETS: string[]
export const SKIN_ASSETS: string[]
export const PRECACHED_ICONS: string[]
export function shipsLogo(files: string[]): boolean
export const MOOD_KEYS: MoodKey[]
export function shipsMoodIcons(files: string[]): boolean
export function parseMoodSvg(text: string): { tree: MoodSvgNode } | { error: string }
export const ASSET_DIRS: string[]
export const IGNORED_FILES: Set<string>
export function goldenTokenMap(
  tokensDoc: unknown,
): Map<string, { cssName: string; order: number; value: string }>
export function readGoldenTokens(frontendDir: string): unknown
export function skinnable(path: string): boolean
export function parseManifest(text: string): { fields?: Record<string, string>; error?: string }
export function loadSkinPackage(dir: string, tokensDoc: unknown): LoadedSkinPackage
export function isSkinPackage(dir: string): boolean
export function skinCss(pkg: LoadedSkinPackage, urlBase?: string): string
