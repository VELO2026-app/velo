// =============================================================================
// The page-name lists of the three Figma scripts stay in step (docs/figma-protocol.md §2):
// front-lib (FRONT_OWN_PAGES, FRONT_MIRROR_PAGES), modes-lib (MODES_FRONT_PAGE) and designer-lib (OWN).
// The scripts are plain `figma_execute` scripts without exports, so the regex literals are read from the text.
// =============================================================================
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
/** The `/…/` literal assigned to a top-level or function-level `const <name> = /…/;`. */
const literal = (src, name) => {
  const m = new RegExp(`const ${name} = /(.+)/;`).exec(src)
  assert.ok(m, `const ${name} = /…/ not found`)
  return new RegExp(m[1])
}

const FRONT = read('docs/figma/front/front-lib.figma.js')
const MODES = read('docs/figma/front/modes-lib.figma.js')
const DESIGNER = read('docs/figma/velo-figma-designer/scripts/designer-lib.figma.js')

test('the mirror pages the modes library pins are the ones the front library inventories', () => {
  assert.equal(
    literal(MODES, 'MODES_FRONT_PAGE').source,
    literal(FRONT, 'FRONT_MIRROR_PAGES').source,
  )
})

test('the two concept pages are written by both agents, by explicit name', () => {
  const front = literal(FRONT, 'FRONT_OWN_PAGES')
  const designer = literal(DESIGNER, 'OWN')
  for (const n of ['Веб-версия · концепт', 'Админка · цель (ждёт бэкенд)']) {
    assert.ok(front.test(n), `front: ${n}`)
    assert.ok(designer.test(n), `designer: ${n}`)
  }
})

test("the front agent never writes the designer's pages or the archive; the designer never the code pages", () => {
  const front = literal(FRONT, 'FRONT_OWN_PAGES')
  const designer = literal(DESIGNER, 'OWN')
  for (const n of [
    'Icons',
    'User App',
    'Master App',
    'Admin Panel',
    'Архив',
    'К разработке',
    'Эксперименты · Тема',
  ]) {
    assert.equal(front.test(n), false, `front must not write ${n}`)
  }
  for (const n of [
    'Обложка',
    'Kit и токены',
    'Скины',
    'Gold · Приложение',
    'Goodo · Библиотека',
    'Админка · Gold',
  ]) {
    assert.equal(designer.test(n), false, `designer must not write ${n}`)
  }
})
