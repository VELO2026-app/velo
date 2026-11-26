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
  // what the FSS builders call on a node; layout fields are plain assignments
  resize(w, h) {
    Object.assign(this, { width: w, height: h })
  }
  resizeWithoutConstraints(w, h) {
    this.resize(w, h)
  }
  setBoundVariable() {}
  setProperties() {}
  setTextStyleIdAsync() {
    return Promise.resolve()
  }
  createInstance() {
    const props = (names) => Object.fromEntries(names.map((n, i) => [`${n}#${i}`, {}]))
    const head = new Node('INSTANCE', this.name, {
      componentProperties: props(['Title', 'Route', 'Date']),
    })
    head.appendChild(new Node('INSTANCE', 'badge', { componentProperties: props(['Status']) }))
    return head
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
  const pages = ['Gold · Приложение', 'Kit и токены', 'User App'].map((n) =>
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
  const template = pages[0].appendChild(new Node('COMPONENT', 'Template / Sheet Header'))
  template.setPluginData('c2f:key', 'template:sheet-header')
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
    // what a full FSS.sheet() build needs: doc/* and legacy variables, doc/* text styles
    variables: {
      getLocalVariablesAsync: () =>
        Promise.resolve(
          VARS.map(([c, n]) => ({ name: n, variableCollectionId: c, valuesByMode: { m: 16 } })),
        ),
      getVariableCollectionByIdAsync: (c) => Promise.resolve({ name: c }),
      setBoundVariableForPaint: (paint) => paint,
    },
    getLocalTextStylesAsync: () =>
      Promise.resolve(['doc/section', 'doc/body'].map((n) => ({ name: n, id: n, fontName: {} }))),
    loadFontAsync: () => Promise.resolve(),
    createSection: () => figma.currentPage.appendChild(new Node('SECTION', '')),
    createFrame: () => figma.currentPage.appendChild(new Node('FRAME', '')),
    createRectangle: () => figma.currentPage.appendChild(new Node('RECTANGLE', '')),
    createText: () =>
      figma.currentPage.appendChild(
        new Node('TEXT', '', {
          characters: '',
          fontName: { family: 'Inter', style: 'Regular' },
          fontSize: 12,
        }),
      ),
  }
  // the file is a plugin script without exports: run it in a context with the fake API
  F = load(LIB + '\n' + FSS_LIB)
  return { doc, pages, sheet, frame, handoff, template }
}
const DOC = [
  'sheet-pad',
  'state-gap',
  'spec-gap',
  'header-h',
  'spec-w',
  'sheet-bg',
  'chrome-text',
  'chrome-muted',
]
let VARS = []
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
  VARS = [...DOC.map((n) => ['doc', 'doc/' + n]), ['legacy', 'space/5'], ['legacy', 'space/2']]
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
    front.write(['User App'], 'x', () => {}),
    /may not write to page/,
  )
  assert.deepEqual(figma.versions, [])
  let during = null
  await front.write(['Gold · Приложение'], 'ok', () => {
    during = JSON.parse(t.pages[0].getPluginData('f2c:lock')).who
  })
  assert.equal(during, 'front-agent thr_a')
  assert.equal(t.pages[0].getPluginData('f2c:lock'), '')
  assert.deepEqual(figma.versions, ['agent:front FE-1 ok'])
})

test('write: only the listed pages pass; copies, look-alikes, designer pages, archive and the old «Фронт · …» names are refused', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  const own = [
    'Обложка',
    'Kit и токены',
    'Скины',
    'Gold · Приложение',
    'Goodo · Приложение',
    'Goodo · Библиотека',
    'Админка · Gold',
    'Админка · Goodo',
    'Веб-версия · концепт',
    'Админка · цель (ждёт бэкенд)',
  ]
  const other = [
    'Админка · Веб · Gold',
    'Админка · концепт',
    'Админка · Цель (ждёт бэкенд)',
    'Админка · Goodo (копия)',
    'Эксперименты · Приложение',
    'Веб-версия · Приложение',
    'Icons',
    'User App',
    'Master App',
    'Admin Panel',
    'Архив',
    'Фронт · Экраны',
    'Goodo · Демо',
    '——— КОД (как в приложении, не править) ———',
  ]
  for (const n of [...own, ...other]) {
    if (!t.doc.children.some((p) => p.name === n)) t.doc.appendChild(new Node('PAGE', n))
  }
  for (const n of other)
    await assert.rejects(
      front.write([n], 'x', () => {}),
      /may not write to page/,
      n,
    )
  assert.deepEqual(figma.versions, [])
  for (const n of own) await front.write([n], 'ok', () => {})
  assert.equal(figma.versions.length, own.length)
})

test('write: a live lock of another owner stops the call before the version; an expired one does not', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.pages[0].setPluginData('f2c:lock', designerLock())
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () => {}),
    /СТРАНИЦА ЗАНЯТА/,
  )
  assert.deepEqual(figma.versions, [])
  t.pages[0].setPluginData('f2c:lock', designerLock(Date.now() - 1000))
  await front.write(['Gold · Приложение'], 'ok', () => {})
  assert.equal(figma.versions.length, 1)
})

test('write: an error inside releases the lock; the file key is required', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(t.pages[0].getPluginData('f2c:lock'), '')
  figma.fileKey = undefined
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () => {}),
    /fileKey is not available/,
  )
})

