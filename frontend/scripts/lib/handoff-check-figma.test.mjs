// =============================================================================
// The designer's handoff check (docs/figma/velo-figma-designer/scripts/
// handoff-check.figma.js) and token search (similar-tokens.figma.js) against a
// minimal fake of the plugin API (Vitest, the `scripts` project).
// Pins the rule: a raw colour / spacing value passes only as a warning, and only when
// the `Новое` note links a token request (FE-NNN) in an approved or done status.
// =============================================================================
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { runInNewContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const script = (name) =>
  readFileSync(join(root, 'docs/figma/velo-figma-designer/scripts', name), 'utf8')
const CHECK = script('handoff-check.figma.js')
const SIMILAR = script('similar-tokens.figma.js')

let ids = 0
class Node {
  constructor(type, name, props = {}) {
    this.id = `n:${++ids}`
    this.type = type
    this.name = name
    this.parent = null
    this.children = []
    this.visible = true
    this.data = {}
    Object.assign(this, { width: 10, height: 10, fills: [], strokes: [] }, props)
  }
  appendChild(c) {
    c.parent = this
    this.children.push(c)
    return c
  }
  getPluginData(k) {
    return this.data[k] || ''
  }
  findAll(fn) {
    const out = []
    const walk = (n) => n.children.forEach((c) => (fn(c) && out.push(c), walk(c)))
    walk(this)
    return out
  }
}

const rgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
  ...(hex.length > 7 ? { a: parseInt(hex.slice(7, 9), 16) / 255 } : {}),
})
const solid = (hex) => ({ type: 'SOLID', color: rgb(hex) })

/**
 * A handoff section with one 402 screen: a bound title, a card with a raw `#a1e0c7`
 * fill and a raw 13 px gap, and a `Новое` note with the given lines.
 * @param {string[]} noteLines
 */
function section(noteLines, fillOpacity) {
  const sec = new Node('SECTION', 'Handoff / FE-5 / Home')
  sec.data['f2c:issue'] = 'FE-5'
  const screen = sec.appendChild(
    new Node('FRAME', 'Home / Default / 402', { width: 402, layoutMode: 'VERTICAL' }),
  )
  screen.appendChild(
    new Node('TEXT', 'title', {
      characters: 'Привет',
      fontName: { family: 'Marmelad', style: 'Regular' },
      textStyleId: 'style:fs-16',
    }),
  )
  screen.appendChild(
    new Node('FRAME', 'Card', {
      layoutMode: 'VERTICAL',
      itemSpacing: 13,
      fills: [
        { ...solid('#a1e0c7'), ...(fillOpacity === undefined ? {} : { opacity: fillOpacity }) },
      ],
      boundVariables: {},
    }),
  )
  const note = sec.appendChild(new Node('FRAME', 'Новое', { layoutMode: 'VERTICAL' }))
  note.appendChild(new Node('TEXT', 'line', { characters: noteLines.join('\n') }))
  return sec
}

/** Runs HANDOFF_CHECK on a section with the given token-request statuses. */
function check(noteLines, tokenRequests, fillOpacity) {
  const sec = section(noteLines, fillOpacity)
  const figma = {
    mixed: Symbol('mixed'),
    getNodeByIdAsync: (id) => Promise.resolve(id === sec.id ? sec : null),
    getStyleByIdAsync: () => Promise.resolve({ name: 'velo/fs-16' }),
  }
  const fn = runInNewContext(`${CHECK}\n;HANDOFF_CHECK`, { figma })
  return fn(sec.id, { tokenRequests })
}

const TOKEN_LINE = 'Новые токены: accent/mint = #a1e0c7, gap 13px — FE-231'

test('H-06/H-08: a raw value with no note line is an error', async () => {
  const r = await check(['Задача: FE-5'], {})
  assert.equal(r.ready, false)
  assert.equal(r.errors['H-06'], 1)
  assert.equal(r.errors['H-08'], 1)
})

test('H-06/H-08: «одобрено <кто>, <дата>» text without a request link approves nothing', async () => {
  const r = await check(
    ['Новые токены: accent/mint = #a1e0c7, gap 13px — одобрено Владимир, 22.11'],
    {},
  )
  assert.equal(r.ready, false)
  assert.equal(r.errors['H-06'], 1)
  assert.equal(r.errors['H-08'], 1)
})

test('H-06/H-08: a request in an approved or done status turns both errors into warnings', async () => {
  for (const status of ['approved', 'done']) {
    const r = await check([TOKEN_LINE], { 'FE-231': status })
    assert.equal(r.ready, true, status)
    assert.equal(r.errors['H-06'], undefined, status)
    assert.equal(r.warnings['H-06'], 1, status)
    assert.equal(r.warnings['H-08'], 1, status)
    assert.equal(r.tokenRequests['FE-231'], status)
  }
})

test('H-06/H-08: a pending, canceled or unknown request stays an error', async () => {
  for (const reqs of [{ 'FE-231': 'pending' }, { 'FE-231': 'canceled' }, {}]) {
    const r = await check([TOKEN_LINE], reqs)
    assert.equal(r.ready, false, JSON.stringify(reqs))
    assert.equal(r.errors['H-06'], 1, JSON.stringify(reqs))
    assert.equal(r.tokenRequests['FE-231'], reqs['FE-231'] || 'unknown')
  }
})

