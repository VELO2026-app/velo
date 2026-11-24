#!/usr/bin/env node
// FE-234: when `visual-change` makes the comparison non-strict (run by the
// scope job of ci.yml). Locally: node --test .github/scripts/visual-decide.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideStrict } from './visual-decide.mjs'

const COMMIT = '2026-11-24T10:00:00Z'
const labeled = (at) => ({ event: 'labeled', created_at: at, label: 'visual-change' })
const unlabeled = (at) => ({ event: 'unlabeled', created_at: at, label: 'visual-change' })
const decide = (labels, events) => decideStrict({ labels, events, headCommittedAt: COMMIT })

test('no label: strict', () => {
  assert.equal(decide([], []), true)
  assert.equal(decide(['bundle-growth'], [labeled('2026-11-24T11:00:00Z')]), true)
})

test('label put on after the head commit: not strict', () => {
  assert.equal(decide(['visual-change'], [labeled('2026-11-24T10:05:00Z')]), false)
})

test('label older than the head commit (a later push): strict again', () => {
  assert.equal(decide(['visual-change'], [labeled('2026-11-24T09:00:00Z')]), true)
})

test('taken off and put on again after the push: not strict', () => {
  const events = [
    labeled('2026-11-24T09:00:00Z'),
    unlabeled('2026-11-24T09:30:00Z'),
    labeled('2026-11-24T10:30:00Z'),
  ]
  assert.equal(decide(['visual-change'], events), false)
})

test('the label taken off last, or unknown timing: strict', () => {
  assert.equal(
    decide(['visual-change'], [labeled('2026-11-24T10:30:00Z'), unlabeled('2026-11-24T10:40:00Z')]),
    true,
  )
  assert.equal(decide(['visual-change'], []), true)
  assert.equal(
    decideStrict({ labels: ['visual-change'], events: [labeled('2026-11-24T10:30:00Z')] }),
    true,
  )
})

test('events of other labels are ignored', () => {
  const other = { event: 'labeled', created_at: '2026-11-24T10:50:00Z', label: 'bundle-growth' }
  assert.equal(decide(['visual-change'], [labeled('2026-11-24T09:00:00Z'), other]), true)
})
