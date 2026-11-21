// =============================================================================
// FE-224 -- which Figma mirror sheets ("Front" pages) a code change touches
// (docs/figma-protocol.md §8). Pure logic; the CLI is scripts/front-sheets.mjs.
// =============================================================================
//
// A mirror sheet (one top-level section on a "Front" page) mirrors code:
//   screen:<route>      the view in `sources` plus everything it renders
//                       (the import closure, see below) and the global styles;
//   component:<Family>  the kit masters' files in `sources` (paths, component
//                       folders or `name:<Component>`) and their closure;
//   registry:*          the token registry; skin:* the registry and the skin
//                       assets; asset:app-background the background images;
//   anything else       (templates: sheet chrome) mirrors no code.
//
// The import closure follows static, dynamic and CSS imports through .vue,
// .ts and .css files under GRAPH_ROOTS only (components, views, utils,
// styles, assets, the kit sources): stores, api, router and composables are
// behaviour, and following them would make every screen depend on every
// other one. A named import from a barrel (`import { VButton } from
// '@velo/ui'`) depends on the file that defines that name, not on the whole
// barrel.
//
// Only VISUAL changes count: .vue, styles, images, the token files and the
// skin asset folders. A .ts change (logic) never asks for a resnap, even
// when it sits in a closure; tests and docs never do.
// =============================================================================

export const TOKEN_FILES = ['frontend/tokens.json', 'frontend/src/styles/variables.css']
export const SKIN_ASSET_DIRS = ['frontend/public/bg/', 'frontend/public/icons/']
/** Files every screen depends on without importing them. */
export const SCREEN_GLOBALS = [
  'frontend/src/styles/global.css',
  'frontend/src/App.vue',
  'frontend/src/components/layout/AppFrame.vue',
]
export const GRAPH_ROOTS = [
  'frontend/src/components/',
  'frontend/src/views/',
  'frontend/src/utils/',
  'frontend/src/styles/',
  'frontend/src/assets/',
  'packages/velo-ui/src/',
]
const ALIASES = [
  { re: /^@velo\/ui$/, to: 'packages/velo-ui/src/index.ts' },
  { re: /^@\//, to: 'frontend/src/' },
]
const EXTENSIONS = ['', '.ts', '.vue', '.js', '.mjs', '.css', '/index.ts', '/index.js']
const VISUAL_RE = /\.(vue|css|scss|svg|png|webp|jpe?g|gif)$/
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]s$)|(\/__tests__\/)|(\/e2e\/)/

/** True when a changed file can change what a mirror sheet shows. */
export function isVisualChange(path) {
  if (TEST_RE.test(path)) return false
  if (TOKEN_FILES.includes(path)) return true
  if (SKIN_ASSET_DIRS.some((d) => path.startsWith(d))) return true
  return VISUAL_RE.test(path)
}

const inGraph = (path) => GRAPH_ROOTS.some((r) => path.startsWith(r))

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function parseBindings(clause) {
  // `Default, { a as b, type C }` / `* as ns` / `{ a }` -> [{ imported, local }]; null = whole module
  if (/\*\s+as\s+\w+/.test(clause)) return null
  const out = []
  const braces = /\{([\s\S]*)\}/.exec(clause)
  const head = clause
    .replace(/\{[\s\S]*\}/, '')
    .replace(/,/g, ' ')
    .trim()
  if (head) out.push({ imported: 'default', local: head })
  if (braces) {
    for (const part of braces[1].split(',')) {
      const t = part.trim()
      if (!t || t.startsWith('type ')) continue
      const [imported, local] = t.split(/\s+as\s+/).map((x) => x.trim())
      out.push({ imported, local: local || imported })
    }
  }
  return out
}

/**
 * Imports and re-exports of one module (.vue, .ts or .css source).
 * @returns {{ imports: {spec: string, bindings: {imported: string, local: string}[] | null}[],
 *             reexports: {spec: string, map: Map<string,string> | null}[] }}
 *          `bindings` null = the whole module; `map` = exported name -> imported name, null = `export *`.
 */
