// FE-139 (stage D of FE-135): doc-coverage gate -- every export in the TS
// module areas carries a JSDoc doc comment with a non-empty summary line.
//
// Policy (docs/frontend-comments.md §2.1): an export is documented when its
// declaration carries a /** */ comment whose SUMMARY (text before the first
// block tag) is non-empty -- that first line is what a grep/outline reader
// sees, so a comment that opens straight into @param tags does not count.
// The gate is binary and landed green in FE-139: every miss fails the build.
// The ratchet is therefore implicit -- coverage can only stay at 100%,
// there is no warning budget that could be raised (FE-73 budget policy
// deliberately not used here).
//
// Exemptions (fixed list, each with a reason):
//   - index.ts -- re-export barrels; the doc lives at the declaration site
//     of each re-exported symbol, not in the barrel;
//   - src/api/generated.ts and *.generated.ts -- openapi/skin codegen
//     output, not hand-written API surface (same exemption as no-cyrillic
//     and typedoc.json, FE-136);
//   - *.test.ts -- test internals, excluded from
//     the typedoc entry set as well;
//   - `export ... from` declarations -- re-exports; the doc lives at the
//     original declaration;
//   - `export type { ... }` (whole-list and per-element `type` specifiers)
//     -- type-only duplicates of declarations documented elsewhere.
//
// @internal policy (FE-139 decision): marking an export @internal hides it
// from the typedoc output (excludeInternal) but does NOT exempt it from
// this gate -- the summary line serves code readers (grep, outline) first,
// generated docs second. There is no coverage escape hatch.
//
// Overload policy: consecutive overloads of one exported function share the
// doc comment on the FIRST declaration; requiring it on every signature
// would only duplicate the summary.
//
// .vue exports are out of scope for stage D of FE-135, same as typedoc
// (typedoc.json: SFCs need a vue plugin).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Same module areas as typedoc.json entryPoints (FE-136).
const SCOPE_DIRS = [
  'src/composables',
  'src/stores',
  'src/api',
  'src/utils',
  'src/platform',
  'src/router',
]
const isGenerated = (p) => p.endsWith('.generated.ts') || p === 'src/api/generated.ts'
const isExcludedName = (name) =>
  name === 'index.ts' || // barrel
  name.includes('.test.') ||
  isGenerated(name)

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.ts') && !isExcludedName(name) && !isGenerated(p)) files.push(p)
  }
}
for (const d of SCOPE_DIRS) walk(d)

// The /** */ doc comment attached to a statement: the LAST comment range in
// its leading trivia, when it opens with the double-star marker. Returns the
// raw comment text or null.
function docCommentOf(sf, node) {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart())
  if (!ranges || ranges.length === 0) return null
  const last = ranges[ranges.length - 1]
  const text = sf.text.slice(last.pos, last.end)
  return text.startsWith('/**') && text !== '/**/' ? text : null
}

// Summary of a doc comment: content lines (star decoration stripped) from
// the first non-empty line up to the first block tag. Empty string when the
// comment opens straight into tags -- exactly what this gate rejects.
function docSummary(text) {
  const body = text.replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
  const lines = body.split('\n').map((l) => l.replace(/^\s*\*? ?/, '').trim())
  const summary = []
  for (const line of lines) {
    if (line.startsWith('@')) break
    summary.push(line)
  }
  return summary.join(' ').trim()
}

const misses = []
let exportsChecked = 0

for (const p of files) {
  const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true)

  // Local top-level declarations by name, for `export { ... }` lists that
  // re-export a symbol declared without the export keyword.
  const localByName = new Map()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) localByName.set(st.name.text, st)
    else if (
      (ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    )
      localByName.set(st.name.text, st)
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) localByName.set(d.name.text, st)
  }

  const prevOverloadNames = new Set()
  for (const st of sf.statements) {
    const hasExport = (ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    )

    // export { a, type B } -- resolve each name to its local declaration;
    // type-only elements are exempt (duplicates of documented types), and
    // names imported from another module are re-exports (doc at the source).
    if (ts.isExportDeclaration(st)) {
      if (!st.exportClause || !ts.isNamedExports(st.exportClause)) continue // `export ... from`
      for (const el of st.exportClause.elements) {
        // whole-list `export type { ... }` (clause isTypeOnly) and per-element
        // `export { type X }` are both type-only duplicates -- exempt
        if (st.isTypeOnly || el.isTypeOnly) continue
        const decl = localByName.get(el.name.text)
        if (!decl) continue
        exportsChecked++
        const doc = docCommentOf(sf, decl)
        if (!doc || docSummary(doc) === '')
          misses.push(
            `${p}:~${sf.getLineAndCharacterOfPosition(el.name.getStart()).line + 1} export ${el.name.text}`,
          )
      }
      continue
    }

    // export default <expression> -- the barrel exemption (index.ts) covers
    // the only instance today, but non-barrel defaults stay checked.
    if (ts.isExportAssignment(st)) {
      exportsChecked++
      const doc = docCommentOf(sf, st)
      if (!doc || docSummary(doc) === '')
        misses.push(
          `${p}:~${sf.getLineAndCharacterOfPosition(st.getStart()).line + 1} export default`,
        )
      continue
    }

    if (!hasExport) continue
    exportsChecked++

    // Overload exception: same-name function declarations after the first.
    if (ts.isFunctionDeclaration(st) && st.name) {
      if (prevOverloadNames.has(st.name.text)) continue
      prevOverloadNames.add(st.name.text)
    }

    const name =
      ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st)
        ? (st.name?.text ?? 'default')
        : ts.isVariableStatement(st)
          ? st.declarationList.declarations.map((d) => d.name.getText()).join(', ')
          : 'default'
    const doc = docCommentOf(sf, st)
    if (!doc || docSummary(doc) === '')
      misses.push(
        `${p}:~${sf.getLineAndCharacterOfPosition(st.getStart()).line + 1} export ${name}`,
      )
  }
}

if (misses.length > 0) {
  console.error(
    `doc-coverage: ${misses.length} of ${exportsChecked} export(s) missing a doc comment with a non-empty summary line (docs/frontend-comments.md §2.1):\n`,
  )
  for (const m of misses) console.error('  ' + m)
  process.exit(1)
}
console.log(
  `doc-coverage: clean (${exportsChecked} exports across ${files.length} files, 100% documented)`,
)
