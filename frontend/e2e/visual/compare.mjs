// Visual comparison report (FE-162): base/<screen>.png vs head/<screen>.png.
//
//   node e2e/visual/compare.mjs [dir=visual-out]
//
// Writes <dir>/report.json and <dir>/report.html (changed screens only: base,
// head, diff, pixel count), prints the changed screens, and appends them to
// $GITHUB_STEP_SUMMARY. Exit 0 always, except VISUAL_STRICT=1 (the PR carries
// `no-visual-change`): then any changed screen exits 1.
//
// A screen is changed when pixelmatch counts > 0 differing pixels (color
// threshold 0.1, anti-aliasing ignored), when the sizes differ, or when it is
// shot on one side only.
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { resolve } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const dir = resolve(process.argv[2] ?? 'visual-out')
const png = (side, name) => resolve(dir, side, `${name}.png`)
const names = (side) =>
  existsSync(resolve(dir, side))
    ? readdirSync(resolve(dir, side))
        .filter((f) => f.endsWith('.png'))
        .map((f) => f.slice(0, -4))
    : []
const all = [...new Set([...names('base'), ...names('head')])].sort()
if (names('base').length === 0 || names('head').length === 0) {
  console.error(`visual: need shots in both ${dir}/base and ${dir}/head`)
  process.exit(2)
}

const changed = []
for (const name of all) {
  if (!existsSync(png('base', name)) || !existsSync(png('head', name))) {
    changed.push({ name, reason: existsSync(png('base', name)) ? 'only in base' : 'only in head' })
    continue
  }
  const a = PNG.sync.read(readFileSync(png('base', name)))
  const b = PNG.sync.read(readFileSync(png('head', name)))
  if (a.width !== b.width || a.height !== b.height) {
    changed.push({ name, reason: `size ${a.width}x${a.height} -> ${b.width}x${b.height}` })
    continue
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0.1,
    includeAA: false,
  })
  if (pixels > 0) {
    mkdirSync(resolve(dir, 'diff'), { recursive: true })
    writeFileSync(png('diff', name), PNG.sync.write(diff))
    changed.push({ name, reason: `${pixels} px differ`, pixels })
  }
}

writeFileSync(
  resolve(dir, 'report.json'),
  JSON.stringify({ total: all.length, changed }, null, 2) + '\n',
)
const cell = (side, c) =>
  existsSync(png(side, c.name))
    ? `<td><img src="${side}/${c.name}.png" width="260"></td>`
    : '<td>—</td>'
writeFileSync(
  resolve(dir, 'report.html'),
  `<!doctype html><meta charset="utf-8"><title>visual report</title>
<style>body{font:14px system-ui;margin:16px}td{vertical-align:top;padding:4px}img{border:1px solid #ccc}</style>
<h1>${changed.length} of ${all.length} screens changed</h1>
${changed
  .map(
    (c) => `<h2>${c.name} <small>${c.reason}</small></h2><table><tr>
<td>base</td><td>head</td><td>diff</td></tr><tr>${cell('base', c)}${cell('head', c)}${cell('diff', c)}</tr></table>`,
  )
  .join('\n')}`,
)

const list = changed.map((c) => `- ${c.name}: ${c.reason}`).join('\n')
console.log(
  changed.length
    ? `visual: ${changed.length} of ${all.length} screens changed\n${list}`
    : `visual: no changes in ${all.length} screens`,
)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Visual diff: ${changed.length} of ${all.length} screens changed\n\n${list || 'no changes'}\n\nReport: artifact \`visual-out\` (report.html).\n`,
  )
}
if (changed.length && process.env.VISUAL_STRICT === '1') process.exit(1)
