// =============================================================================
// FE-124 track T, step 1 -- ONE-TIME migration tool (tz-whitelabel §3.3, track T).
// =============================================================================
// Parses the hand-written variables.css into frontend/tokens.json (W3C DTCG
// shape + $extensions carrying everything the generator needs to reproduce
// the file BYTE FOR BYTE):
//
//   - declarations  -> { $value: <verbatim value, multi-line as written>,
//                       $extensions.pridem: { order, trailing?, before? } }
//   - section/block comments and blank-line gaps -> $extensions.pridem.before
//     (verbatim, in order) on the token that follows them
//   - the reduced-motion override block -> $extensions.pridem.overrides
//     (name -> verbatim value) on $extensions.pridem of the ROOT pseudo-group
//
// The GENERATOR (generate-variables.mjs) is the rule-based inverse; the
// round-trip diff (generate output vs this file) is the losslessness proof.
// Run from frontend/:  node scripts/extract-variables-tokens.mjs
// =============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, '..', 'src', 'styles', 'variables.css')
const outPath = join(here, '..', 'tokens.json')
const css = readFileSync(cssPath, 'utf8')

// --- split the file into its three regions -----------------------------------
const rootOpen = css.indexOf(':root {')
const mediaOpen = css.indexOf('/* Reduced motion')
const rootClose = css.indexOf('\n}', rootOpen)
if (rootOpen < 0 || mediaOpen < 0 || rootClose < 0 || rootClose > mediaOpen) {
  throw new Error('unexpected variables.css layout -- extractor needs a re-read')
}
const header = css.slice(0, rootOpen) + ':root {'
// Body WITHOUT the closing brace; the media region starts at its leading
// comment (the blank line between them is emitted by the generator).
const rootBody = css.slice(rootOpen + ':root {'.length, rootClose)
const mediaBlock = css.slice(mediaOpen)

// --- parse :root body into an ordered entry list ------------------------------
// Token line:  `  --name: value;` with an optional ` /* trailing */`.
// A value may span lines (color-mix broken across lines) -- continuation lines
// are anything until the closing `;`. Comment lines and blank lines become
// the `before` payload of the next token; a trailing comment rides its token.
const entries = [] // {kind:'token', name, value, trailing?, before:[]}|{kind:'raw', line}
const lines = rootBody.split('\n')
let pendingBefore = []
let inBlock = false
for (let i = 1; i < lines.length; i++) {
  const raw = lines[i]
  if (raw.trim() === '') {
    // A blank line INSIDE a block comment belongs to the comment; a real gap
    // separates tokens. Track block-comment state to tell the two apart.
    if (!inBlock) pendingBefore.push(raw === '' ? '' : raw)
    else pendingBefore.push(raw)
    continue
  }
  const t = raw.trim()
  if (t.startsWith('/*')) inBlock = true
  if (inBlock) {
    pendingBefore.push(raw)
    if (blockCommentClosed(t)) inBlock = false
    continue
  }
  if (!t.startsWith('--')) {
    throw new Error(`stray line in :root body: ${t.slice(0, 60)}`)
  }
  // declaration, possibly multi-line, possibly with a trailing comment
  let buf = raw
  let trailing
  let done = false
  while (!done) {
    if (hasTerminator(buf)) {
      const m = buf.match(/^(\s*--[\w-]+:\s*[\s\S]*?);(\s*\/\*.*?\*\/)?\s*$/)
      if (!m) throw new Error(`unparsed declaration near: ${buf.slice(0, 80)}`)
      done = true
      const name = m[1].split(':')[0].trim()
      // VERBATIM value slice (keeps the space after ':', the interior
      // newlines of a broken color-mix, and the closing indent) -- the
      // generator re-emits it 1:1.
      const value = m[1].slice(m[1].indexOf(':') + 1)
      trailing = m[2]?.replace(/^\s*\/\*\s?/, '').replace(/\s?\*\/$/, '')
      entries.push({
        kind: 'token',
        name,
        value,
        trailing,
        before: pendingBefore,
      })
      pendingBefore = []
    } else {
      if (i + 1 >= lines.length) throw new Error(`unterminated declaration: ${buf.slice(0, 80)}`)
      buf += '\n' + lines[++i]
    }
  }
}

