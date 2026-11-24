#!/usr/bin/env node
// =============================================================================
// VELO CI -- fetch the brand skin packages at their pinned tags (FE-234)
//
// Reads .github/brand-skins.json (repo, tag, commit, package dir per brand),
// clones each repository at its tag into <out-dir>/<brand> through the shared
// clone module (FE-239: frontend/scripts/lib/brand-git.mjs -- the Figma
// variables sync clones the same packages the same way), checks that the tag
// still points at the pinned commit, and prints one line for $GITHUB_ENV:
//   BRAND_SKIN_ARGS=--skin <out-dir>/<brand>/<dir> ...
// (the form scripts/build-matrix.mjs takes).
//
// A private brand repository needs a read key: set BRAND_REPO_TOKEN (the
// workflows pass the secret of that name; empty = anonymous, enough while the
// repositories are public). The key is the owner's decision (FE-234). It
// reaches git as a header in the environment, never in a URL or a file.
//
// Usage: node .github/scripts/fetch-brand-skins.mjs <out-dir> [--config <brand-skins.json>]
//        --config  another pin file (the Visual job reads the base's own pins)
// Node stdlib only. planBrands() and FORK_HINT are exported for the test; the
// clone machinery's own test runs with the frontend suite (brand-git.test.mjs).
// =============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cloneAtTag, revParseHead } from '../../frontend/scripts/lib/brand-git.mjs'

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand-skins.json')

/** What a failed clone without a key says in a workflow: the secret exists
 *  here, but a pull request from a fork does not get it. */
export const FORK_HINT =
  'the repository may be private: set the BRAND_REPO_TOKEN secret (read access), or the tag is missing. Secrets are not passed to pull requests from forks'

/** The brands of the config as { name, repo, tag, sha, target, skinDir }; a
 *  malformed entry throws, so a typo cannot silently drop a brand. */
export function planBrands(config, outDir) {
  const names = Object.keys(config.brands ?? {})
  if (names.length === 0) throw new Error('brand-skins.json: no brands')
  return names.map((name) => {
    const { repo, tag, sha, dir } = config.brands[name]
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`${name}: bad repo "${repo}"`)
    if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error(`${name}: bad tag "${tag}"`)
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`${name}: bad sha "${sha}"`)
    if (!/^[\w.-]+$/.test(dir ?? '')) throw new Error(`${name}: bad dir "${dir}"`)
    const target = join(outDir, name)
    return { name, repo, tag, sha, target, skinDir: join(target, dir) }
  })
}

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--config')
  const config = at >= 0 ? resolve(args[at + 1] ?? '') : CONFIG
  const out = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1))
  if (!out) {
    console.error('usage: node .github/scripts/fetch-brand-skins.mjs <out-dir> [--config <file>]')
    process.exit(1)
  }
  const outDir = resolve(out)
  const token = process.env.BRAND_REPO_TOKEN ?? ''
  const brands = planBrands(JSON.parse(readFileSync(config, 'utf8')), outDir)
  for (const b of brands) {
    cloneAtTag(b, b.target, { token, anonymousHint: FORK_HINT })
    const head = revParseHead(b.target)
    if (head !== b.sha)
      throw new Error(`${b.name} ${b.tag} is ${head}, the pin says ${b.sha} -- the tag moved`)
    if (!existsSync(join(b.skinDir, 'primer-package.yaml')))
      throw new Error(`${b.name} ${b.tag}: no package at ${b.skinDir}`)
  }
  console.log(`BRAND_SKIN_ARGS=${brands.map((b) => `--skin ${b.skinDir}`).join(' ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
