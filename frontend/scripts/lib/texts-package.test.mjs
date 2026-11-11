// FE-133 -- texts package check (node:test; part of `pnpm test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import primer from './texts-package.mjs'
import { readBaseTexts } from '../export-base-texts.mjs'
import { validateTexts } from '../validate-texts.mjs'

const MANIFEST = 'schema: 1\ncontract: "1.0"\n'
const BASE = {
  ru: {
    common: { save: 'Сохранить', group: { a: 'b' } },
    dates: { shortMonths: ['янв', 'фев'] },
    brand: 'x',
  },
  en: { common: { save: 'Save' } },
}

/** A package and its base on disk; `files` are the package's. */
function check(files, base = BASE) {
  const root = mkdtempSync(join(tmpdir(), 'texts-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, 'pkg', rel)), { recursive: true })
      writeFileSync(join(root, 'pkg', rel), body)
    }
    mkdirSync(join(root, 'pkg'), { recursive: true })
    mkdirSync(join(root, 'base'))
    for (const [lang, messages] of Object.entries(base))
      writeFileSync(join(root, 'base', `${lang}.json`), JSON.stringify(messages))
    return primer.checkTexts(join(root, 'pkg'), join(root, 'base'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const OK = { 'primer-package.yaml': MANIFEST, 'ui/ru.json': '{"common":{"save":"Принять"}}' }
const ui = (body) => ({ ...OK, 'ui/ru.json': body })
const problemsOf = (files) => check(files).problems.join('\n')

test('a valid package passes', () => {
  const r = check(OK)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.warnings, [])
})

test('manifest: missing, bad schema, range instead of point, wrong major, unreadable', () => {
  assert.match(check({ 'ui/ru.json': '{}' }).problems.join('\n'), /primer-package\.yaml: missing/)
  const m = (body) => problemsOf({ ...OK, 'primer-package.yaml': body })
  assert.match(m('schema: 2\ncontract: "1.0"\n'), /schema must be 1/)
  assert.match(m('schema: 1\ncontract: ">=1,<2"\n'), /quoted point/)
  assert.match(m('schema: 1\ncontract: "2.0"\n'), /reads contract 1\.x/)
  assert.match(m('not a mapping'), /cannot read the line/)
})

test('parseManifest reads comments, BOM and CRLF', () => {
  const r = primer.parseManifest('﻿# c\r\nschema: 1 # x\r\ncontract: "1.2"\r\n')
  assert.deepEqual(r.fields, { schema: '1', contract: '"1.2"' })
})

test('a language outside the base texts is refused', () => {
  assert.match(
    problemsOf({ ...OK, 'ui/de.json': '{}' }),
    /language de is not one of the product's: en, ru/,
  )
})

test('a missing base is the product problem, reported', () => {
  assert.match(check(OK, {}).problems.join('\n'), /the product's base texts are not here/)
})

test('ui json: invalid JSON, non-object, non-string leaf, forbidden and dotted keys', () => {
  assert.match(problemsOf(ui('{')), /not valid JSON/)
  assert.match(problemsOf(ui('[]')), /JSON object/)
  assert.match(
    problemsOf(ui('{"common":{"save":1}}')),
    /common\.save: a text is a string, not number/,
  )
  assert.match(problemsOf(ui('{"common":{"__proto__":{"a":"x"}}}')), /not __proto__/)
  assert.match(problemsOf(ui('{"common":{"":"x"}}')), /non-empty/)
  assert.match(problemsOf(ui('{"common":{"a.b":"x"}}')), /no dot/)
})

test('the shape of an override is the shape of the base', () => {
  assert.match(problemsOf(ui('{"common":"flat"}')), /common: a message where the base has a group/)
  assert.match(
    problemsOf(ui('{"common":{"save":{"x":"y"}}}')),
    /common\.save: a group where the base has a message/,
  )
  assert.match(
    problemsOf(ui('{"dates":{"shortMonths":["a"]}}')),
    /a list of 1 where the base has 2/,
  )
  assert.match(
    problemsOf(ui('{"dates":{"shortMonths":"x"}}')),
    /a message where the base has a array/,
  )
})

test('an array of strings is allowed where the base has one', () => {
  assert.deepEqual(check(ui('{"dates":{"shortMonths":["a","b"]}}')).problems, [])
  assert.match(
    problemsOf(ui('{"dates":{"shortMonths":["a",2]}}')),
    /shortMonths\.1: a text is a string/,
  )
})

test('the brand is a skin property: the root key brand is refused', () => {
  assert.match(problemsOf(ui('{"brand":"Goodo"}')), /brand: the brand is a skin property/)
  // a nested key called brand is wording like any other
  assert.deepEqual(check(ui('{"common":{"brand":"x"}}')).problems, [])
})

test('texts are plain: markup, control characters and a long string are refused', () => {
  assert.match(problemsOf(ui('{"common":{"save":"<b>x</b>"}}')), /has markup/)
  assert.match(problemsOf(ui('{"common":{"save":"a\\u0001b"}}')), /control character/)
  assert.match(problemsOf(ui(`{"common":{"save":"${'x'.repeat(2001)}"}}`)), /longer than 2000/)
  assert.deepEqual(check(ui('{"common":{"save":"a < b, {n} | c\\nd"}}')).problems, [])
})

test('nesting depth is capped', () => {
  let doc = '"x"'
  for (let i = 0; i < 12; i++) doc = `{"k":${doc}}`
  assert.match(problemsOf(ui(doc)), /nested deeper/)
})

test('foreign files and traversal are refused; comms files are kept, never read', () => {
  const r = problemsOf({
    ...OK,
    'index.js': '1',
    'ui/ru.json.bak': '{}',
    'comms/templates/ru.yaml': '\0',
  })
  assert.match(r, /index\.js: not a file of the texts format/)
  assert.match(r, /ui\/ru\.json\.bak: not a file/)
  assert.doesNotMatch(r, /comms\/templates/)
})

test('a symlink and an executable file are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'texts-'))
  try {
    mkdirSync(join(root, 'pkg/ui'), { recursive: true })
    mkdirSync(join(root, 'pkg/comms'))
    mkdirSync(join(root, 'base'))
    writeFileSync(join(root, 'base/ru.json'), '{}')
    writeFileSync(join(root, 'pkg/primer-package.yaml'), MANIFEST)
    symlinkSync('/etc/hosts', join(root, 'pkg/ui/ru.json'))
    writeFileSync(join(root, 'pkg/comms/x.sh'), '#!/bin/sh')
    chmodSync(join(root, 'pkg/comms/x.sh'), 0o755)
    const text = primer.checkTexts(join(root, 'pkg'), join(root, 'base')).problems.join('\n')
    assert.match(text, /ui\/ru\.json: a symlink/)
    assert.match(text, /comms\/x\.sh: executable/)
    assert.match(
      primer.checkTexts(join(root, 'nope'), join(root, 'base')).problems.join('\n'),
      /nope: not a directory/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dead keys warn, never fail', () => {
  const r = check(ui('{"common":{"save":"Ок","gone":"x"},"extra":{"a":"b"}}'))
  assert.deepEqual(r.problems, [])
  assert.equal(r.warnings.length, 2)
  assert.match(r.warnings.join('\n'), /common\.gone: not in the base texts/)
})

test('a package without ui/ (comms only) passes', () => {
  const r = check({ 'primer-package.yaml': MANIFEST, 'comms/templates/ru.yaml': 'x: y' })
  assert.deepEqual(r.problems, [])
})

test('the real base texts: an override of every kind of message passes', () => {
  const real = readBaseTexts(join(import.meta.dirname, '../../src/locales'))
  assert.deepEqual(Object.keys(real).sort(), ['en', 'ru', 'uk'])
  const root = mkdtempSync(join(tmpdir(), 'texts-'))
  try {
    mkdirSync(join(root, 'pkg/ui'), { recursive: true })
    writeFileSync(join(root, 'pkg/primer-package.yaml'), MANIFEST)
    const months = real.ru.dates.shortMonths.map((m) => `${m}.`)
    writeFileSync(join(root, 'pkg/ui/ru.json'), JSON.stringify({ dates: { shortMonths: months } }))
    const r = validateTexts(join(root, 'pkg'))
    assert.deepEqual(r.problems, [])
    assert.deepEqual(r.warnings, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
