// Bundle report (FE-157 stage 0.2): the size facts of a built dist/.
//
// Run AFTER `vite build` (or `pnpm build`). Prints:
//   - the startup app chunk (assets/app-*.js): raw and gzip;
//   - total JS and CSS (and JS without the lazy Zoom SDK chunk);
//   - the PWA precache: entry count and bytes (parsed from dist/sw.js);
//   - the 15 largest files of dist/.
//
// Usage (from frontend/):
//   node scripts/bundle-report.mjs                 human-readable report
//   node scripts/bundle-report.mjs --json          the same facts as JSON (CI)
//   node scripts/bundle-report.mjs --dist <dir>    report another output dir
//   node scripts/bundle-report.mjs --modules       per-chunk module dump, see below
//   node scripts/bundle-report.mjs --budget [file] size gate, see below
//
// --budget compares the built dist/ with the baseline in bundle-budget.json
// (default: frontend/bundle-budget.json; values = the golden build after
// FE-157 stage 2). Exit code 1 when
//   - the app chunk gzip exceeds the budget by more than 2% (tolerance for
//     build noise), or
//   - the PWA precache bytes exceed the budget (no tolerance).
// It always prints a markdown table with the delta against the budget, and
// appends it to $GITHUB_STEP_SUMMARY when that is set (CI). Raising the
// budget is a deliberate edit of bundle-budget.json in the same PR.
//
// --modules runs its OWN production build into a temporary outDir (dist/ is
// left untouched on the golden build; with a skin in public/skin/ the
// config's skinAssetSpill still copies the skin assets into frontend/dist/,
// its path is fixed there) with vite.config.ts unchanged: the config file is loaded as
// is, and an inline config (Vite's JS API merges it over the file) adds one
// generateBundle plugin that records chunk -> modules[renderedLength], plus
// the temporary outDir. No extra dependency. It answers "is X still in the
// startup set": the startup set is every initial entry chunk plus the app
// chunk (main.ts imports app.ts dynamically) and their static imports,
// transitively. Options:
//   --find <regex>   list every chunk holding a matching module id
//                    (e.g. --find luxon, --find 'locales/ru/master')
//   --top <n>        modules listed for the startup set (default 40)
//   --keep           keep the temporary directory (its modules.json path is printed)
// With --json, --modules prints the whole dump as JSON instead.
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const frontendDir = fileURLToPath(new URL('..', import.meta.url))