export function parseModule(source) {
  const src = stripComments(source)
  const imports = []
  const reexports = []
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([\w*{}\s,$]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) continue
    const bindings = parseBindings(m[2])
    if (bindings && !bindings.length) continue // only type-only specifiers
    imports.push({ spec: m[3], bindings })
  }
  for (const m of src.matchAll(/(?<![@\w.])import\s+['"]([^'"]+)['"]/g))
    imports.push({ spec: m[1], bindings: null })
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
    imports.push({ spec: m[1], bindings: null })
  for (const m of src.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g))
    imports.push({ spec: m[1], bindings: null })
  for (const m of src.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) continue
    const map = new Map()
    for (const part of m[2].split(',')) {
      const t = part.trim()
      if (!t || t.startsWith('type ')) continue
      const [imported, exported] = t.split(/\s+as\s+/).map((x) => x.trim())
      map.set(exported || imported, imported)
    }
    if (map.size) reexports.push({ spec: m[3], map })
  }
  for (const m of src.matchAll(/\bexport\s+\*\s+(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/g)) {
    reexports.push({ spec: m[1], map: null })
  }
  return { imports, reexports }
}

/**
 * Source of the top-level declaration of `name` (up to the next top-level statement),
 * or null when the module has none (`export default {…}`, a list export of an import).
 */
export function declarationOf(source, name) {
  const src = stripComments(source)
  const re =
    name === 'default'
      ? /^export\s+default\b/m
      : new RegExp(
          `^(?:export\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|enum)\\s+${name}\\b`,
          'm',
        )
  const m = re.exec(src)
  if (!m) return null
  const rest = src.slice(m.index + m[0].length)
  const end = rest.search(/\n(?:export|import|const|let|var|function|class|async|enum)\b/)
  return end < 0 ? rest : rest.slice(0, end)
}

function joinPath(dir, rel) {
  const out = dir ? dir.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/**
 * A repo view the graph reads: `files` = every path (Set), `read(path)` = content or null.
 * @param {{ files: Set<string>, read: (path: string) => string | null }} repo
 */
export function createGraph(repo) {
  const parsed = new Map()
  const parse = (path) => {
    if (!parsed.has(path)) {
      const src = repo.read(path)
      parsed.set(
        path,
        src === null || src === undefined ? { imports: [], reexports: [] } : parseModule(src),
      )
    }
    return parsed.get(path)
  }

  function resolve(from, spec) {
    const clean = spec.split('?')[0]
    let base = null
    for (const a of ALIASES) if (a.re.test(clean)) base = clean.replace(a.re, a.to)
    if (base === null && clean.startsWith('.'))
      base = joinPath(from.split('/').slice(0, -1).join('/'), clean)
    if (base === null && clean.startsWith('/')) base = joinPath('frontend/public', clean)
    if (base === null) return null // a package from node_modules
    for (const ext of EXTENSIONS) if (repo.files.has(base + ext)) return base + ext
    return null
  }

  const isScript = (file) => /\.[cm]?[jt]s$/.test(file)
  const exportsLocally = (file, name) => declarationOf(repo.read(file) || '', name) !== null

  /**
   * Where `name` exported by module `file` is defined, following re-exports:
   * [{ file, name }] (the name in that file); [] = not found.
   */
  function definers(file, name, seen = new Set()) {
    if (seen.has(file + '#' + name)) return []
    seen.add(file + '#' + name)
    if (!isScript(file)) return [{ file, name }] // a .vue/.css module defines its own exports
    const { reexports } = parse(file)
    for (const r of reexports) {
      if (r.map && r.map.has(name)) {
        const target = resolve(file, r.spec)
        if (!target) return []
        const found = definers(target, r.map.get(name), seen)
        return found.length ? found : [{ file: target, name: r.map.get(name) }]
      }
    }
    if (exportsLocally(file, name)) return [{ file, name }]
    for (const r of reexports) {
      if (r.map) continue
      const target = resolve(file, r.spec)
      const found = target ? definers(target, name, seen) : []
      if (found.length) return found
    }
    return []
  }

  // Graph nodes: a file path, or `path#name` = one declaration of a script module
  // (a barrel that defines a wrapper next to its re-exports). A declaration depends
  // only on the imports its own source uses.
  const fileOf = (node) => node.split('#')[0]
  function nodesFor(target, bindings) {
    if (bindings === null) return [target]
    const out = []
    for (const b of bindings) {
      const found = definers(target, b.imported)
      if (!found.length) out.push(target)
      for (const d of found)
        out.push(
          isScript(d.file) && exportsLocally(d.file, d.name) ? `${d.file}#${d.name}` : d.file,
        )
    }
    return out
  }

  /** Direct dependencies of one graph node. */
  function deps(node) {
    const [file, name] = node.split('#')
    const decl = name ? declarationOf(repo.read(file) || '', name) : null
    const out = new Set()
    for (const imp of parse(file).imports) {
      const target = resolve(file, imp.spec)
      if (!target) continue
      let bindings = imp.bindings
      if (decl !== null) {
        if (bindings === null) continue // a side-effect or namespace import is not this declaration's
        bindings = bindings.filter((b) =>
          new RegExp(`\\b${b.local.replace(/\$/g, '\\$')}\\b`).test(decl),
        )
        if (!bindings.length) continue
      }
      for (const n of nodesFor(target, bindings))
        if (inGraph(fileOf(n)) || n.startsWith('frontend/public/')) out.add(n)
    }
    return out
  }

  const closures = new Map()
  /** The file and every file it renders: transitive deps within GRAPH_ROOTS. */
  function closure(start) {
    if (closures.has(start)) return closures.get(start)
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      const n = queue.shift()
      if (!inGraph(n)) continue
      for (const d of deps(n)) {
        if (seen.has(d)) continue
        seen.add(d)
        queue.push(d)
      }
    }
    const files = new Set([...seen].map(fileOf))
    closures.set(start, files)
    return files
  }

  return { resolve, definers, deps, closure }
}

