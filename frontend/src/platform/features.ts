// =============================================================================
// VELO Frontend -- Feature Registry (tz-whitelabel §4, F3; variant "a")
// =============================================================================
//
// The ONE source of the module namespace list. Two consumption shapes, one
// semantics:
//
//   BUILD-TIME literals -- vite.config.ts materializes a __VELO_FEATURE_*__
//   define per module. Route gates in router/index.ts read those literals
//   DIRECTLY (never through this module): a literal `false` folds the gate,
//   Rollup tree-shakes the branch together with its dynamic imports, and the
//   disabled module's chunks are physically absent from dist/ -- the F5
//   grep test ("no chunks of a disabled module in dist/") depends on it.
//
//   RUNTIME accessor -- featureEnabled() for consumers with no chunks to cut
//   (tab-bar filters). Under the machine (FE-130) it reads the
//   __VELO_FEATURE_FLAGS__ define -- the SAME resolved set the literals came
//   from, or a tab bar would answer "golden" while the routes are cut.
//   vitest.config pins the defines away; the accessor then falls back to the
//   VITE_FEATURES parse, which keeps vi.stubEnv working with no build step.
//
// INPUT CHANNELS (FE-130, contract 3 rules 11/19 -- the edition is a project
// property, not an instance value): the machine's PRIMER_EDITION resolves
// through editions.json at the repo root (the ONE «edition → modules» table,
// shared with the backend -- BE-182); VITE_FEATURES stays the local-dev
// channel; neither -- the golden all-on set.
//
// instance.ts's FeatureSet stays the passport's diagnostic view; THIS module
// owns the namespace list (pure, node-safe: vite.config.ts imports it).
// =============================================================================

/** Modules an instance edition may switch off (tz-whitelabel §4). Since
 *  10.11 velo has one edition, `ai`; `payments` left this list for the
 *  instance options (FE-151, platform/instance.ts isOptionEnabled) -- its
 *  code is always in the bundle, the flag arrives at container start. Adding a
 *  name: add the define in vite.config.ts, the declare in env.d.ts, and gate
 *  the module's routes. RENAMING or REMOVING a name is a coordinated
 *  skin+app release -- the same generation rule the token contract uses
 *  (tz-whitelabel §3.1), applied to the feature namespace. */
export const FEATURE_NAMES = ['ai'] as const

/** A module an instance edition may switch off ('ai'). */
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

// =============================================================================
// The edition channel (FE-130): PRIMER_EDITION -> editions.json. The table is
// the product's own "edition -> modules" artifact (contract 3 rule 11: the
// machine never sees inside the image -- it checks edition membership and
// the frontend checks the module list here); the backend reads the same file
// (BE-182). Module names outside FEATURE_NAMES are ignored: the backend's
// edition module list is a superset of the frontend's switchable namespaces.
// =============================================================================

/** Shape of editions.json at the repo root (schema mirrors primer-package
 *  conventions; `modules` -- switchable namespaces the edition turns on). */
export interface EditionTable {
  schema: number
  editions: Record<string, { modules: string[] }>
}

/** Flags from the machine's channel. An unknown edition is a repo/passport
 *  desync -- the build must be red, never silently golden (the machine
 *  checks membership before building; this is the defense in depth). */
export function editionFlags(edition: string, table: EditionTable): Record<FeatureName, boolean> {
  const entry = table.editions[edition]
  if (!entry) {
    throw new Error(
      `FE-130: PRIMER_EDITION "${edition}" is not in editions.json ` +
        `(known: ${Object.keys(table.editions).sort().join(', ')})`,
    )
  }
  const enabled = new Set(entry.modules)
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, enabled.has(name)])) as Record<
    FeatureName,
    boolean
  >
}

/** The transition resolver (FE-130 item 3): the machine's edition channel
 *  wins; VITE_FEATURES stays the local-dev channel; neither -- the golden
 *  all-on set. */
export function resolveFeatureFlags(
  edition: string | undefined,
  viteFeatures: string | undefined,
  table: EditionTable,
): Record<FeatureName, boolean> {
  const trimmed = edition?.trim()
  if (trimmed) return editionFlags(trimmed, table)
  return featureFlags(viteFeatures)
}

/** Runtime check for NON-chunk consumers (shell tab filters). Route gates
 *  must NOT route through this -- they read the __VELO_FEATURE_*__ literals
 *  directly so DCE can cut the module. */
export function featureEnabled(name: FeatureName): boolean {
  // Build-materialized flags (FE-130): the resolved set of THIS build, so a
  // runtime accessor follows the edition even though VITE_FEATURES is gone.
  // vitest.config pins the defines away -- the typeof guard then falls back
  // to the VITE_FEATURES parse (stub-able in tests).
  if (typeof __VELO_FEATURE_FLAGS__ !== 'undefined') {
    const flags = JSON.parse(__VELO_FEATURE_FLAGS__) as Record<FeatureName, boolean>
    return flags[name] ?? true
  }
  return featureFlags(import.meta.env.VITE_FEATURES)[name]
}

/** Per-module define map (route-gate literals for DCE). Values are
 *  pre-stringified as vite `define` requires. */
export function flagsToDefines(flags: Record<FeatureName, boolean>): Record<string, string> {
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [
      `__VELO_FEATURE_${name.replace(/-/g, '_').toUpperCase()}__`,
      JSON.stringify(flags[name]),
    ]),
  )
}

/** The `define` map vitest.config materializes: per-module literals pinned to
 *  the golden all-on set (the same philosophy as the golden brand stub) --
 *  NO flags JSON, so featureEnabled's typeof guard falls back to the
 *  VITE_FEATURES parse in tests. */
export function featureDefines(value: string | undefined): Record<string, string> {
  return flagsToDefines(featureFlags(value))
}

/** The `define` map vite.config materializes (FE-130): per-module literals
 *  PLUS the resolved set as JSON for featureEnabled() -- one source for both
 *  consumption shapes, so a runtime accessor can never disagree with the cut
 *  chunks. */
export function featureDefineMap(flags: Record<FeatureName, boolean>): Record<string, string> {
  return {
    ...flagsToDefines(flags),
    // Stringified TWICE: vite `define` pastes the value in as an EXPRESSION,
    // so a single stringify lands as an object literal and featureEnabled()'s
    // JSON.parse throws ("[object Object]" is not valid JSON). The outer
    // stringify makes the pasted expression a string literal holding the JSON.
    __VELO_FEATURE_FLAGS__: JSON.stringify(JSON.stringify(flags)),
  }
}