test('acquire: the lock outlives a write and blocks another front thread until release', async () => {
  const a = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  const b = F.makeFront({ thread: 'thr_b', task: 'FE-2' })
  await a.acquire(['Gold · Приложение'])
  await a.write(['Gold · Приложение'], 'step 1', () => {})
  assert.equal(JSON.parse(t.pages[0].getPluginData('f2c:lock')).who, 'front-agent thr_a')
  const saved = figma.versions.length
  await assert.rejects(
    b.write(['Gold · Приложение'], 'x', () => {}),
    /СТРАНИЦА ЗАНЯТА/,
  )
  assert.equal(figma.versions.length, saved) // refused before the version
  await a.release(['Gold · Приложение'])
  await b.write(['Gold · Приложение'], 'ok', () => {})
})

// --- write: what may be touched ----------------------------------------------------------
test('touch / c2fNeedGuard: a node on an unlocked page is refused inside the write, a node on a locked page passes', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await front.write(['Gold · Приложение'], 'x', () => {
    assert.throws(() => front.touch(t.frame, t.handoff), /outside FRONT\.write/)
    assert.equal(front.touch(t.frame), 1)
  })
  assert.throws(() => F.c2fNeedGuard(t.frame), /outside FRONT\.write/)
})

// --- stamp -----------------------------------------------------------------------------------
test('stamp: a sheet not rebuilt in the write needs evidence; a rebuilt one does not', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () => front.stamp(t.sheet.id, COMMIT)),
    /was not rebuilt/,
  )
  const r = await front.write(['Gold · Приложение'], 'baseline', () =>
    front.stamp(t.sheet.id, { ...COMMIT, evidence: 'diff.py PASS' }),
  )
  assert.equal(r.rebuilt, false)
  assert.equal(t.frame.getPluginData('c2f:commit'), 'f0db5d67')
  assert.equal(t.sheet.getPluginData('c2f:seal'), F.c2fSeal(t.sheet))
  await front.write(['Gold · Приложение'], 'resnap', () => {
    F.c2fMarkRebuilt(t.sheet) // what FSS.sheet / componentSheet do
    return front.stamp(t.sheet.id, { ...COMMIT, committedAt: '2026-11-22T08:00:00+08:00' })
  })
  assert.equal(t.sheet.getPluginData('c2f:evidence'), 'rebuilt from code in this write')
})

test('stamp: older code than the sheet already shows is refused', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.sheet.setPluginData('c2f:committed', '2026-11-22T08:00:00+08:00')
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () =>
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
  await a.write(['Gold · Приложение'], 'ok', () => {})
  const l = JSON.parse(t.pages[0].getPluginData('f2c:lock'))
  assert.equal(l.who, 'front-agent thr_a')
  assert.ok(Date.parse(l.until) > Date.now())
})

test('write: refuses an FSS copy without the repo version before any change', async () => {
  F = load(LIB + '\nfunction makeFSS() {}') // an old skill copy of the builders
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () => {}),
    /fss-lib\.figma\.js/,
  )
  assert.deepEqual(figma.versions, [])
})

// --- the FSS builders from the repo --------------------------------------------------------
test('FSS builders: a source or target on an unlocked page and the stamp-only keys are refused', async () => {
  const front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  const FSS = F.makeFSS()
  assert.throws(() => FSS.setMeta(t.sheet, { status: 'draft' }), /outside FRONT\.write/)
  await front.write(['Gold · Приложение'], 'x', async () => {
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

test('stamp: FRONT.touch guards only; only a completed FSS.sheet({ replace }) marks the sheet rebuilt', async () => {
  let front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  const resnap = () =>
    F.makeFSS().sheet({
      key: 'screen:user.home',
      route: 'user.home',
      title: 'Home',
      replace: t.sheet.id,
    })
  t.sheet.setPluginData('c2f:key', 'screen:user.home')
  await assert.rejects(
    front.write(['Gold · Приложение'], 'x', () => {
      front.touch(t.frame)
      return front.stamp(t.sheet.id, COMMIT)
    }),
    /was not rebuilt/,
  )
  // a build that cannot finish (no template, no variable) changes nothing and earns no stamp
  for (const breakIt of [() => t.template.remove(), () => VARS.pop()]) {
    t = setup() // a fresh file and library for each case
    front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
    t.sheet.setPluginData('c2f:key', 'screen:user.home')
    breakIt()
    const before = t.sheet.children.length
    await assert.rejects(
      front.write(['Gold · Приложение'], 'failed resnap', async () => {
        await resnap().catch(() => {}) // the agent swallows the error and stamps anyway
        return front.stamp(t.sheet.id, COMMIT)
      }),
      /was not rebuilt/,
    )
    assert.equal(t.sheet.children.length, before)
  }
  VARS.push(['legacy', 'space/2'])
  t = setup()
  front = F.makeFront({ thread: 'thr_a', task: 'FE-1' })
  t.sheet.setPluginData('c2f:key', 'screen:user.home')
  const r = await front.write(['Gold · Приложение'], 'resnap', async () => {
    await resnap()
    return front.stamp(t.sheet.id, COMMIT)
  })
  assert.equal(r.rebuilt, true)
  assert.deepEqual(
    t.sheet.children.map((c) => c.name),
    ['Template / Sheet Header', 'States', 'Spec'],
  )
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
    JSON.parse(
      JSON.stringify(
        inv.sheets
          .filter((x) => x.key.startsWith('screen:'))
          .map((x) => [x.key, x.sources, x.intact]),
      ),
    ),
    [['screen:user.home', ['frontend/src/views/user/HomeView.vue'], true]],
  )
  t.sheet.setPluginData('c2f:seal', 'v1:39:3092364d')
  inv = await F.c2fInventory()
  const home = inv.sheets.find((x) => x.key === 'screen:user.home')
  assert.equal(home.seal, null)
  assert.match(home.sealNote, /restamp/)
})