/**
 * Turns manifest `sources` into repo files.
 * A path that no longer exists falls back to the same file name under GRAPH_ROOTS
 * (a component moved into the kit keeps its name) and is reported as `moved`.
 */
export function resolveSources(sources, repo) {
  const files = []
  const moved = []
  const missing = []
  const all = [...repo.files]
  const byName = (base) =>
    all.filter((f) => inGraph(f) && f.endsWith('/' + base) && !TEST_RE.test(f))
  for (const s of sources) {
    if (s.startsWith('name:')) {
      const hit = byName(s.slice(5) + '.vue')
      if (hit.length) files.push(...hit)
      else missing.push(s)
      continue
    }
    const dir = s.replace(/\/\*\*$/, '').replace(/\/$/, '')
    if (repo.files.has(dir)) {
      files.push(dir)
      continue
    }
    const inside = all.filter(
      (f) => f.startsWith(dir + '/') && VISUAL_RE.test(f) && !TEST_RE.test(f),
    )
    if (inside.length) {
      files.push(...inside)
      continue
    }
    const base = dir.split('/').pop()
    const hit = byName(/\.\w+$/.test(base) ? base : base + '.vue')
    if (hit.length) {
      files.push(...hit)
      moved.push({ from: s, to: hit })
    } else {
      missing.push(s)
    }
  }
  return { files: [...new Set(files)], moved, missing }
}

/** What one sheet depends on: exact files plus folder prefixes. */
export function sheetDeps(sheet, repo, graph) {
  const key = sheet.key || ''
  const files = new Set()
  const prefixes = []
  const notes = []
  if (key.startsWith('screen:') || key.startsWith('component:')) {
    const r = resolveSources(sheet.sources || [], repo)
    for (const f of r.files) for (const d of graph.closure(f)) files.add(d)
    if (key.startsWith('screen:')) for (const f of SCREEN_GLOBALS) files.add(f)
    for (const m of r.moved) notes.push(`source moved: ${m.from} -> ${m.to.join(', ')}`)
    for (const m of r.missing) notes.push(`source not found: ${m}`)
  } else if (key.startsWith('registry:')) {
    for (const f of TOKEN_FILES) files.add(f)
  } else if (key.startsWith('skin:')) {
    for (const f of TOKEN_FILES) files.add(f)
    prefixes.push(...SKIN_ASSET_DIRS)
  } else if (key === 'asset:app-background') {
    prefixes.push('frontend/public/bg/')
  }
  return { files, prefixes, notes }
}

const depends = (d, path) => d.files.has(path) || d.prefixes.some((p) => path.startsWith(p))

/**
 * Sheets to resnap for a list of changed files.
 * @returns {{ sheets: {key,id,page,name,reasons: string[]}[], tokens: boolean,
 *             screensWithoutSheet: string[], notes: string[] }}
 */
