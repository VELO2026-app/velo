// =============================================================================
// VELO Frontend -- skin generation 1 -> the DTCG package (FE-131, migration)
// =============================================================================
// Converts a generation-1 skin (brand.json + flat tokens.css + assets at the
// root, tz-whitelabel §3) into the deploy machine's package format
// (tz-whitelabel §3.2; scripts/lib/skin-package.mjs documents it):
//
//   primer-package.yaml          schema: 1, contract: "2.0"
//   tokens/brand.tokens.json     $extensions["velo-skin"] = brand.json
//   tokens/skin.tokens.json      every --velo-* / --font-body override at its
//                                tokens.json path (velo.text.primary, ...)
//   assets/...                   every asset, bg/ and onboarding/ included
//
// The token path comes from tokens.json (the product's own name map), never
// from string surgery: --velo-primary-dark is velo.primary.dark because
// tokens.json says so. A --velo-* the product does not know, or a bare token
// other than --font-body, stops the conversion with its name (a typo would
// theme nothing). A brand.json fontUrl stops it too: a package makes no
// external request -- put the woff2 into assets/fonts/ and list it under
// "fonts" by hand.
//
// The output is checked by the same engine the build uses; the conversion
// fails when the result is not a valid package.
//
// Usage: node scripts/skin-to-dtcg.mjs <gen1-dir> <out-dir>
//        (out-dir must not exist, or be empty)
// convertSkin() is exported for the unit suite.
// =============================================================================

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BRAND_EXTENSION,
  SKIN_CONTRACT,
  goldenTokenMap,
  loadSkinPackage,
  readGoldenTokens,
  skinnable,
} from './lib/skin-package.mjs'

/** Flat `--name: value;` declarations of a generation-1 tokens.css, in order. */
export function parseFlatTokens(css) {
  const out = []
  for (const line of css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const m = line.match(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/)
    if (m) out.push([m[1], m[2].trim()])
  }
  return out
}

/** Sets `value` at the dotted `path` of a nested object. A golden path can be
 *  both a token and a group (velo.primary / velo.primary.dark): the token's
 *  $value lives next to its children. */
function setPath(root, path, value) {
  let node = root
  for (const key of path.split('.')) node = node[key] ??= {}
  node.$value = value
}

/**
 * Generation-1 skin -> package files.
 *
 * @returns `{ files: { relPath: string }, assets: relPath[] }` (assets are
 *   copied by path from `gen1Dir`), or throws with every problem named.
 */
export function convertSkin(gen1Dir, tokensDoc) {
  const problems = []
  const brand = JSON.parse(readFileSync(join(gen1Dir, 'brand.json'), 'utf8'))
  if (brand.fontUrl !== undefined)
    problems.push(
      `brand.json fontUrl ${brand.fontUrl}: a package makes no external request -- ship the woff2 in assets/fonts/ and declare it under "fonts"`,
    )
  const byCss = new Map(
    [...goldenTokenMap(tokensDoc)].map(([path, t]) => [t.cssName, { path, ...t }]),
  )
  const tokens = {}
  const tokensPath = join(gen1Dir, 'tokens.css')
  const decls = existsSync(tokensPath) ? parseFlatTokens(readFileSync(tokensPath, 'utf8')) : []
  for (const [name, value] of decls) {
    const golden = byCss.get(name)
    if (!golden) problems.push(`tokens.css ${name}: not a token of tokens.json (a typo themes nothing)`)
    else if (!skinnable(golden.path))
      problems.push(`tokens.css ${name}: a frozen bare token -- a skin sets --velo-* and --font-body only`)
    else setPath(tokens, golden.path, value)
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))

  const { fontUrl: _dropped, ...record } = brand
  const files = {
    'primer-package.yaml': `# A VELO skin: a data package (contract 3 rule 10, tz-whitelabel §3.2).\nschema: 1\ncontract: "${SKIN_CONTRACT}"\n`,
    'tokens/brand.tokens.json':
      JSON.stringify({ $extensions: { [BRAND_EXTENSION]: record } }, null, 2) + '\n',
    'tokens/skin.tokens.json': JSON.stringify(tokens, null, 2) + '\n',
  }
  const assets = []
  const walk = (rel) => {
    const entries = readdirSync(join(gen1Dir, rel), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (!rel && (entry.name === 'brand.json' || entry.name === 'tokens.css')) continue
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(relPath)
      else assets.push(relPath)
    }
  }
  walk('')
  return { files, assets }
}

/** Writes the converted package to `outDir` and checks it with the engine. */
export function writePackage(gen1Dir, outDir, frontendDir) {
  if (existsSync(outDir) && readdirSync(outDir).length > 0)
    throw new Error(`${outDir}: not empty -- the package is written into a fresh directory`)
  const tokensDoc = readGoldenTokens(frontendDir)
  const { files, assets } = convertSkin(gen1Dir, tokensDoc)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(outDir, rel, '..'), { recursive: true })
    writeFileSync(join(outDir, rel), text)
  }
  for (const rel of assets) {
    mkdirSync(join(outDir, 'assets', rel, '..'), { recursive: true })
    cpSync(join(gen1Dir, rel), join(outDir, 'assets', rel))
  }
  const pkg = loadSkinPackage(outDir, tokensDoc)
  if (pkg.problems.length > 0)
    throw new Error(`the converted package is not valid:\n  ${pkg.problems.join('\n  ')}`)
  return pkg
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [from, to] = process.argv.slice(2)
  if (!from || !to) {
    console.error('usage: node scripts/skin-to-dtcg.mjs <gen1-dir> <out-dir>')
    process.exit(1)
  }
  try {
    const pkg = writePackage(resolve(from), resolve(to), resolve(import.meta.dirname, '..'))
    console.log(
      `skin-to-dtcg: ${pkg.decls.length} token(s), ${pkg.files.length} file(s) -> ${to} (contract "${pkg.contract}")`,
    )
  } catch (e) {
    console.error(`skin-to-dtcg: ${e.message}`)
    process.exit(1)
  }
}
