// Types of scripts/validate-skin.mjs for the TypeScript side (vite.config.ts
// writes the validator's report into dist/skin/report.json, FE-230).

export interface SkinReport {
  fails: string[]
  warns: string[]
  manual: string[]
  passed: string[]
}

/** `veloHashes` (sha256 -> asset name) is the golden VELO list; a test passes its own. */
export function validateSkin(
  skinDir: string,
  frontendDir: string,
  veloHashes?: Map<string, string>,
): SkinReport
export function skinBuildGate(skinDir: string, frontendDir: string): SkinReport | null
export function pngInfo(file: string): { width: number; height: number; colorType: number } | null
