#!/usr/bin/env node
// FE-234: the brand pins are well-formed (run by the scope job of ci.yml).
// Locally: node --test .github/scripts/fetch-brand-skins.test.mjs
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloneEnv, cloneFailure, cloneUrl, planBrands } from './fetch-brand-skins.mjs'

const config = JSON.parse(readFileSync(new URL('../brand-skins.json', import.meta.url), 'utf8'))

test('the committed pins plan one package dir per brand', () => {
  const plan = planBrands(config, '/out')
  assert.deepEqual(
    plan.map((b) => b.skinDir),
    ['/out/velo-brand/skin', '/out/goodo-brand/skin'],
  )
})

test('a malformed pin throws instead of dropping a brand', () => {
  const bad = {
    brands: {
      x: { repo: 'a/b', tag: 'main', sha: 'f'.repeat(40), dir: 'skin' },
    },
  }
  assert.throws(() => planBrands(bad, '/out'), /bad tag/)
  assert.throws(() => planBrands({ brands: {} }, '/out'), /no brands/)
})

test('the token never goes in the URL; it is a header in the environment', () => {
  assert.equal(cloneUrl('a/b'), 'https://github.com/a/b.git')
  const env = cloneEnv('tok', {})
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert.match(env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /)
  assert.equal(cloneEnv('', {}).GIT_CONFIG_COUNT, undefined)
})

test('a failed clone tells what to do and never prints the token', () => {
  const brand = { name: 'x', repo: 'a/b', tag: 'v1.0.0' }
  const basic = Buffer.from('x-access-token:s3cret').toString('base64')
  const withToken = cloneFailure(brand, `fatal: s3cret ${basic}`, 's3cret')
  assert.ok(!withToken.includes('s3cret') && !withToken.includes(basic))
  assert.match(cloneFailure(brand, 'fatal: not found'), /private: set the BRAND_REPO_TOKEN/)
})
