#!/usr/bin/env node
/**
 * Gate: a hand-written `export interface|type X` in `src/api/*.ts` is forbidden
 * when `src/api/generated.ts` already exports X.
 *
 * Why: a hand copy silently drifts from the backend schema (FE-157). Import the
 * generated type (re-export it through `types.ts`) instead of redeclaring it.
 * `generated.ts` itself and `*.test.ts` files are skipped.
 *
 * Usage: node scripts/api-type-dupes.mjs [apiDir]   (exit 1 on any duplicate)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const apiDir = resolve(process.argv[2] ?? join(here, '..', 'src', 'api'))

const DECL = /^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm

/** Collect names declared by `export interface|type` in a source text. */
function declaredNames(text) {
  return [...text.matchAll(DECL)].map((m) => m[1])
}

const generated = new Set(declaredNames(readFileSync(join(apiDir, 'generated.ts'), 'utf8')))

const offenders = []
for (const file of readdirSync(apiDir)) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'generated.ts') continue
  for (const name of declaredNames(readFileSync(join(apiDir, file), 'utf8'))) {
    if (generated.has(name)) offenders.push(`${file}: ${name}`)
  }
}

if (offenders.length > 0) {
  console.error('api-type-dupes: hand-written types duplicate generated.ts exports:')
  for (const o of offenders) console.error(`  - src/api/${o}`)
  console.error('Delete the copy and re-export the generated type instead.')
  process.exit(1)
}
console.log(`api-type-dupes: ok (${generated.size} generated types, no duplicates)`)
