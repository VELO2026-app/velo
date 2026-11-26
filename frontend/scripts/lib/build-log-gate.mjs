// =============================================================================
// VELO Frontend -- build-log gate engine (FE-153)
// =============================================================================
// The `vite build` output carries warnings no other gate sees: they are not
// lint, not type errors, and the build still exits 0. FE-153 removed two
// classes of them and this engine keeps them out:
//
//   cyclic-reexport -- Rollup's CYCLIC_CROSS_CHUNK_REEXPORT: a module
//                      re-exported through a barrel that it itself (directly
//                      or not) imports, split across chunks. The chunk
//                      execution order then depends on how Rollup lays the
//                      chunks out ("will likely lead to broken execution
//                      order"). FE-153's case: ui barrel -> VTextarea ->
//                      VoiceRecordingPanel -> ui barrel.
//   html-env        -- Vite's html env pass met a VITE_-prefixed percent
//                      placeholder in index.html with no value. The passport
//                      placeholders are VELO_-spelled since FE-153 (only
//                      platform/passport-html.ts resolves them); a new
//                      VITE_ one must not sneak back in.
//
// The patterns are the message texts verbatim (re-checked in the vite 7.3.7
// and rollup 4.63.3 sources on the vite 7 upgrade, FE-157 5A.5). Re-checked
// on the move to Vite 8.3.8 / Rolldown 1.2.19 (FE-169): the html-env text is
// unchanged in the vite source. Rolldown has no cyclic-reexport warning: it
// binds a re-exported name straight to the chunk that defines it, so the
// barrel's own chunk is not on the path (checked on a fixture: a barrel
// cycle split across groups builds without a warning). The rule stays for
// a Rollup build and never fires under Rolldown. A later bundler change may
// reword the texts -- re-capture the fixtures in build-log-gate.test.mjs
// then, or this gate silently goes blind.
//
// Pure (string in, findings out) so a unit test pins it; the CLI wrapper is
// scripts/build-log-gate.mjs. Other build notices are out of scope on purpose.
// Known ones on Vite 8 (FE-169): four INEFFECTIVE_DYNAMIC_IMPORT notes --
// @pinia/colada, stores/auth.ts and composables/queries/schools.ts imported
// dynamically by router/dataPrefetch.ts (schools also by router/firstScreen.ts),
// views/auth/LoadingErrorView.vue by router/routes/public.ts, while the
// startup imports each of them statically. The import() is a lazy-load
// habit there, not a chunk boundary; Vite 7 printed the same four notes.
// =============================================================================

/** @typedef {{ rule: string, line: string }} BuildLogFinding */

const RULES = [
  {
    rule: 'cyclic-reexport',
    pattern: /was reexported through module .* while both modules are dependencies of each other/,
  },
  {
    rule: 'html-env',
    pattern: /is not defined in env variables/,
  },
]

// eslint-disable-next-line no-control-regex -- stripping ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Scan a build log; every line matching a gated warning class is a finding.
 *
 * @param {string} log - The captured `vite build` stdout+stderr.
 * @returns {BuildLogFinding[]} The findings, in log order (empty = clean).
 */
export function findBuildLogWarnings(log) {
  /** @type {BuildLogFinding[]} */
  const findings = []
  for (const raw of log.split('\n')) {
    const line = raw.replace(ANSI, '').trim()
    for (const { rule, pattern } of RULES) {
      if (pattern.test(line)) findings.push({ rule, line })
    }
  }
  return findings
}
