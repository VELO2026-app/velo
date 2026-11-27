#!/usr/bin/env node
// =============================================================================
// VELO CI -- every status the deploy-machine ruleset requires answers on
// every PR (FE-222)
//
// docs/ci/deploy-machine-ruleset-gate.json names the required statuses by
// their exact job names. A required status that a PR never reports waits in
// "Expected" forever, and that PR cannot merge. That happens when the job is
// renamed, gets a matrix (its name then carries the cell), moves into a
// reusable workflow (a skipped call reports under the caller's name), or its
// workflow gets a `paths` filter or a branch list without deploy-machine (a
// backend-only PR then never starts it). This test fails on each of those.
//
// A job skipped by its own `if:` is fine: GitHub reports it as "skipped"
// under the same static name, and "skipped" satisfies a required status.
//
// Run by the scope job of ci.yml next to ci-gate.test.mjs.
// Locally: node --test .github/scripts/ruleset-checks.test.mjs
// Node stdlib only: workflows are read line by line, not parsed as YAML
// (two-space keys under `on:` and `jobs:`, four-space keys inside them).
// =============================================================================
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')
const RULESET = join(ROOT, 'docs', 'ci', 'deploy-machine-ruleset-gate.json')
const GITHUB_ACTIONS_APP = 15368

const ruleset = JSON.parse(readFileSync(RULESET, 'utf8'))
const ruleOf = (type) => ruleset.rules.find((r) => r.type === type)
const required = ruleOf('required_status_checks').parameters.required_status_checks

/** The lines of a top-level block (`on:` or `jobs:`), comments dropped. */
function block(lines, key) {
  const start = lines.findIndex((l) => l === `${key}:` || l === `'${key}':` || l === `"${key}":`)
  if (start < 0) return null
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    if (/^\s*#/.test(line) || !line.trim()) continue
    out.push(line)
  }
  return out
}

/** Two-space children of a block: key -> their own lines. */
function children(lines) {
  const found = new Map()
  let current = null
  for (const line of lines) {
    const key = /^ {2}(["']?)([A-Za-z0-9_-]+)\1:(.*)$/.exec(line)
    if (key) {
      current = [key[3].replace(/#.*/, '').trim()].filter(Boolean)
      found.set(key[2], current)
    } else if (current) current.push(line)
  }
  return found
}

function workflows() {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => {
      const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
      const jobs = [...children(block(lines, 'jobs') ?? [])].map(([key, body]) => {
        const name = body.map((l) => /^ {4}name:\s*(.+?)\s*$/.exec(l)).find(Boolean)?.[1]
        return {
          key,
          name: name?.replace(/^(["'])(.*)\1$/, '$2'),
          matrix: body.some((l) => /^ {4}strategy:/.test(l)),
        }
      })
      return { file, on: children(block(lines, 'on') ?? []), jobs }
    })
}

test('the ruleset requires CI — gate, merge commits only, from GitHub Actions', () => {
  assert.ok(
    required.some((c) => c.context === 'CI — gate'),
    'CI — gate is not required',
  )
  for (const c of required) {
    assert.equal(c.integration_id, GITHUB_ACTIONS_APP, `${c.context}: not pinned to GitHub Actions`)
  }
  assert.deepEqual(ruleOf('pull_request').parameters.allowed_merge_methods, ['merge'])
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/deploy-machine'])
})

for (const { context } of required) {
  test(`"${context}" answers on every PR to deploy-machine`, () => {
    const hits = workflows().flatMap((w) =>
      w.jobs.filter((j) => j.name === context).map((j) => ({ ...j, w })),
    )
    assert.equal(hits.length, 1, `expected one job named "${context}", found ${hits.length}`)
    const [{ key, matrix, w }] = hits
    const where = `${w.file} job ${key}`
    assert.ok(!matrix, `${where}: a matrix job reports under its cell, not "${context}"`)

    const pr = w.on.get('pull_request')
    assert.ok(pr, `${where}: the workflow does not run on pull_request`)
    const keys = pr.map((l) => /^ {4}([a-z_-]+):/.exec(l)?.[1]).filter(Boolean)
    for (const filter of ['paths', 'paths-ignore', 'branches-ignore']) {
      assert.ok(!keys.includes(filter), `${where}: pull_request has \`${filter}\`, some PRs never start it`)
    }
    const branches = pr.find((l) => /^ {4}branches:/.test(l))
    if (branches) {
      assert.match(
        branches,
        /^ {4}branches:\s*\[[^\]]*\bdeploy-machine\b[^\]]*\]\s*$/,
        `${where}: pull_request branches miss deploy-machine (inline list expected)`,
      )
    }
    const types = pr.find((l) => /^ {4}types:/.test(l))
    if (types) {
      for (const t of ['opened', 'synchronize', 'reopened']) {
        assert.ok(new RegExp(`\\b${t}\\b`).test(types), `${where}: pull_request types miss ${t}`)
      }
    }
  })
}
