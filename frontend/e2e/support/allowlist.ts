/**
 * Suite-wide crash-detector exceptions (FE-161). Empty on purpose: a signal
 * is a bug until proven otherwise. An entry needs a `reason` that names the
 * known defect or the ticket that tracks it; prefer a per-test
 * `crashes.allow(...)` over a global entry.
 */
import type { CrashAllowance } from './crashes'

export const GLOBAL_ALLOWLIST: CrashAllowance[] = []