export function affectedSheets(changedFiles, manifest, repo, graph = createGraph(repo)) {
  const visual = [...new Set(changedFiles)].filter(isVisualChange).sort()
  const sheets = []
  const notes = []
  for (const sheet of manifest.sheets || []) {
    const d = sheetDeps(sheet, repo, graph)
    notes.push(...d.notes.map((n) => `${sheet.key}: ${n}`))
    const reasons = visual.filter((f) => depends(d, f))
    if (reasons.length)
      sheets.push({ key: sheet.key, id: sheet.id, page: sheet.page, name: sheet.name, reasons })
  }
  const covered = new Set(
    (manifest.sheets || [])
      .filter((s) => (s.key || '').startsWith('screen:'))
      .flatMap((s) => s.sources || []),
  )
  const screensWithoutSheet = visual.filter(
    (f) => /^frontend\/src\/views\/.+\.vue$/.test(f) && !covered.has(f),
  )
  return { sheets, tokens: visual.some((f) => TOKEN_FILES.includes(f)), screensWithoutSheet, notes }
}

/**
 * Weekly check: each sheet of a Figma inventory against the code it mirrors.
 * `changedSince(commit)` returns the files changed from that commit to the checked ref,
 * or null when the commit is unknown to the repo.
 * @returns {{ stale, fresh, unknown, edited, notMirroring, drift }}
 */
export function staleSheets(inventory, manifest, repo, changedSince, graph = createGraph(repo)) {
  /** @typedef {{ key: string, id: string, page: string, name: string }} SheetRef */
  /** @type {{ stale: (SheetRef & { commit: string, reasons: string[] })[], fresh: (SheetRef & { commit: string })[],
   *           unknown: (SheetRef & { why: string })[], edited: SheetRef[], notMirroring: SheetRef[], drift: string[] }} */
  const out = { stale: [], fresh: [], unknown: [], edited: [], notMirroring: [], drift: [] }
  for (const sheet of inventory.sheets || []) {
    const ref = { key: sheet.key, id: sheet.id, page: sheet.page, name: sheet.name }
    if (sheet.intact === false) out.edited.push(ref)
    const d = sheetDeps(sheet, repo, graph)
    if (!d.files.size && !d.prefixes.length) {
      out.notMirroring.push(ref)
      continue
    }
    if (!sheet.commit) {
      out.unknown.push({ ...ref, why: 'no c2f:commit' })
      continue
    }
    const changed = changedSince(sheet.commit)
    if (changed === null) {
      out.unknown.push({ ...ref, why: `commit ${sheet.commit} not in the repo` })
      continue
    }
    const reasons = changed
      .filter(isVisualChange)
      .filter((f) => depends(d, f))
      .sort()
    if (reasons.length) out.stale.push({ ...ref, commit: sheet.commit, reasons })
    else out.fresh.push({ ...ref, commit: sheet.commit })
  }
  if (manifest) {
    const inFigma = new Map((inventory.sheets || []).map((s) => [s.key, s]))
    const inRepo = new Map((manifest.sheets || []).map((s) => [s.key, s]))
    for (const [k, s] of inFigma) {
      if (!inRepo.has(k)) out.drift.push(`${k}: in Figma (${s.id}), not in the manifest`)
      else if (inRepo.get(k).id !== s.id)
        out.drift.push(`${k}: node ${s.id} in Figma, ${inRepo.get(k).id} in the manifest`)
    }
    for (const k of inRepo.keys())
      if (!inFigma.has(k)) out.drift.push(`${k}: in the manifest, not in Figma`)
  }
  return out
}

/** Manifest = the inventory without the per-capture fields (they live in Figma only). */
export function toManifest(inventory, date) {
  return {
    about:
      'Mirror sheets of the Figma "Front" pages (docs/figma-protocol.md §8). Generated from c2fInventory() in Figma; ' +
      'commits and seals stay in Figma. Read by frontend/scripts/front-sheets.mjs.',
    file: inventory.file,
    generated: date,
    sheets: (inventory.sheets || []).map(({ key, id, page, name, sources }) => ({
      key,
      id,
      page,
      name,
      sources: sources || [],
    })),
  }
}
