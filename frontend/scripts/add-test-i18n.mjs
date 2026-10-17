#!/usr/bin/env node
// =============================================================================
// tz-i18n phase 2, step 1 (ONE-SHOT codemod)
// =============================================================================
//
// Gives every raw `createApp(...)` test mount the i18n plugin:
//   createApp(X)            -> createApp(X).use(createTestI18n())
//
// Skipped:
//   - files that already mention createTestI18n (idempotent re-runs).
// NOTE (round 2): files importing @vue/test-utils are NOT skipped anymore --
// several of them ALSO mount via raw createApp(), and those mounts do NOT
// receive config.global.plugins from test-setup.
//
// app.use() returns the app, so the chain keeps every following `app.use(...)`
// / `app.mount(...)` line working unchanged.
//
// Run: node scripts/add-test-i18n.mjs
// =============================================================================

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname
const IMPORT_LINE = "import { createTestI18n } from '@/locales/testing'"

const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.test.ts')) files.push(p)
  }
})(SRC)

let touched = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes('createApp(')) continue
  if (src.includes('createTestI18n')) continue

  let out = ''
  let i = 0
  let count = 0
  for (;;) {
    const idx = src.indexOf('createApp(', i)
    if (idx === -1) {
      out += src.slice(i)
      break
    }
    // Match the closing paren of this createApp( call.
    let depth = 0
    let j = idx + 'createApp'.length
    for (; j < src.length; j++) {
      const ch = src[j]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    out += src.slice(i, j) + '.use(createTestI18n())'
    count++
    i = j
  }
  if (count === 0) continue

  const lines = out.split('\n')
  const firstImport = lines.findIndex((l) => /^import\b/.test(l))
  lines.splice(firstImport === -1 ? 0 : firstImport, 0, IMPORT_LINE)
  writeFileSync(file, lines.join('\n'))
  touched++
  console.log(`${file}: ${count} mount(s)`)
}
console.log(`done: ${touched} files touched`)
