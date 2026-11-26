// =============================================================================
// VELO Frontend -- the startup `app` chunk under Rolldown (FE-169)
// =============================================================================
//
// main.ts imports app.ts DYNAMICALLY (after prepareHost()). Rollup put the
// whole static closure of app.ts into one `app` chunk: a module that app.ts
// already loaded was "already loaded" for the lazy screens too. Rolldown
// (Vite 8) splits every module that app.ts shares with a lazy screen into its
// own common chunk instead -- about 50 small files on the first open, all of
// them in the service worker precache. This module gives vite.config.ts a
// code-splitting group that puts the startup closure back into ONE chunk.
//
// The closure follows what is USED, not what a barrel re-exports. The kit
// barrel (`@velo/ui`) and the icon barrels re-export every component; a
// plain walk over the import graph pulls all of them into `app`, the ones
// only lazy screens use included. Here a re-export is followed only when an
// importer asks for its name. The parse reads the transformed module code;
// an import it cannot map to a module id falls back to the whole module, so
// a parse gap makes `app` larger, never a startup module missing from it.
// Chunk placement only: the output is correct for any group content.
// Kept out of the config file so the unit suite can pin it.
// =============================================================================

/** The slice of Rolldown's ModuleInfo this module reads. */
export interface GraphModule {
  /** Transformed source code; null for an external module. */
  code: string | null
  /** Resolved ids of the static imports and re-exports. */
  importedIds: readonly string[]
}

/** Rolldown's ChunkingContext.getModuleInfo, narrowed to GraphModule. */
export type ModuleLookup = (id: string) => GraphModule | null

/** Every export of a module is used (`import * as`, an unmapped import). */
const ALL = '*'

/** Names one statement asks of its source module. */
type Names = ReadonlySet<string>

interface Edge {
  spec: string
  /** Names the importer uses: imports ALWAYS count, re-exports on demand. */
  names: Names
  /** For `export ... from`: the exported name, mapped to the name asked of the source. */
  reexports: ReadonlyMap<string, string> | null
}

/**
 * A static `import` / `export ... from` statement at the start of a line, or
 * a bare `import "x"`. Transformed code (oxc, vue SFC compiler) puts every
 * such statement on its own line; dynamic `import()` does not match.
 */
const STATEMENT =
  /^[ \t]*(import|export)\s*([\w$\s{},*]*?)\s*from\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm

/** Parses one specifier list `{ a, b as c, default as D }` into pairs. */
function bindings(list: string): Array<[string, string]> {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [from, to] = part.split(/\s+as\s+/)
      return [from as string, (to ?? from) as string]
    })
}

/** The static edges of one module's code. */
export function parseEdges(code: string): Edge[] {
  const edges: Edge[] = []
  for (const m of code.matchAll(STATEMENT)) {
    if (m[4] !== undefined) {
      edges.push({ spec: m[4], names: new Set(), reexports: null })
      continue
    }
    const kind = m[1] as string
    const clause = (m[2] as string).trim()
    const spec = m[3] as string
    const braces = /\{([^}]*)\}/.exec(clause)
    const listed = braces ? bindings(braces[1] as string) : []
    if (kind === 'import') {
      const names = new Set(listed.map(([from]) => from))
      const head = clause.replace(/\{[^}]*\}/, '').trim()
      if (/\*\s*as\s/.test(head)) names.add(ALL)
      else if (/^[\w$]+/.test(head)) names.add('default')
      edges.push({ spec, names, reexports: null })
    } else if (clause === '*') {
      // `export * from`: every name the importer is asked for may live here.
      edges.push({ spec, names: new Set(), reexports: new Map([[ALL, ALL]]) })
    } else if (/^\*\s*as\s+([\w$]+)$/.test(clause)) {
      const ns = (/^\*\s*as\s+([\w$]+)$/.exec(clause) as RegExpExecArray)[1] as string
      edges.push({ spec, names: new Set(), reexports: new Map([[ns, ALL]]) })
    } else {
      edges.push({ spec, names: new Set(), reexports: new Map(listed.map(([f, t]) => [t, f])) })
    }
  }
  return edges
}

const EXTENSIONS = ['', '.ts', '.js', '.mjs', '.vue', '.json']

/** Resolves `..` and `.` segments: `a/b/../c/./d` becomes `a/c/d` (Rolldown ids use forward slashes). */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.') out.push(part)
  }
  return out.join('/')
}

/**
 * Maps a specifier of `importer` to one of its resolved `importedIds`, or
 * null. `alias` rewrites an aliased specifier to an absolute path (the
 * config's resolve.alias); a bare package specifier matches by its
 * node_modules folder.
 */
