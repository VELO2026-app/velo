#!/usr/bin/env node
// =============================================================================
// VELO CI -- fetch the brand skin packages at their pinned tags (FE-234)
//
// Reads .github/brand-skins.json (repo, tag, commit, package dir per brand),
// clones each repository at its tag into <out-dir>/<brand>, checks that the
// tag still points at the pinned commit, and prints one line for
// $GITHUB_ENV:  BRAND_SKIN_ARGS=--skin <out-dir>/<brand>/<dir> ...
// (the form scripts/build-matrix.mjs takes).
//
// A private brand repository needs a read key: set BRAND_REPO_TOKEN (the
// workflows pass the secret of that name; empty = anonymous, enough while the
// repositories are public). The key is the owner's decision (FE-234). It
// reaches git as a header in the environment, never in a URL or a file.
//
// Usage: node .github/scripts/fetch-brand-skins.mjs <out-dir> [--config <brand-skins.json>]
//        --config  another pin file (the Visual job reads the base's own pins)
// Node stdlib only. planBrands(), cloneUrl(), cloneEnv() and cloneFailure() are exported for the test.
// =============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand-skins.json')

/** The https URL of a repository. The token never goes in it: a URL with a
 *  token lands in .git/config and in git's messages. */
export function cloneUrl(repo) {
  return `https://github.com/${repo}.git`
}

/** The git environment of a clone: no prompt for a password (a private
 *  repository without a key must fail, not hang) and, with a token, an
 *  Authorization header for github.com only, passed through the environment
 *  (GIT_CONFIG_*), so .git/config of the clone never holds it. */
export function cloneEnv(token = '', base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`
  }
  return env
}

/** The error text of a failed clone: what to do, never the token (nor its
 *  header form), whatever git printed. */
export function cloneFailure(brand, stderr, token = '') {
  let detail = String(stderr).trim()
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    detail = detail.split(token).join('***').split(basic).join('***')
  }
  const hint = token
    ? 'the tag may be missing, or BRAND_REPO_TOKEN cannot read the repository'
    : 'the repository may be private: set the BRAND_REPO_TOKEN secret (read access), or the tag is missing. Secrets are not passed to pull requests from forks'
  return `${brand.name}: cannot clone ${brand.repo} at ${brand.tag} -- ${hint}\n${detail}`
}

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
    const clone = spawnSync(
      'git',
      [
        '-c',
        'advice.detachedHead=false',
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        b.tag,
        cloneUrl(b.repo),
        b.target,
      ],
      { env: cloneEnv(token), encoding: 'utf8' },
    )
    if (clone.status !== 0) throw new Error(cloneFailure(b, clone.stderr ?? '', token))
    const head = execFileSync('git', ['-C', b.target, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    if (head !== b.sha)
      throw new Error(`${b.name} ${b.tag} is ${head}, the pin says ${b.sha} -- the tag moved`)
    if (!existsSync(join(b.skinDir, 'primer-package.yaml')))
      throw new Error(`${b.name} ${b.tag}: no package at ${b.skinDir}`)
  }
  console.log(`BRAND_SKIN_ARGS=${brands.map((b) => `--skin ${b.skinDir}`).join(' ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
