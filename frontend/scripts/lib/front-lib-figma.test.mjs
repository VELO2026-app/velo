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
const FSS_LIB = readFileSync(join(root, 'docs/figma/front/fss-lib.figma.js'), 'utf8')
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
  loadAsync() {
    return Promise.resolve()
  }
  remove() {
    const parent = /** @type {Node} */ (this.parent)
    parent.children.splice(parent.children.indexOf(this), 1)
    this.parent = null
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
  F = load(LIB + '\n' + FSS_LIB)
  return { pages, sheet, frame, handoff }
}
/** Run the plugin scripts (no exports) in a context with the fake API. */
const load = (src) =>
  runInNewContext(
    src + '\n;({ makeFront, makeFSS, c2fSeal, c2fNeedGuard, c2fMarkRebuilt, c2fInventory })',
    {
      figma,
      setTimeout,
    },
  )
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
  const saved = figma.versions.length
  await assert.rejects(
    b.write(['Фронт · Экраны'], 'x', () => {}),
    /СТРАНИЦА ЗАНЯТА/,
  )
  assert.equal(figma.versions.length, saved) // refused before the version
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
    F.c2fMarkRebuilt(t.sheet) // what FSS.sheet / componentSheet do
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

test('write: our own expired task lock is extended and kept, not released', async () => {
  const a = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.pages[0].setPluginData(
    'f2c:lock',
    JSON.stringify({
      who: 'front-agent thr_a',
      task: 'FE-1',
      until: new Date(Date.now() - 1000).toISOString(),
    }),
  )
  await a.write(['Фронт · Экраны'], 'ok', () => {})
  const l = JSON.parse(t.pages[0].getPluginData('f2c:lock'))
  assert.equal(l.who, 'front-agent thr_a')
  assert.ok(Date.parse(l.until) > Date.now())
})

test('write: refuses an FSS copy without the repo version before any change', async () => {
  F = load(LIB + '\nfunction makeFSS() {}') // an old skill copy of the builders
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () => {}),
    /fss-lib\.figma\.js/,
  )
  assert.deepEqual(figma.versions, [])
})

// --- the FSS builders from the repo --------------------------------------------------------
test('FSS builders: a source or target on an unlocked page and the stamp-only keys are refused', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  const FSS = F.makeFSS()
  assert.throws(() => FSS.setMeta(t.sheet, { status: 'draft' }), /outside FRONT\.write/)
  await front.write(['Фронт · Экраны'], 'x', async () => {
    assert.throws(() => FSS.setMeta(t.sheet, { commit: 'abc1234' }), /only by FRONT\.stamp/)
    FSS.setMeta(t.sheet, { status: 'draft' })
    const outside = /outside FRONT\.write/
    await assert.rejects(FSS.tile(t.frame, { key: 'k', name: 'n', masterNode: t.handoff }), outside)
    await assert.rejects(
      FSS.stateFrame(t.frame, { key: 'k', title: 'T', adopt: t.handoff.id }),
      outside,
    )
    await assert.rejects(FSS.row(t.frame, 'T', 's', [t.handoff]), outside)
    await assert.rejects(
      FSS.componentSheet({ key: 'component:X', family: 'X', body: t.handoff.id }),
      outside,
    )
  })
  assert.equal(t.sheet.getPluginData('c2f:status'), 'draft')
  assert.equal(t.handoff.parent, t.pages[2])
})

test('stamp: FRONT.touch guards only; FSS.sheet({ replace }) marks the sheet rebuilt', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Фронт · Экраны'], 'x', () => {
      front.touch(t.frame)
      return front.stamp(t.sheet.id, COMMIT)
    }),
    /was not rebuilt/,
  )
  t.sheet.setPluginData('c2f:key', 'screen:user.home')
  const r = await front.write(['Фронт · Экраны'], 'resnap', async () => {
    // the fake has no templates: the rebuild stops after clearing and marking the sheet
    await assert.rejects(
      F.makeFSS().sheet({
        key: 'screen:user.home',
        route: 'user.home',
        title: 'Home',
        replace: t.sheet.id,
      }),
      /ensureTemplates/,
    )
    return front.stamp(t.sheet.id, COMMIT)
  })
  assert.equal(r.rebuilt, true)
  assert.equal(t.sheet.children.length, 0)
})

test('check: a seal of another version is not «edited» but needs a restamp', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.sheet.setPluginData('c2f:seal', 'v1:39:3092364d')
  const c = await front.check(t.sheet.id)
  assert.equal(c.intact, null)
  assert.match(c.note, /restamp/)
})

test('c2fInventory: lists keyed sheets of the mirror pages; a seal of another version reads as no seal', async () => {
  t.sheet.setPluginData('c2f:key', 'screen:user.home')
  t.sheet.setPluginData('c2f:source', 'frontend/src/views/user/HomeView.vue')
  t.sheet.setPluginData('c2f:commit', 'f0db5d67')
  t.sheet.setPluginData('c2f:seal', F.c2fSeal(t.sheet))
  t.handoff.setPluginData('c2f:key', 'screen:not-a-mirror')
  let inv = await F.c2fInventory()
  assert.deepEqual(
    // the vm context has its own Array: compare plain JSON
    JSON.parse(JSON.stringify(inv.sheets.map((x) => [x.key, x.sources, x.intact]))),
    [['screen:user.home', ['frontend/src/views/user/HomeView.vue'], true]],
  )
  t.sheet.setPluginData('c2f:seal', 'v1:39:3092364d')
  inv = await F.c2fInventory()
  assert.equal(inv.sheets[0].seal, null)
  assert.match(inv.sheets[0].sealNote, /restamp/)
})
