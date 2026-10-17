#!/usr/bin/env node
// tz-i18n phase 3 (views) -- mechanical string extractor, ONE-SHOT per dir.
//
//   node scripts/views-keys.mjs src/views/user
//
// For every .vue file under the given dir:
//   - template TEXT nodes with Cyrillic  -> {{ t('views.<role>.<File>.mN') }}
//     ({{ expr }} inside the node becomes {pK} params of the message);
//   - template ATTR values with Cyrillic (static attrs only, not :bound/@) ->
//     :attr="t('views...mN')";
//   - SCRIPT string literals with Cyrillic -> t('views...mN'), EXCEPT lines
//     that look like logic over text (===, !==, .includes(, case ', ...);
//     those are REPORTED for manual refactor (tz-i18n §3.1);
//   - every key is appended to src/locales/ru.json verbatim (special chars
//     escaped for the vue-i18n compiler).
// The messages keep the exact on-screen text, so the verbatim test invariant
// holds.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/views-keys.mjs <views-subdir>')
  process.exit(2)
}
const absDir = join(process.cwd(), dir)
const role = dir.split('/').pop() // user | master | admin | auth | shells

const RU = join(process.cwd(), 'src/locales/ru.json')
const ru = JSON.parse(readFileSync(RU, 'utf8'))
if (!ru.views) ru.views = {}
if (!ru.views[role]) ru.views[role] = {}

const CYR = '[\\u0400-\\u04FF]'
const hasCyr = (s) => new RegExp(CYR).test(s)

// vue-i18n message-compiler specials -> literal escapes.
function escapeMessage(msg) {
  return msg
    .replace(/\{/g, "{'{'}")
    .replace(/\}/g, "{'}'}")
    .replace(/@/g, "{'@'}")
    .replace(/\|/g, "{'|'}")
}

// Lines whose string literals are LOGIC over text (tz-i18n §3.1) -- report,
// never auto-replace.
const LOGIC =
  /(===|!==)\s*['"`]|\.includes\(|\.startsWith\(|\.endsWith\(|\.indexOf\(|\bcase\s+['"`]|\.replace\(|\.match\(|\.split\(|\.trim\(\)\s*===|toUpperCase\(\)\s*===/

const ATTR = /^(\s*)([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"(.*)$/

function processFile(path) {
  const base = path.split('/').pop().replace(/\.vue$/, '')
  if (!ru.views[role][base]) ru.views[role][base] = {}
  const ns = `views.${role}.${base}`
  let n = 0
  const report = []

  let src = readFileSync(path, 'utf8')

  // -- split template / script so attr+text rules only touch the template --
  const tplStart = src.indexOf('<template>')
  const tplEnd = src.lastIndexOf('</template>')
  if (tplStart === -1 || tplEnd === -1) return { count: 0, report }
  let tpl = src.slice(tplStart, tplEnd + '</template>'.length)
  const script = src.slice(tplEnd + '</template>'.length)

  const key = (text) => {
    n += 1
    const k = `${ns}.m${n}`
    ru.views[role][base][`m${n}`] = escapeMessage(text)
    return k
  }

  // -- 1. static attribute values with Cyrillic -> bound t() --
  tpl = tpl
    .split('\n')
    .map((line) => {
      if (!hasCyr(line)) return line
      const m = line.match(ATTR)
      if (!m) return line
      const [, indent, attr, value, tail] = m
      if (attr.startsWith(':') || attr.startsWith('@') || attr.startsWith('v-')) return line
      if (!/^[^{}]*$/.test(value)) return line // has interpolations -> skip
      if (!hasCyr(value)) return line
      const k = key(value.trim())
      report.push(`attr ${attr}="${value.trim()}"`)
      return `${indent}:${attr}="t('${k}')"${tail}`
    })
    .join('\n')

  // -- 2. text nodes between tags --
  tpl = tpl
    .split('\n')
    .map((line) => {
      if (!hasCyr(line)) return line
      // text node segments: between a '>' (or standalone) and a '<'
      return line.replace(
        />([^<>{}]*)</g,
        (full, text) => {
          const trimmed = text.trim()
          if (!hasCyr(trimmed)) return full
          const k = key(trimmed)
          report.push(`text "${trimmed.slice(0, 50)}"`)
          return `>{{ t('${k}') }}<`
        },
      )
    })
    .join('\n')

  // -- 3. script string literals (single/double quoted, line has Cyrillic) --
  let scriptOut = script
    .split('\n')
    .map((line) => {
      if (!hasCyr(line)) return line
      if (LOGIC.test(line)) {
        report.push(`LOGIC (manual): ${line.trim().slice(0, 70)}`)
        return line
      }
      let changed = false
      const out = line.replace(
        /(['"])([^'"`\n]*[\u0400-\u04FF][^'"`\n]*)\1/g,
        (full, _q, text) => {
          const trimmed = text.trim()
          if (!trimmed) return full
          const k = key(trimmed)
          changed = true
          report.push(`script "${trimmed.slice(0, 50)}"`)
          return `t('${k}')`
        },
      )
      return changed ? out : line
    })
    .join('\n')

  src = src.slice(0, tplStart) + tpl + scriptOut

  // -- 4. ensure the t import inside <script setup> --
  if (n > 0 && !/import \{[^}]*\bt\b[^}]*\} from '@\/locales'/.test(src)) {
    const braces = src.match(/import \{([^}]*)\} from '@\/locales'/)
    if (braces) {
      const names = braces[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (!names.includes('t')) names.push('t')
      src = src.replace(braces[0], `import { ${names.join(', ')} } from '@/locales'`)
    } else {
      const marker = '<script setup lang="ts">'
      if (src.includes(marker)) {
        src = src.replace(marker, `${marker}\nimport { t } from '@/locales'`, 1)
      } else {
        console.log(`SKIP (no script setup): ${path}`)
        return { count: 0, report }
      }
    }
  }

  if (n > 0) writeFileSync(path, src)
  return { count: n, report }
}

const entries = readdirSync(absDir).filter((f) => f.endsWith('.vue'))
let total = 0
for (const name of entries) {
  const p = join(absDir, name)
  if (!statSync(p).isFile()) continue
  const { count, report } = processFile(p)
  if (count > 0) {
    total += count
    console.log(`${name}: ${count} keys`)
    for (const r of report) console.log(`   · ${r}`)
  }
}
writeFileSync(RU, JSON.stringify(ru, null, 2) + '\n')
console.log(`TOTAL: ${total} keys -> ru.json views.${role}`)
