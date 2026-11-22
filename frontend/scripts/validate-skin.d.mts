// Types of scripts/validate-skin.mjs for the TypeScript side (vite.config.ts
// writes the validator's report into dist/skin/report.json, FE-230).

export interface SkinReport {
  fails: string[]
  warns: string[]
  manual: string[]
  passed: string[]
}

export function validateSkin(skinDir: string, frontendDir: string): SkinReport
export function skinBuildGate(skinDir: string, frontendDir: string): SkinReport | null
export function pngInfo(file: string): { width: number; height: number; colorType: number } | null
