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
}

export interface LoadedSkinPackage {
  problems: string[]
  contract: string | null
  brand: SkinBrand | null
  /** `[cssName, cssValue]` in the golden cascade order. */
  decls: Array<[string, string]>
  files: string[]
}

export const SKIN_CONTRACT_MAJOR: number
export const SKIN_CONTRACT: string
export const MANIFEST: string
export const BRAND_EXTENSION: string
export const MANDATORY_ASSETS: string[]
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
