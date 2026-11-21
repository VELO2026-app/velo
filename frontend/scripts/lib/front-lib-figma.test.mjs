// =============================================================================
// FE-224 -- the front agent's Figma library (docs/figma/front/front-lib.figma.js)
// against a minimal fake of the plugin API (Vitest, the `scripts` project).
// The real file is checked live in Figma; this pins the guard logic and that the
// designer's copy of c2fSeal (compare.figma.js) stays identical.
// =============================================================================
import { test, beforeEach } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { runInNewContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LIB = readFileSync(join(root, 'docs/figma/front/front-lib.figma.js'), 'utf8')
const COMPARE = readFileSync(
  join(root, 'docs/figma/velo-figma-designer/scripts/compare.figma.js'),
  'utf8',
)

/** Source text of a top-level `function <name>(` up to its closing brace at column 0. */
function topLevelFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

// --- a fake of the plugin API --------------------------------------------------------
let ids = 0
class Node {
  constructor(type, name, props = {}) {
    this.id = `n:${++ids}`
    this.type = type
    this.name = name
    /** @type {Node | null} */
    this.parent = null
    /** @type {Node[]} */
    this.children = []
    /** @type {Record<string, string>} */
    this.data = {}
    Object.assign(this, { x: 0, y: 0, width: 10, height: 10, fills: [] }, props)
  }
  appendChild(c) {
    c.parent = this
    this.children.push(c)
    return c
  }
  getPluginData(k) {
    return this.data[k] || ''
  }
  setPluginData(k, v) {
    this.data[k] = v
  }
  findAll(fn) {
    const out = []
    const walk = (n) => n.children.forEach((c) => (fn(c) && out.push(c), walk(c)))
    walk(this)
    return out
  }
  findOne(fn) {
    return this.findAll(fn)[0] || null
  }
}

let figma
let F
function setup() {
  const doc = new Node('DOCUMENT', 'doc')
  const pages = ['Фронт · Экраны', 'Фронт · Kit и токены', 'К разработке'].map((n) =>
    doc.appendChild(new Node('PAGE', n)),
  )
  const sheet = pages[0].appendChild(new Node('SECTION', 'Screen / user.home / Home'))
  const frame = sheet.appendChild(new Node('FRAME', 'Home / Default / 402'))
  frame.setPluginData('c2f:state', 'default')
  frame.appendChild(
    new Node('TEXT', 'title', {
      characters: 'Привет',
      fontName: { family: 'Marmelad', style: 'Regular' },
      fontSize: 16,
    }),
  )
  const handoff = pages[2].appendChild(new Node('SECTION', 'Handoff / FE-1 / X'))
  const byId = (id) => doc.findAll((n) => n.id === id)[0] || null
  figma = {
    mixed: Symbol('mixed'),
    fileKey: 'IV92js0q2cBHmHmDxB0zxM',
    root: doc,
    currentPage: pages[2],
    versions: [],
    loadAllPagesAsync: () => Promise.resolve(),
    setCurrentPageAsync: (p) => Promise.resolve((figma.currentPage = p)),
    saveVersionHistoryAsync: (label) => Promise.resolve(figma.versions.push(label)),
    getNodeByIdAsync: (id) => Promise.resolve(byId(id)),
  }
  // the file is a plugin script without exports: run it in a context with the fake API
  F = runInNewContext(LIB + '\n;({ makeFront, c2fSeal, c2fNeedGuard })', { figma, setTimeout })
  return { pages, sheet, frame, handoff }
}
const designerLock = (until = Date.now() + 5 * 60e3) =>
  JSON.stringify({ who: 'designer-agent', task: 'DSGN-1', until: new Date(until).toISOString() })
const COMMIT = { commit: 'f0db5d67', committedAt: '2026-11-21T08:00:00+08:00' }
let t
beforeEach(() => {
  t = setup()
})

// --- the seal ------------------------------------------------------------------------
test('c2fSeal: the designer copy is identical to the front library', () => {
  assert.equal(topLevelFunction(COMPARE, 'c2fSeal'), topLevelFunction(LIB, 'c2fSeal'))
})

test('c2fSeal: an edit inside the sheet changes it, moving the sheet does not', () => {
  const before = F.c2fSeal(t.sheet)
  t.sheet.x = 500
  assert.equal(F.c2fSeal(t.sheet), before)
  t.frame.children[0].characters = 'Пока'
  assert.notEqual(F.c2fSeal(t.sheet), before)
})

// --- write: pages, locks, version ------------------------------------------------------
test('write: a designer page is refused before the version; a mirror page is written under a lock', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['К разработке'], 'x', () => {}),
    /may not write to page/,
  )
  assert.deepEqual(figma.versions, [])
  let during = null
  await front.write(['Фронт · Экраны'], 'ok', () => {
    during = JSON.parse(t.pages[0].getPluginData('f2c:lock')).who
  })
  assert.equal(during, 'front-agent thr_a')
  assert.equal(t.pages[0].getPluginData('f2c:lock'), '')
  assert.deepEqual(figma.versions, ['agent:front FE-1 ok'])
})