test("the screen's own task in a note line never approves a raw value, whatever its status", async () => {
  // the section is FE-5 (f2c:issue); its status is passed as approved, e.g. In Progress
  const r = await check(['Новые токены: accent/mint = #a1e0c7, gap = 13px — FE-5'], {
    'FE-5': 'approved',
  })
  assert.equal(r.ready, false)
  assert.equal(r.errors['H-06'], 1)
  assert.equal(r.errors['H-08'], 1)
  assert.equal(Object.keys(r.tokenRequests).length, 0)
})

test('a spacing value written without «px» after `=` is approved by its request', async () => {
  const r = await check(
    ['Новые токены: app/gap-13 = 13 — FE-231', 'Новые токены: accent/mint = #a1e0c7 — FE-231'],
    {
      'FE-231': 'approved',
    },
  )
  assert.equal(r.ready, true)
  assert.equal(r.warnings['H-08'], 1)
})

test('a canceled or pending request is listed as blocked', async () => {
  const r = await check([TOKEN_LINE], { 'FE-231': 'canceled' })
  assert.equal(r.blockedRequests.length, 1)
  assert.equal(r.blockedRequests[0], 'FE-231')
})

test('the `Задача: FE-NNN` line never counts as a token request', async () => {
  const r = await check(['Задача: FE-5 #a1e0c7 13px'], { 'FE-5': 'approved' })
  assert.equal(r.ready, false)
  assert.equal(Object.keys(r.tokenRequests).length, 0)
})

test('a request approves only the values on its own line', async () => {
  const r = await check(
    ['Новые токены: accent/mint = #a1e0c7 — FE-231', 'Новые токены: gap = 8px — FE-232'],
    {
      'FE-231': 'approved',
      'FE-232': 'approved',
    },
  )
  assert.equal(r.warnings['H-06'], 1)
  assert.equal(r.errors['H-08'], 1, '13 px is not on an approved line')
})

test('an opaque approval does not cover a translucent fill, and #rrggbbaa covers it', async () => {
  const opaque = await check(
    ['Новые токены: accent/mint = #a1e0c7, gap 13px — FE-231'],
    { 'FE-231': 'approved' },
    0.5,
  )
  assert.equal(opaque.errors['H-06'], 1, 'the 50 % fill is another colour than #a1e0c7')
  const withAlpha = await check(
    ['Новые токены: accent/mint-50 = #a1e0c780, gap 13px — FE-231'],
    { 'FE-231': 'approved' },
    0.5,
  )
  assert.equal(withAlpha.errors['H-06'], undefined)
  assert.equal(withAlpha.warnings['H-06'], 1)
  const alphaOnOpaque = await check(
    ['Новые токены: accent/mint-50 = #a1e0c780, gap 13px — FE-231'],
    { 'FE-231': 'approved' },
  )
  assert.equal(
    alphaOnOpaque.errors['H-06'],
    1,
    'a translucent approval does not cover an opaque fill',
  )
})

// --- SIMILAR_TOKENS --------------------------------------------------------------------
function similar(value) {
  const vars = [
    ['v1', 'COLOR', 'app/accent', rgb('#a0e0c8')],
    ['v2', 'COLOR', 'app/bg', rgb('#102030')],
    ['v3', 'FLOAT', 'app/gap-12', 12],
    ['v4', 'FLOAT', 'radius/md', 8],
    ['v5', 'FLOAT', 'font/fs-14', 14],
    ['v6', 'COLOR', 'glass/mint-30', rgb('#a1e0c74d')],
  ].map(([id, type, name, v]) => ({
    id,
    resolvedType: type,
    name,
    variableCollectionId: 'c1',
    valuesByMode: { m: v },
  }))
  const figma = {
    variables: {
      getLocalVariablesAsync: (type) =>
        Promise.resolve(vars.filter((v) => v.resolvedType === type)),
      getVariableCollectionByIdAsync: () => Promise.resolve({ name: 'velo' }),
      getVariableByIdAsync: () => Promise.resolve(null),
    },
  }
  const fn = runInNewContext(`${SIMILAR}\n;SIMILAR_TOKENS`, { figma })
  return fn(value)
}

test('SIMILAR_TOKENS: a colour a few steps away is offered as near, an exact one as use-existing', async () => {
  const near = await similar('#a1e0c7')
  assert.equal(near.advice, 'offer-near-first')
  assert.equal(near.near.length, 1)
  assert.equal(near.near[0].name, 'app/accent')
  const exact = await similar('#102030')
  assert.equal(exact.advice, 'use-existing')
  assert.equal(exact.exact[0].name, 'app/bg')
})

test('SIMILAR_TOKENS: spacing within 2 px is near, far values and bad input are not', async () => {
  assert.equal((await similar(13)).near[0].name, 'app/gap-12')
  assert.equal((await similar(40)).advice, 'no-similar')
  assert.ok((await similar('red')).error)
})

test('SIMILAR_TOKENS: alpha counts, a translucent token is not an opaque colour', async () => {
  const opaque = await similar('#a1e0c7')
  assert.ok(!opaque.near.some((t) => t.name === 'glass/mint-30'))
  const translucent = await similar('#a1e0c750')
  assert.equal(translucent.advice, 'offer-near-first')
  assert.equal(translucent.near.length, 1)
  assert.equal(translucent.near[0].name, 'glass/mint-30')
})

test('SIMILAR_TOKENS: numbers are compared with spacing and radius only, not font sizes', async () => {
  const r = await similar(14)
  assert.equal(r.advice, 'offer-near-first')
  assert.ok(r.near.every((t) => !t.name.startsWith('font/')))
  assert.equal(r.near[0].name, 'app/gap-12')
})
