// =============================================================================
// FE-234 item 6 -- the skin packages of the Figma modes, at their pinned commit
// =============================================================================
//
// The pins live in .github/brand-skins.json (one pin per brand: tag AND
// commit; CI builds and shoots the same packages). This module gets one
// package onto disk for sync-figma-variables.mjs:
//   - fetchPackage: a shallow clone at the tag, the commit checked. A token
//     (BRAND_REPO_TOKEN, a private repo) travels as an HTTP header through
//     GIT_CONFIG_* -- never in the URL, so never in .git/config or a log;
//     GIT_TERMINAL_PROMPT=0 so a missing credential fails instead of waiting.
//   - checkoutProblem: a local checkout (--pkg) must be the pinned commit
//     with a clean tree -- an uncommitted edit is not the pinned package.
// cloneEnv / cloneFailure repeat .github/scripts/fetch-brand-skins.mjs (the
// CI side, FE-234 items 1-5a); one shared module is a follow-up after both PRs.
// =============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'

/** The caller's environment without GIT_* (a git hook's GIT_DIR / GIT_INDEX_FILE would aim our
 *  git calls at the caller's repository). */
function withoutGit(base) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('GIT_')))
}

/** The environment of a clone: no prompt; a token as a basic-auth header. */
export function cloneEnv(token = '', base = process.env) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...withoutGit(base), GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`
  }
  return env
}

/** git's error text with the token (plain and base64) masked. */
function masked(text, token) {
  if (!token) return text
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return text.split(token).join('***').split(basic).join('***')
}

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: withoutGit(process.env),
  }).trim()

/**
 * What keeps a local checkout from being the pinned package, or null.
 *
 * @param {string} dir the checkout (the repository root, not its skin/ dir)
 * @param {string} sha the pinned commit
 */
export function checkoutProblem(dir, sha) {
  let head
  try {
    head = git(dir, 'rev-parse', 'HEAD')
  } catch {
    return `${dir} is not a git checkout: the pinned commit cannot be checked`
  }
  if (head !== sha) return `${dir}: HEAD is ${head}, the pin is ${sha}`
  if (git(dir, 'status', '--porcelain') !== '')
    return `${dir} has uncommitted changes: it is not the pinned package`
  return null
}

/**
 * Clone a pinned package and check its commit. Throws an Error whose message
 * never carries the token.
 *
 * @param {{name: string, repo: string, tag: string, sha: string}} pin
 * @param {string} target an empty directory path
 * @param {{token?: string, url?: string}} [opts] url: the clone source (default the GitHub repo; a test passes a local path)
 */
export function fetchPackage(pin, target, opts = {}) {
  const token = opts.token ?? ''
  const url = opts.url ?? `https://github.com/${pin.repo}.git`
  const r = spawnSync(
    'git',
    [
      '-c',
      'advice.detachedHead=false',
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      pin.tag,
      url,
      target,
    ],
    { env: cloneEnv(token), encoding: 'utf8' },
  )
  if (r.status !== 0) {
    const hint = token
      ? 'the tag may be missing, or BRAND_REPO_TOKEN cannot read the repository'
      : 'a private repository needs git credentials or BRAND_REPO_TOKEN; or the tag is missing; or pass --pkg <mode>=<checkout>'
    throw new Error(
      `${pin.name}: cannot clone ${pin.repo} at ${pin.tag} -- ${hint}\n${masked(String(r.stderr ?? '').trim(), token)}`,
    )
  }
  const head = git(target, 'rev-parse', 'HEAD')
  if (head !== pin.sha)
    throw new Error(`${pin.name} ${pin.tag} is ${head}, the pin is ${pin.sha}: the tag moved`)
}
