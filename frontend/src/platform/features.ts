// =============================================================================
// VELO Frontend -- Feature Registry (tz-whitelabel §4, F3; variant «а»)
// =============================================================================
//
// The ONE source of the module namespace list. Two consumption shapes, one
// semantics:
//
//   BUILD-TIME literals -- vite.config.ts materializes a __VELO_FEATURE_*__
//   define per module from VITE_FEATURES. Route gates in router/index.ts read
//   those literals DIRECTLY (never through this module): a literal `false`
//   folds the gate, Rollup tree-shakes the branch together with its dynamic
//   imports, and the disabled module's chunks are physically absent from
//   dist/ -- the F5 grep-test «чанков выключенного модуля нет» depends on it.
//
//   RUNTIME accessor -- featureEnabled() for consumers with no chunks to cut
//   (tab-bar filters). It re-parses import.meta.env per call: trivially cheap,
//   and vi.stubEnv keeps working in tests with no build step involved.
//
// instance.ts's FeatureSet stays the passport's diagnostic view; THIS module
// owns the namespace list (pure, node-safe: vite.config.ts imports it).
// =============================================================================

/** Modules an instance edition may switch off (tz-whitelabel §4). Adding a
 *  name: add the define in vite.config.ts, the declare in env.d.ts, and gate
 *  the module's routes. RENAMING or REMOVING a name is a coordinated
 *  skin+app release -- the same generation rule the token contract uses
 *  (tz-whitelabel §3.1), applied to the feature namespace. */
export const FEATURE_NAMES = ['ai', 'payments'] as const

export type FeatureName = (typeof FEATURE_NAMES)[number]

/** VITE_FEATURES semantics (mirrors instance.ts parseFeatures): absent, empty
 *  or 'full' turns everything on; otherwise a comma list -- a module is on
 *  only when NAMED. Unknown names are ignored: they can never match a module
 *  id, so they must never enable one. */
export function featureFlags(value: string | undefined): Record<FeatureName, boolean> {
  const raw = (value ?? 'full').trim()
  const named = raw === '' || raw === 'full' ? null : new Set(raw.split(',').map((s) => s.trim()))
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, named === null || named.has(name)]),
  ) as Record<FeatureName, boolean>
}

/** Runtime check for NON-chunk consumers (shell tab filters). Route gates
 *  must NOT route through this -- they read the __VELO_FEATURE_*__ literals
 *  directly so DCE can cut the module. */
export function featureEnabled(name: FeatureName): boolean {
  return featureFlags(import.meta.env.VITE_FEATURES)[name]
}

/** The `define` map both Vite configs materialize: vite.config from the
 *  passport env; vitest.config pinned to `undefined` -- the golden all-on
 *  set, the same philosophy as the golden brand stub. Values are
 *  pre-stringified as vite `define` requires. */
export function featureDefines(value: string | undefined): Record<string, string> {
  const flags = featureFlags(value)
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [
      `__VELO_FEATURE_${name.replace(/-/g, '_').toUpperCase()}__`,
      JSON.stringify(flags[name]),
    ]),
  )
}
