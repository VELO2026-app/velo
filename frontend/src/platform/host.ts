/**
 * The single access point to `window` for application code: timers, rAF,
 * listeners, location, history, visualViewport. Document access goes through
 * platform/dom.ts. Rationale: the no-restricted-globals law bans
 * window/document outside platform/**, and every host access goes through
 * a seam.
 */
export const host: Window & typeof globalThis = window