test('write: a live lock of another owner stops the call before the version; an expired one does not', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.pages[0].setPluginData('f2c:lock', designerLock())
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () => {}),
    /СТРАНИЦА ЗАНЯТА/,
  )
  assert.deepEqual(figma.versions, [])
  t.pages[0].setPluginData('f2c:lock', designerLock(Date.now() - 1000))
  await front.write(['Фронт · Экраны'], 'ok', () => {})
  assert.equal(figma.versions.length, 1)
})

test('write: an error inside releases the lock; the file key is required', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(t.pages[0].getPluginData('f2c:lock'), '')
  figma.fileKey = undefined
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () => {}),
    /fileKey is not available/,
  )
})

test('acquire: the lock outlives a write and blocks another front thread until release', async () => {
  const a = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  const b = F.makeFront({ thread: 'thr_b', task: 'FE-2' })
  await a.acquire(['Фронт · Экраны'])
  await a.write(['Фронт · Экраны'], 'step 1', () => {})
  assert.equal(JSON.parse(t.pages[0].getPluginData('f2c:lock')).who, 'front-agent thr_a')
  await assert.rejects(
    b.write(['Фронт · Экраны'], 'x', () => {}),
    /СТРАНИЦА ЗАНЯТА/,
  )
  await a.release(['Фронт · Экраны'])
  await b.write(['Фронт · Экраны'], 'ok', () => {})
})

// --- write: what may be touched ----------------------------------------------------------
test('touch / c2fNeedGuard: a node on an unlocked page is refused inside the write, a node on a locked page passes', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await front.write(['Фронт · Экраны'], 'x', () => {
    assert.throws(() => front.touch(t.frame, t.handoff), /outside FRONT\.write/)
    assert.equal(front.touch(t.frame), 1)
  })
  assert.throws(() => F.c2fNeedGuard(t.frame), /outside FRONT\.write/)
})

// --- stamp -----------------------------------------------------------------------------------
test('stamp: a sheet not rebuilt in the write needs evidence; a rebuilt one does not', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () => front.stamp(t.sheet.id, COMMIT)),
    /was not rebuilt/,
  )
  const r = await front.write(['Фронт · Экраны'], 'baseline', () =>
    front.stamp(t.sheet.id, { ...COMMIT, evidence: 'diff.py PASS' }),
  )
  assert.equal(r.rebuilt, false)
  assert.equal(t.frame.getPluginData('c2f:commit'), 'f0db5d67')
  assert.equal(t.sheet.getPluginData('c2f:seal'), F.c2fSeal(t.sheet))
  await front.write(['Фронт · Экраны'], 'resnap', () => {
    front.touch(t.frame) // a raw change of a layer inside the sheet
    return front.stamp(t.sheet.id, { ...COMMIT, committedAt: '2026-11-22T08:00:00+08:00' })
  })
  assert.equal(t.sheet.getPluginData('c2f:evidence'), 'rebuilt from code in this write')
})

test('stamp: older code than the sheet already shows is refused', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.sheet.setPluginData('c2f:committed', '2026-11-22T08:00:00+08:00')
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () =>
      front.stamp(t.sheet.id, { ...COMMIT, evidence: 'e' }),
    ),
    /newer code/,
  )
})