/** Return the value after `--name`, or undefined when the flag is absent. */
function flagValue(argv, name) {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

/** Format bytes in Vite's own unit (kB = 1000 bytes) so numbers match the build log. */
function kb(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`
}

/** List every file under `dir` with its size, paths relative to `dir` in POSIX form. */
function walkFiles(dir) {
  const out = []
  const visit = (abs) => {
    for (const name of readdirSync(abs)) {
      const path = join(abs, name)
      const st = statSync(path)
      if (st.isDirectory()) visit(path)
      else out.push({ file: relative(dir, path).split(sep).join('/'), bytes: st.size })
    }
  }
  visit(dir)
  return out
}

/** Sum raw and gzip bytes of the given dist-relative files. */
function sumSizes(distDir, files) {
  let bytes = 0
  let gzip = 0
  for (const file of files) {
    const buf = readFileSync(join(distDir, file))
    bytes += buf.length
    gzip += gzipSync(buf).length
  }
  return { files: files.length, bytes, gzip }
}

/**
 * Read the precache manifest that vite-plugin-pwa (generateSW) inlines into
 * sw.js as `precacheAndRoute([{url:"...",revision:...}, ...])`.
 *
 * @returns The entry count and bytes, or null when dist/ has no sw.js.
 */
function precacheOf(distDir) {
  const swPath = join(distDir, 'sw.js')
  if (!existsSync(swPath)) return null
  const sw = readFileSync(swPath, 'utf8')
  const list = sw.match(/precacheAndRoute\(\s*\[([\s\S]*?)\]\s*[,)]/)
  if (!list) throw new Error('bundle-report: no precacheAndRoute([...]) list in sw.js')
  const urls = [...list[1].matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1])
  let bytes = 0
  const missing = []
  for (const url of urls) {
    const path = join(distDir, url)
    if (existsSync(path)) bytes += statSync(path).size
    else missing.push(url)
  }
  return { entries: urls.length, bytes, missing }
}

/** Collect the size facts of a built dist/ directory. */
function report(distDir) {
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(`bundle-report: ${distDir} has no index.html -- run the build first`)
  }
  const files = walkFiles(distDir)
  const assets = files.map((f) => f.file).filter((f) => f.startsWith('assets/'))
  const js = assets.filter((f) => f.endsWith('.js'))
  const css = assets.filter((f) => f.endsWith('.css'))
  const appChunks = js.filter((f) => /^assets\/app-[\w-]+\.js$/.test(f))
  if (appChunks.length !== 1) {
    throw new Error(`bundle-report: expected one assets/app-*.js, found ${appChunks.length}`)
  }
  const appFile = appChunks[0]
  const appBuf = readFileSync(join(distDir, appFile))
  return {
    dist: distDir,
    entry: { file: appFile, bytes: appBuf.length, gzip: gzipSync(appBuf).length },
    js: sumSizes(distDir, js),
    jsWithoutZoom: sumSizes(
      distDir,
      js.filter((f) => !/^assets\/zoom-sdk-/.test(f)),
    ),
    css: sumSizes(distDir, css),
    precache: precacheOf(distDir),
    top: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 15),
  }
}

/** Print the report for humans. */
function printReport(r) {
  const line = (label, v) => console.log(`${label.padEnd(24)}${v}`)
  console.log(`bundle-report: ${relative(process.cwd(), r.dist) || '.'}`)
  line('app chunk', `${r.entry.file}  ${kb(r.entry.bytes)} | gzip ${kb(r.entry.gzip)}`)
  line('JS total', `${r.js.files} files  ${kb(r.js.bytes)} | gzip ${kb(r.js.gzip)}`)
  line(
    'JS without zoom-sdk',
    `${r.jsWithoutZoom.files} files  ${kb(r.jsWithoutZoom.bytes)} | gzip ${kb(r.jsWithoutZoom.gzip)}`,
  )
  line('CSS total', `${r.css.files} files  ${kb(r.css.bytes)} | gzip ${kb(r.css.gzip)}`)
  if (r.precache) {
    line('precache', `${r.precache.entries} entries  ${kb(r.precache.bytes)}`)
    if (r.precache.missing.length) {
      line('precache (not in dist)', r.precache.missing.join(', '))
    }
  } else {
    line('precache', 'no sw.js in dist/')
  }
  console.log('top 15 files:')
  for (const f of r.top) console.log(`  ${kb(f.bytes).padStart(12)}  ${f.file}`)
}

/**
 * Collapse a module id to a readable group: the npm package for
 * node_modules, the path relative to frontend/ (or to the repository root
 * for workspace packages such as packages/velo-ui) otherwise.
 */
function moduleLabel(id) {
  const clean = id.replace(/^\0/, '').replace(/\?.*$/, '').split(sep).join('/')
  const nm = clean.lastIndexOf('node_modules/')
  if (nm !== -1) {
    const rest = clean.slice(nm + 'node_modules/'.length).split('/')
    return `npm:${rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]}`
  }
  const rel = relative(frontendDir, clean).split(sep).join('/')
  if (!rel.startsWith('..')) return rel
  const repoRel = relative(join(frontendDir, '..'), clean).split(sep).join('/')
  return repoRel.startsWith('..') ? clean : repoRel
}

/** Run a production build into a temporary outDir and dump the chunk graph. */
async function dumpModules() {
  const { build } = await import('vite')
  const tmp = mkdtempSync(join(tmpdir(), 'velo-bundle-report-'))
  const outDir = join(tmp, 'dist')
  const chunks = []
  await build({
    root: frontendDir,
    configFile: join(frontendDir, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
    plugins: [
      {
        name: 'velo-bundle-report-modules',
        apply: 'build',
        generateBundle(_options, bundle) {
          for (const out of Object.values(bundle)) {
            if (out.type !== 'chunk') continue
            chunks.push({
              file: out.fileName,
              isEntry: out.isEntry,
              isDynamicEntry: out.isDynamicEntry,
              imports: out.imports,
              modules: Object.fromEntries(
                Object.entries(out.modules).map(([id, m]) => [id, m.renderedLength]),
              ),
            })
          }
        },
      },
    ],
  })
  writeFileSync(join(tmp, 'modules.json'), JSON.stringify(chunks, null, 2))
  return { tmp, chunks }
}

/** The chunks loaded on start: initial entries + the app chunk, with static imports. */
function startupSet(chunks) {
  const byFile = new Map(chunks.map((c) => [c.file, c]))
  const roots = chunks.filter(
    (c) =>
      c.isEntry ||
      (c.isDynamicEntry && Object.keys(c.modules).some((id) => id.endsWith('/src/app.ts'))),
  )
  const seen = new Set()
  const visit = (file) => {
    if (seen.has(file)) return
    const chunk = byFile.get(file)
    if (!chunk) return
    seen.add(file)
    for (const dep of chunk.imports) visit(dep)
  }
  for (const root of roots) visit(root.file)
  return [...seen].map((f) => byFile.get(f))
}

/** Print the startup set grouped by package / source file, and --find hits. */
function printModules(chunks, { find, top }) {
  const startup = startupSet(chunks)
  console.log(`startup set: ${startup.map((c) => c.file).join(', ')}`)
  const groups = new Map()
  let total = 0
  for (const chunk of startup) {
    for (const [id, len] of Object.entries(chunk.modules)) {
      const label = moduleLabel(id)
      groups.set(label, (groups.get(label) ?? 0) + len)
      total += len
    }
  }
  console.log(`startup modules (rendered, pre-minify sum ${kb(total)}), top ${top}:`)
  for (const [label, len] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`  ${kb(len).padStart(12)}  ${label}`)
  }
  if (!find) return
  const re = new RegExp(find)
  const startupFiles = new Set(startup.map((c) => c.file))
  let hits = 0
  console.log(`--find ${find}:`)
  for (const chunk of chunks) {
    const matched = Object.entries(chunk.modules).filter(([id]) => re.test(id))
    if (!matched.length) continue
    hits += matched.length
    const sum = matched.reduce((acc, [, len]) => acc + len, 0)
    const tag = startupFiles.has(chunk.file) ? 'STARTUP' : 'lazy'
    console.log(`  [${tag}] ${chunk.file}: ${matched.length} modules, ${kb(sum)}`)
  }
  if (!hits) console.log('  no module matches')
}

/** Entry gzip may exceed the budget by this fraction before the gate fails. */
const ENTRY_TOLERANCE = 0.02

/** Signed delta of `actual` against `base`: "+1.20 kB (+0.8%)". */
function delta(actual, base) {
  const diff = actual - base
  const pct = base === 0 ? 0 : (diff / base) * 100
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '±'
  return `${sign}${(Math.abs(diff) / 1000).toFixed(2)} kB (${sign}${Math.abs(pct).toFixed(1)}%)`
}

/**
 * Check a report against the budget.
 *
 * @returns Markdown summary and the list of failures (empty = within budget).
 */
function checkBudget(r, budget) {
  const failures = []
  const entryLimit = Math.floor(budget.entryGzip * (1 + ENTRY_TOLERANCE))
  const entryOk = r.entry.gzip <= entryLimit
  if (!entryOk) {
    failures.push(
      `app chunk gzip ${kb(r.entry.gzip)} exceeds budget ${kb(budget.entryGzip)} by more than ${ENTRY_TOLERANCE * 100}% (limit ${kb(entryLimit)})`,
    )
  }
  const rows = [
    `| app chunk gzip | ${kb(budget.entryGzip)} | ${kb(r.entry.gzip)} | ${delta(r.entry.gzip, budget.entryGzip)} | limit ${kb(entryLimit)} | ${entryOk ? 'ok' : 'FAIL'} |`,
  ]
  if (!r.precache) {
    failures.push('no sw.js in dist/: precache cannot be checked')
    rows.push(
      `| precache bytes | ${kb(budget.precacheBytes)} | n/a | n/a | limit ${kb(budget.precacheBytes)} | FAIL |`,
    )
  } else {
    const ok = r.precache.bytes <= budget.precacheBytes
    if (!ok) {
      failures.push(`precache ${kb(r.precache.bytes)} exceeds budget ${kb(budget.precacheBytes)}`)
    }
    rows.push(
      `| precache bytes | ${kb(budget.precacheBytes)} | ${kb(r.precache.bytes)} | ${delta(r.precache.bytes, budget.precacheBytes)} | limit ${kb(budget.precacheBytes)} | ${ok ? 'ok' : 'FAIL'} |`,
    )
  }
  const md = [
    `### Bundle budget: ${failures.length ? 'FAIL' : 'ok'}`,
    '',
    '| metric | budget | actual | delta | gate | status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...failures.map((f) => `- ${f}`),
  ].join('\n')
  return { md, failures }
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')

if (argv.includes('--modules')) {
  const { tmp, chunks } = await dumpModules()
  if (asJson) {
    console.log(JSON.stringify(chunks))
  } else {
    printModules(chunks, {
      find: flagValue(argv, '--find'),
      top: Number(flagValue(argv, '--top') ?? 40),
    })
  }
  if (argv.includes('--keep')) console.error(`modules dump kept: ${join(tmp, 'modules.json')}`)
  else rmSync(tmp, { recursive: true, force: true })
} else {
  const distDir = flagValue(argv, '--dist') ?? join(frontendDir, 'dist')
  const r = report(distDir)
  if (argv.includes('--budget')) {
    const next = argv[argv.indexOf('--budget') + 1]
    const budgetPath =
      next && !next.startsWith('--') ? next : join(frontendDir, 'bundle-budget.json')
    const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
    for (const key of ['entryGzip', 'precacheBytes']) {
      if (!Number.isFinite(budget[key])) {
        throw new Error(`bundle-report: ${budgetPath} has no numeric ${key}`)
      }
    }
    const { md, failures } = checkBudget(r, budget)
    console.log(md)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
    }
    if (failures.length) process.exit(1)
  } else if (asJson) console.log(JSON.stringify(r, null, 2))
  else printReport(r)
}
