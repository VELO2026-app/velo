// =============================================================================
// FE-234 item 6 -- the skin packages of the Figma modes, at their pinned commit
// =============================================================================
//
// The pins live in .github/brand-skins.json (one pin per brand: tag AND
// commit; CI builds and shoots the same packages). The clone machinery --
// the environment, the token, the failure text -- is FE-239's shared
// scripts/lib/brand-git.mjs (this file kept its own copy until both PRs
// landed). What stays here is this tool's own contract:
//   - fetchPackage: a clone at the tag, the commit checked, this tool's hint
//     and wording (the hint names --pkg, the CI's names the fork secret).
//   - checkoutProblem: a local checkout (--pkg) must be the pinned commit
//     with a clean tree -- an uncommitted edit is not the pinned package.
// =============================================================================
import { execFileSync } from 'node:child_process'
import { cloneAtTag, gitEnv, revParseHead } from './brand-git.mjs'

/** What a failed clone without a key says here: this is a local tool -- the
 *  escape hatch is --pkg <mode>=<checkout>, not a CI secret. */
const ANON_HINT =
  'a private repository needs git credentials or BRAND_REPO_TOKEN; or the tag is missing; or pass --pkg <mode>=<checkout>'

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(process.env),
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
  cloneAtTag(pin, target, { ...opts, anonymousHint: ANON_HINT })
  const head = revParseHead(target)
  if (head !== pin.sha)
    throw new Error(`${pin.name} ${pin.tag} is ${head}, the pin is ${pin.sha}: the tag moved`)
}
