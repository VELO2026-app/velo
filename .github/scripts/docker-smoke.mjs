#!/usr/bin/env node
// =============================================================================
// VELO CI -- smoke test of the built frontend IMAGE (FE-159).
//
// The other jobs check the app as vite builds it; nothing checked the image
// the machine actually runs -- the Dockerfile's COPY paths and pnpm filter,
// the nginx config, the entrypoint scripts and the /config.json template.
// The stand fell three times on exactly that (05-07.11). This script starts
// the image the way the machine does (environment only, `app` resolvable for
// the /api proxy_pass) and asserts what the machine relies on:
//
//   /config.json          -- every declared key rendered from the environment
//                            under its primer.yaml name, nothing left as
//                            ${...}, no `brand` (a skin property since 09.11),
//                            no key beyond the declared set. A renamed env
//                            var (DEFAULT_LOCALE -> DEFAULT_LANGUAGE, FE-158)
//                            shows up as an empty or unrendered value. The
//                            six option flags OPTION_<O> land in the
//                            `options` block (FE-151), on AND off.
//   /                     -- 200, the SPA's index.html.
//   /health, /ready       -- 404: closed in this container (protocol 9.3).
//   /manifest.webmanifest -- lang of the instance (FE-155), not the golden 'ru'.
//   /build-info.json      -- the release/commit the build was given.
//
// Node stdlib + the docker CLI only.
// Usage: node .github/scripts/docker-smoke.mjs <image> [expected-commit] [expected-release]
// =============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [image, expectedCommit, expectedRelease] = process.argv.slice(2)
if (!image) {
  console.error('usage: docker-smoke.mjs <image> [expected-commit] [expected-release]')
  process.exit(2)
}

// The instance environment. Every value differs from any golden default, so
// a value that did not come from HERE cannot pass. DEFAULT_LANGUAGE is 'en'
// because the golden manifest is 'ru'. The option flags (FE-151) mix 'true'
// and 'false': the golden build is every option on, and a flag rendered into
// the wrong key cannot pass both ways.
const ENV = {
  API_BASE_URL: 'api.example.test',
  TELEGRAM_BOT_URL: 'https://t.me/velo_ci_smoke_bot',
  DEFAULT_LANGUAGE: 'en',
  LANGUAGES: 'en,ru',
  OPTION_PAYMENTS: 'false',
  OPTION_SCHOOLS: 'true',
  OPTION_MCP: 'false',
  OPTION_ZOOM: 'true',
  OPTION_TELEGRAM: 'true',
  OPTION_LLM: 'false',
}
// config.json key -> the env var it must carry (nginx/config.json.template).
// A dotted key is a key inside a block: `options.payments` is
// config.options.payments.
const CONFIG = {
  apiBaseUrl: 'API_BASE_URL',
  telegramBotUrl: 'TELEGRAM_BOT_URL',
  defaultLocale: 'DEFAULT_LANGUAGE',
  locales: 'LANGUAGES',
  'options.payments': 'OPTION_PAYMENTS',
  'options.schools': 'OPTION_SCHOOLS',
  'options.mcp': 'OPTION_MCP',
  'options.zoom': 'OPTION_ZOOM',
  'options.telegram': 'OPTION_TELEGRAM',
  'options.llm': 'OPTION_LLM',
}
// The value at a dotted CONFIG key, or undefined.
const at = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
// The keys CONFIG declares at one level: '' -> the top level, 'options' -> the block.
const declared = (prefix) =>
  new Set(
    Object.keys(CONFIG)
      .filter((k) => (prefix ? k.startsWith(`${prefix}.`) : true))
      .map((k) => (prefix ? k.slice(prefix.length + 1) : k).split('.')[0]),
  )

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(what)
}

