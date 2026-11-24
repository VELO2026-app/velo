// =============================================================================
// FE-239 -- the ONE brand-repository clone
// =============================================================================
//
// Two tools clone the brand skin packages at their pinned tags
// (.github/brand-skins.json): the CI fetcher
// (.github/scripts/fetch-brand-skins.mjs, the build matrix and Visual) and the
// Figma variables sync (scripts/sync-figma-variables.mjs through
// scripts/lib/brand-packages.mjs) clone through this one module:
//   - the clone URL: the token never goes in it (a URL with a token lands in
//     .git/config and in git's messages);
//   - an environment a git hook cannot divert: the repository-local variables
//     of `git rev-parse --local-env-vars` go (a pre-push test run once aimed
//     git at the hook's repository and corrupted it), the ways to reach
//     a remote (GIT_ASKPASS, GIT_SSH_COMMAND) stay;
//   - a private repository's key (BRAND_REPO_TOKEN) as an HTTP header through
//     GIT_CONFIG_* -- never in a URL or a file -- and no password prompt;
//   - the failure text: the caller's hint, never the token.
//   - the check that the tag still points at the pinned commit.
// The wording that differs by caller (the hint without a key, the moved-tag
// message) stays with the callers.
//
// Node stdlib only: .github/scripts imports this before pnpm install.
// The test is brand-git.test.mjs (vitest, the `scripts` project).
// =============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'

/** The https URL of a repository. The token never goes in it: a URL with a
 *  token lands in .git/config and in git's messages. */
export function cloneUrl(repo) {
  return `https://github.com/${repo}.git`
}

/** The variables that pin git to ONE repository (`git rev-parse
 *  --local-env-vars`). A hook (pre-push, pre-commit) exports some of them;
 *  git run with them aims at the hook's repository, not at the clone. */
const LOCAL_ENV_FALLBACK = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]

/** @type {Set<string> | null} */
let localVars = null

/** The local-repository variables, asked of git itself (the list grows with
 *  git) and cached, the fixed list as the fallback if git cannot answer.
 *  GIT_ASKPASS, GIT_SSH_COMMAND and the like are not in it: they are the
 *  user's way to reach a remote. */
function localEnvVars() {
  if (localVars) return localVars
  const asked = spawnSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GIT_DIR')),
  })
  const names = asked.status === 0 ? asked.stdout.split('\n').filter(Boolean) : []
  localVars = new Set([...LOCAL_ENV_FALLBACK, ...names])
  return localVars
}

/** The caller's environment without git's repository-local variables (see
 *  localEnvVars): a git hook exports them, and they would aim our git calls
 *  at the caller's repository. Credential helpers and the global config stay.
 *  Every git call of this module and of its callers goes through this. */
export function gitEnv(base = process.env) {
  const env = { ...base }
  for (const name of localEnvVars()) delete env[name]
  return env
}

/** The git environment of a clone: no prompt for a password (a private
 *  repository without a key must fail, not hang) and, with a token, an
 *  Authorization header for github.com only, passed through the environment
 *  (GIT_CONFIG_*), so .git/config of the clone never holds it. */
export function cloneEnv(token = '', base = process.env) {
  // The token header is set AFTER the strip: GIT_CONFIG_COUNT is itself one
  // of the stripped variables.
  /** @type {Record<string, string | undefined>} */
  const env = { ...gitEnv(base), GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`
  }
  return env
}

/** The token (plain and its base64 header form) cut out of any text. */
function maskSecret(text, token = '') {
  if (!token) return String(text)
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return String(text).split(token).join('***').split(basic).join('***')
}

/** What a failed clone with a key says: both callers use the same sentence. */
const TOKEN_HINT = 'the tag may be missing, or BRAND_REPO_TOKEN cannot read the repository'

/**
 * The error text of a failed clone: what to do, never the token (nor its
 * header form), whatever git printed. Without a key the hint is the caller's:
 * the CI workflow tells about fork PRs, the sync tool about its --pkg escape.
 *
 * @param {{name: string, repo: string, tag: string}} pin
 * @param {string} stderr what git printed
 * @param {{token?: string, anonymousHint: string}} opts
 */
export function cloneFailure(pin, stderr, opts) {
  const token = opts.token ?? ''
  const hint = token ? TOKEN_HINT : opts.anonymousHint
  return `${pin.name}: cannot clone ${pin.repo} at ${pin.tag} -- ${hint}\n${maskSecret(stderr.trim(), token)}`
}

/** The head commit of a checkout, through the cleaned environment: a git
 *  hook's GIT_DIR would answer for its own repository. */
function revParseHead(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: gitEnv(),
  }).trim()
}

/**
 * Clone a brand repository at its pinned tag into `target` and check that the
 * tag still points at the pinned commit. Throws the cloneFailure text when the
 * clone fails, `movedMessage(head)` when the commit differs.
 *
 * @param {{name: string, repo: string, tag: string}} pin
 * @param {string} target an empty directory path
 * @param {{token?: string, url?: string, anonymousHint: string, expectSha: string, movedMessage: (head: string) => string}} opts
 *   url: the clone source (default the GitHub repo; a test passes a local path)
 */
export function cloneAtTag(pin, target, opts) {
  const token = opts.token ?? ''
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
      pin.tag,
      opts.url ?? cloneUrl(pin.repo),
      target,
    ],
    { env: cloneEnv(token), encoding: 'utf8' },
  )
  if (clone.status !== 0)
    throw new Error(
      cloneFailure(pin, clone.stderr ?? '', { token, anonymousHint: opts.anonymousHint }),
    )
  const head = revParseHead(target)
  if (head !== opts.expectSha) throw new Error(opts.movedMessage(head))
}