export function matchSpecifier(
  spec: string,
  importer: string,
  importedIds: readonly string[],
  alias: (spec: string) => string | null,
): string | null {
  if (importedIds.includes(spec)) return spec
  const aliased = alias(spec)
  let base: string | null = aliased
  if (base === null && (spec.startsWith('./') || spec.startsWith('../'))) {
    const dir = importer.split('?')[0]?.replace(/\/[^/]*$/, '') ?? ''
    base = normalize(`${dir}/${spec}`)
  }
  if (base !== null) {
    for (const ext of EXTENSIONS) {
      if (importedIds.includes(`${base}${ext}`)) return `${base}${ext}`
      if (ext !== '' && importedIds.includes(`${base}/index${ext}`)) return `${base}/index${ext}`
    }
    return null
  }
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  return importedIds.find((id) => id.includes(`/node_modules/${pkg}/`)) ?? null
}

/**
 * The static closure of `entry`, following a re-export only when some
 * importer uses its name.
 */
export function usedClosure(
  entry: string,
  lookup: ModuleLookup,
  alias: (spec: string) => string | null,
): Set<string> {
  const included = new Set<string>()
  const asked = new Map<string, Set<string>>()
  const edgesOf = new Map<string, Array<{ id: string; edge: Edge | null }>>()

  const edges = (id: string, info: GraphModule): Array<{ id: string; edge: Edge | null }> => {
    const known = edgesOf.get(id)
    if (known) return known
    const list: Array<{ id: string; edge: Edge | null }> = []
    const matched = new Set<string>()
    for (const edge of parseEdges(info.code ?? '')) {
      const target = matchSpecifier(edge.spec, id, info.importedIds, alias)
      if (target === null) continue
      matched.add(target)
      list.push({ id: target, edge })
    }
    // An import the parse did not map: the whole module, to stay complete.
    for (const dep of info.importedIds) if (!matched.has(dep)) list.push({ id: dep, edge: null })
    edgesOf.set(id, list)
    return list
  }

  const queue: Array<[string, Names]> = [[entry, new Set()]]
  while (queue.length > 0) {
    const [id, names] = queue.pop() as [string, Names]
    const info = lookup(id)
    if (!info) continue
    const seen = asked.get(id) ?? new Set<string>()
    const fresh = [...names].filter((n) => !seen.has(n) && !seen.has(ALL))
    const first = !included.has(id)
    if (!first && fresh.length === 0) continue
    included.add(id)
    for (const n of fresh) seen.add(n)
    asked.set(id, seen)
    for (const { id: dep, edge } of edges(id, info)) {
      if (edge === null) {
        if (first) queue.push([dep, new Set([ALL])])
      } else if (edge.reexports === null) {
        if (first) queue.push([dep, edge.names])
      } else {
        const want = new Set<string>()
        for (const [exported, source] of edge.reexports) {
          if (exported === ALL) {
            for (const n of first ? seen : fresh) want.add(n)
          } else if (seen.has(ALL) || fresh.includes(exported)) {
            want.add(source)
          }
        }
        if (want.size > 0) queue.push([dep, want])
      }
    }
  }
  return included
}

/** Every module reachable over static imports, re-exports included. */
export function fullClosure(entry: string, lookup: ModuleLookup): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (seen.has(id)) continue
    const info = lookup(id)
    if (!info) continue
    seen.add(id)
    queue.push(...info.importedIds)
  }
  return seen
}

/**
 * The `name` function of the startup code-splitting group. Two chunks:
 * - `app`: what the startup closure of app.ts uses, minus `host`;
 * - `host`: the FULL static closure of main.ts (main.ts itself stays in the
 *   entry chunk).
 * `host` over-estimates on purpose: a module main.ts loads that landed in
 * `app` would make the entry chunk import `app` statically, and app.ts would
 * run before prepareHost().
 *
 * Rolldown calls the function once per module in one chunking pass; the
 * sets are computed on the first call of a pass and reused (keyed by the
 * pass's ModuleInfo object of app.ts, which Rolldown reuses within a pass).
 */
export function startupChunkName(
  appEntry: string,
  hostEntry: string,
  alias: (spec: string) => string | null,
): (id: string, ctx: { getModuleInfo: ModuleLookup }) => string | null {
  let pass: object | null = null
  let host = new Set<string>()
  let app = new Set<string>()
  return (id, ctx) => {
    // A method of the context: called unbound it loses `this`.
    const lookup: ModuleLookup = (m) => ctx.getModuleInfo(m)
    const key = lookup(appEntry)
    if (key === null) return null
    if (key !== pass) {
      pass = key
      host = fullClosure(hostEntry, lookup)
      app = usedClosure(appEntry, lookup, alias)
    }
    if (id === hostEntry) return null
    if (host.has(id)) return 'host'
    return app.has(id) ? 'app' : null
  }
}