const name = `velo-frontend-smoke-${process.pid}`
const envArgs = Object.entries(ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`])
// --add-host: nginx resolves the /api upstream (`app`) at start; without it
// the container exits before serving anything. Random host port: the script
// also runs on a developer machine where 3000 may be taken.
docker('run', '-d', '--name', name, '--add-host', 'app:127.0.0.1', ...envArgs, '-p', '127.0.0.1::3000', image)

// Ctrl-C / a cancelled job must not leave the container behind.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    spawnSync('docker', ['rm', '-f', name])
    process.exit(130)
  })
}

let exitCode = 1
try {
  const base = `http://${docker('port', name, '3000/tcp').split('\n')[0]}`
  console.log(`container ${name} on ${base}\n`)

  // Wait for nginx: the entrypoint scripts run first.
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })
      up = true
    } catch {
      if (docker('inspect', '-f', '{{.State.Running}}', name) !== 'true') break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!up) throw new Error('the container never served HTTP (see its log below)')

  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
  }
  const json = (body) => {
    try {
      return JSON.parse(body)
    } catch {
      return undefined
    }
  }

  // --- /config.json ---------------------------------------------------------
  const cfg = await get('/config.json')
  check(cfg.status === 200, `/config.json -> 200 (got ${cfg.status})`)
  check(!cfg.body.includes('${'), '/config.json has no unrendered ${...}')
  const config = json(cfg.body)
  check(config !== undefined && typeof config === 'object', '/config.json is valid JSON')
  if (config) {
    for (const [key, env] of Object.entries(CONFIG)) {
      check(at(config, key) === ENV[env], `config.${key} = $${env} (${JSON.stringify(ENV[env])}; got ${JSON.stringify(at(config, key))})`)
    }
    check(!('brand' in config), 'config has no `brand`')
    const top = declared('')
    const extra = Object.keys(config).filter((k) => !top.has(k))
    check(extra.length === 0, `config has no undeclared keys${extra.length ? ` (got ${extra.join(', ')})` : ''}`)
    const options = config.options && typeof config.options === 'object' ? config.options : {}
    const known = declared('options')
    const extraOptions = Object.keys(options).filter((k) => !known.has(k))
    check(
      extraOptions.length === 0,
      `config.options has no undeclared options${extraOptions.length ? ` (got ${extraOptions.join(', ')})` : ''}`,
    )
  }

  // --- / and the SPA --------------------------------------------------------
  const root = await get('/')
  check(root.status === 200, `/ -> 200 (got ${root.status})`)
  check(root.type.startsWith('text/html') && root.body.includes('id="app"'), '/ serves the SPA index.html')

  // --- health endpoints are closed here -------------------------------------
  for (const path of ['/health', '/ready']) {
    const r = await get(path)
    check(r.status === 404, `${path} -> 404 (got ${r.status})`)
  }

  // --- manifest: instance language (FE-155) ---------------------------------
  const man = await get('/manifest.webmanifest')
  const manifest = json(man.body)
  check(man.status === 200, `/manifest.webmanifest -> 200 (got ${man.status})`)
  check(
    manifest?.lang === ENV.DEFAULT_LANGUAGE,
    `manifest.lang = $DEFAULT_LANGUAGE (${ENV.DEFAULT_LANGUAGE}; got ${JSON.stringify(manifest?.lang)})`,
  )

  // --- build identity -------------------------------------------------------
  const info = json((await get('/build-info.json')).body)
  check(typeof info?.release === 'string' && info.release !== '', `build-info.json has a release (got ${JSON.stringify(info?.release)})`)
  if (expectedRelease) {
    check(info?.release === expectedRelease, `build-info.json release = ${expectedRelease} (got ${JSON.stringify(info?.release)})`)
  }
  if (expectedCommit) {
    check(info?.commit === expectedCommit, `build-info.json commit = ${expectedCommit} (got ${JSON.stringify(info?.commit)})`)
  }

  exitCode = failures.length ? 1 : 0
} catch (err) {
  failures.push(String(err?.message ?? err))
  console.error(`\nFAIL  ${err?.message ?? err}`)
} finally {
  if (exitCode !== 0) {
    console.error('\n--- container log ---')
    // nginx logs to both streams; keep both.
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
    console.error(`${logs.stdout ?? ''}${logs.stderr ?? ''}`)
  }
  try {
    docker('rm', '-f', name)
  } catch {
    // already gone
  }
}

const summary = failures.length ? `${failures.length} check(s) failed` : 'all checks passed'
console.log(`\n${summary}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Image smoke: ${summary}\n\n${failures.map((f) => `- ${f}`).join('\n')}\n`,
  )
}
process.exit(exitCode)