function hasTerminator(s) {
  // A `;` at depth 0 outside quotes/comment. Values here contain no quotes
  // except font stacks ('...') and no parens nesting deeper than 1 -- a scan
  // with paren depth is enough. `;` inside rgba(...) does not exist.
  let depth = 0
  let inQ = false
  for (const ch of s) {
    if (ch === "'") inQ = !inQ
    if (inQ) continue
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) return true
  }
  return false
}
function blockCommentClosed(t) {
  const opens = (t.match(/\/\*/g) ?? []).length
  const closes = (t.match(/\*\//g) ?? []).length
  if (closes > opens) return true
  if (closes === opens && t.includes('*/')) return true
  return false
}

// --- DTCG tree: section comments become groups; --velo-a-b maps to velo.a.b --
// Bare families keep their own top-level group (space/radius/font/z/size/
// transition -- frozen names, not skin-rethemeable; the skin contract section
// of variables.css lists the Gen-1 branches, all --velo-*).
const SKIP_LINE = (s) => /^\/\* =+$/.test(s.trim())

function groupFor() {
  // Bare families are NOT skin-rethemeable (frozen naming rule, file header):
  // one flat group per full name keeps them collision-free and clearly
  // second-class. --velo-a-b... maps to velo.a.b... (the skin-contract rule).
  // DTCG paths are STABLE/INJECTIVE, not a taxonomy -- cssName in 
  // is authoritative for the CSS.
  return null
}

const root = {}
let order = 0
const pendingSections = [] // section header comments (=== ... ===) name groups
for (const e of entries) {
  // Detect a section header among `before` comments: "/* === X === */" --
  // the LAST one before the token names the DTCG group for tokens whose name
  // does not already encode one (bare families, --velo-* whose first segment
  // is a value like --velo-size-40).
  for (const c of e.before) {
    const m = c.match(/^\s*\/\*\s*===+\s*(.+?)\s*:?\s*===+\s*\*\/\s*$/)
    if (m) pendingSections.push(m[1])
  }
  let segs
  if (!e.name.startsWith('--velo-')) {
    segs = ['bare', e.name.slice(2)]
  } else {
    segs = ['velo', ...e.name.slice(7).split('-')]
  }
  let node = root
  for (const s of segs.slice(0, -1)) node = (node[s] ??= {})
  const leafName = segs[segs.length - 1]
  const ext = { pridem: { order, cssName: e.name } }
  if (e.trailing) ext.pridem.trailing = e.trailing
  if (e.before.length) ext.pridem.before = e.before
  const tok = { $value: e.value, $extensions: ext }
  const existing = node[leafName]
  // A LATER token may take a path through an EXISTING token's subtree
  // (--velo-radius-4 arrives after --velo-radius-4-5): merge the token fields
  // INTO the group instead of overwriting the subtree.
  node[leafName] = existing && typeof existing === 'object' && !('$value' in existing)
    ? { ...tok, ...existing }
    : tok
  order++
}

// --- reduced-motion overrides --------------------------------------------------
const overrides = {}
const mediaLines = mediaBlock.split('\n')
for (const line of mediaLines) {
  const m = line.match(/^    (--[\w-]+):\s*(.+);$/)
  if (m) overrides[m[1]] = m[2]
}
root.__media = {
  $value: 'prefers-reduced-motion',
  $extensions: { pridem: { order: order + 1, overrides, mediaBlock } },
}

// A comment block right before the closing brace has no token to attach to
// -- captured as the root's trailing comment.
let trailingComment = null
if (pendingBefore.length) {
  trailingComment = pendingBefore
  pendingBefore = []
}

const doc = {
  $schema: 'https://design-tokens.github.io/community-group/format/',
  $description: 'VELO design tokens -- golden theme (FE-124 track T; generated FROM variables.css by scripts/extract-variables-tokens.mjs at the migration; the GENERATOR direction is variables.css <- tokens.json).',
  $extensions: { pridem: { header, trailingComment, mediaBlock } },
  root,
}
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')
console.log(`tokens.json written: ${Object.keys(root).length} top groups, ${order} ordered entries`)
