/** Paths of the recorded API answers (FE-162). */
import { resolve } from 'node:path'
import type { SweepRole } from '../sweep/routes'

export const HAR_DIR = resolve(import.meta.dirname, 'har')
export const META_FILE = resolve(HAR_DIR, 'meta.json')
export const harOf = (role: SweepRole): string => resolve(HAR_DIR, `${role}.har`)

/** What meta.json holds. */
export interface HarMeta {
  /** ISO time of the recording: the browser clock stands here when replaying. */
  recordedAt: string
}
