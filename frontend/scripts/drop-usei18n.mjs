#!/usr/bin/env node
// tz-i18n (ONE-SHOT codemod): replace the per-file useI18n boilerplate with
// the project-wide translator export.
//
//   import { useI18n } from 'vue-i18n'            -> removed
//   const { t } = useI18n({ useScope: 'global' }) -> removed
//   const { t } = i18n.global                     -> removed
// and `t` is imported from '@/locales' (merged into an existing import from
// that module when present, otherwise a dedicated line before the first
// import). locales/* and *.test.ts are skipped.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/components', 'src/views', 'src/composables', 'src/utils', 'src/stores', 'src/api']

const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.vue') || name.endsWith('.ts')) files.push(p)
  }
})(...ROOTS.map((r) => join(process.cwd(), r)))

let touched = 0
for (const file of files) {
  if (file.includes('locales')) continue
  if (file.endsWith('.test.ts')) continue
  let src = readFileSync(file, 'utf8')
  const hadUseI18n = src.includes('useI18n')
  const hadGlobalDestructure = src.includes('const { t } = i18n.global')
  if (!hadUseI18n && !hadGlobalDestructure) continue

  src = src.replace(/import \{ useI18n \} from 'vue-i18n'\n/, '')
  src = src.replace(/const \{ t \} = useI18n\(\{ useScope: 'global' \}\)\n/, '')
  src = src.replace(/const \{ t \} = i18n\.global\n/, '')

  // Ensure `t` is imported from '@/locales'.
  const braces = src.match(/import \{([^}]*)\} from '@\/locales'/)
  if (braces) {
    const names = braces[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!names.includes('t')) names.push('t')
    src = src.replace(braces[0], `import { ${names.join(', ')} } from '@/locales'`)
  } else if (/import i18n from '@\/locales'/.test(src)) {
    src = src.replace("import i18n from '@/locales'", "import i18n, { t } from '@/locales'")
  } else {
    const lines = src.split('\n')
    const firstImport = lines.findIndex((l) => /^import /.test(l))
    if (firstImport !== -1) {
      lines.splice(firstImport, 0, "import { t } from '@/locales'")
    } else {
      // no imports at all: the line must go INSIDE <script setup>
      const marker = '<script setup lang="ts">'
      const idx = lines.findIndex((l) => l.trim() === marker)
      lines.splice(idx + 1, 0, '', "import { t } from '@/locales'")
    }
    src = lines.join('\n')
  }

  writeFileSync(file, src)
  touched++
  console.log(file)
}
console.log(`done: ${touched} files`)
