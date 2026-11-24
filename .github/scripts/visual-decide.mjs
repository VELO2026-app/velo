#!/usr/bin/env node
// =============================================================================
// VELO CI -- is the visual comparison strict for this run? (FE-234)
//
// Strict (a changed screen fails) unless the PR carries the human-set label
// `visual-change` AND the label was put on AFTER the head commit was made.
// A label that is older than the last commit confirmed an earlier state of
// the PR, not this one: a break in a later commit must not pass on it. The
// author (or reviewer) puts the label on again after the last push.
// Unknown timing is strict: no label event, a label taken off last, a
// missing commit date.
//
// CLI (env): LABELS  JSON array of the PR's label names
//            EVENTS  NDJSON of the issue events { event, created_at, label }
//            HEAD_COMMITTED_AT  ISO date of the PR head commit
// Prints `strict=true|false`. decideStrict() is exported for the test.
// Node stdlib only.
// =============================================================================
import { pathToFileURL } from 'node:url'

export const LABEL = 'visual-change'

/** @param {{ labels: string[], events: {event: string, created_at: string, label?: string}[], headCommittedAt?: string }} input */
export function decideStrict({ labels, events, headCommittedAt }) {
  if (!labels.includes(LABEL)) return true
  const last = events
    .filter((e) => e.label === LABEL && (e.event === 'labeled' || e.event === 'unlabeled'))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .at(-1)
  if (!last || last.event !== 'labeled') return true
  const labeledAt = Date.parse(last.created_at)
  const committedAt = Date.parse(headCommittedAt ?? '')
  if (Number.isNaN(labeledAt) || Number.isNaN(committedAt)) return true
  return labeledAt < committedAt
}

function main() {
  const labels = JSON.parse(process.env.LABELS || '[]')
  const events = (process.env.EVENTS || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const strict = decideStrict({ labels, events, headCommittedAt: process.env.HEAD_COMMITTED_AT })
  console.log(`strict=${strict}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
