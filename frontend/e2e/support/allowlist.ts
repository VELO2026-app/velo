/**
 * Suite-wide crash-detector exceptions (FE-161). A signal is a bug until
 * proven otherwise. An entry needs a `reason` that names the known defect or
 * the ticket that tracks it, and is as narrow as the case: an exact text, the
 * engine it comes from (`browsers`, FE-188). Prefer a per-test
 * `crashes.allow(...)` over a global entry.
 */
import type { CrashAllowance } from './crashes'

export const GLOBAL_ALLOWLIST: CrashAllowance[] = [
  {
    reason:
      'FE-188: WebKit does not know the viewport key interactive-widget of frontend/index.html:18 ' +
      'and says so as a console error on every page. The key stays: Chrome on Android needs ' +
      'interactive-widget=resizes-visual so the on-screen keyboard resizes the visual viewport, ' +
      'not the layout. Only this exact text, only in WebKit.',
    browsers: ['webkit'],
    console: [/^Viewport argument key "interactive-widget" not recognized and ignored\.$/],
  },
]
