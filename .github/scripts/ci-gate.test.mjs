#!/usr/bin/env node
// =============================================================================
// VELO CI -- the gate waits for every job of ci.yml (FE-222)
//
// `CI — gate` is the one status of ci.yml the deploy-machine ruleset
// requires (docs/ci/deploy-machine-ruleset.md). A job missing from its
// `needs` is a job whose red merges anyway, and nothing else would notice:
// this test fails instead. Also pins what the gate itself must be -- run
// always, under its fixed name -- since the ruleset names it.
//
// Run by the scope job of ci.yml next to the classifier's test.
// Locally: node --test .github/scripts/ci-gate.test.mjs
// Node stdlib only: ci.yml is read line by line (two-space job keys under
// `jobs:`, bare or quoted, a trailing comment allowed), not parsed as YAML.
// =============================================================================
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CI = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'ci.yml')
const lines = readFileSync(CI, 'utf8').split('\n')

/** Each top-level job: its key and its lines, up to the next job. */
function jobs() {
  const start = lines.indexOf('jobs:')
  assert.ok(start >= 0, 'ci.yml has no `jobs:` block')
  const found = []
  for (const line of lines.slice(start + 1)) {
    // A job key: bare or quoted, with or without a trailing comment.
    const key = /^ {2}(["']?)([A-Za-z0-9_-]+)\1:\s*(#.*)?$/.exec(line)
    if (key) found.push({ key: key[2], body: [] })
    else if (found.length) found.at(-1).body.push(line)
  }
  return found
}

/** The `needs:` list of a job body, block form (`- name` per line). */
function needsOf(body) {
  const at = body.findIndex((l) => /^ {4}needs:\s*$/.test(l))
  assert.ok(at >= 0, 'the gate lists its needs one per line')
  const needs = []
  for (const line of body.slice(at + 1)) {
    const item = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(line)
    if (!item) break
    needs.push(item[1])
  }
  return needs
}

test('the gate needs every other job of ci.yml', () => {
  const all = jobs()
  const gate = all.find((j) => j.key === 'gate')
  assert.ok(gate, 'ci.yml has no `gate` job')
  const others = all.map((j) => j.key).filter((k) => k !== 'gate')
  // Sanity of the reading itself: the jobs this file has had since FE-204.
  for (const known of ['scope', 'lint', 'test', 'e2e-stack', 'matrix-gate']) {
    assert.ok(others.includes(known), `ci.yml read wrong: no job ${known}`)
  }
  assert.deepEqual(needsOf(gate.body).sort(), others.sort())
})

test('the gate runs always, under the name the ruleset requires', () => {
  const gate = jobs().find((j) => j.key === 'gate')
  assert.ok(gate.body.includes('    name: CI — gate'))
  assert.ok(gate.body.includes('    if: always()'))
})
