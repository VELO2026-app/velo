#!/usr/bin/env node
// tz-i18n phase 3 finish (ONE-SHOT): replace positional mN keys in
// masterScreens/adminScreens with readable value-derived slugs.
//
// Slug = lowercase transliteration of the message text (vue-i18n syntax and
// interpolations stripped), hyphenated, first 4 words. Deduped per screen
// with a numeric suffix. The slug is derived FROM the ru text, so the ru
// catalog stays the source of truth; translators see slug + value together.
import { readFileSync, writeFileSync } from 'node:fs'

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

function slug(text, taken) {
  const bare = text
    .replace(/\{[^}]*\}/g, ' ') // interpolations -> separator
    .replace(/\{'[^']*'\}/g, ' ')
    .toLowerCase()
  let out = ''
  for (const ch of bare) out += TRANSLIT[ch] ?? ch
  const words = out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
  let base = words.join('-') || 'msg'
  let candidate = base
  let i = 2
  while (taken.has(candidate)) candidate = `${base}-${i++}`
  taken.add(candidate)
  return candidate
}

for (const file of ['src/locales/ru/master.json', 'src/locales/ru/admin.json']) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const section = file.includes('master') ? 'masterScreens' : 'adminScreens'
  const screens = data[section]
  let count = 0
  for (const [screen, ns] of Object.entries(screens)) {
    const taken = new Set()
    const newns = {}
    for (const [k, v] of Object.entries(ns)) {
      if (!/^m\d+$/.test(k)) {
        newns[k] = v
        continue
      }
      const s = slug(String(v), taken)
      newns[s] = v
      count++
      // rewrite the vue file reference
      const vue = `src/views/${file.includes('master') ? 'master' : 'admin'}/${screen[0].toUpperCase()}${screen.slice(1)}.vue`
      try {
        let src = readFileSync(vue, 'utf8')
        const full = `${section}.${screen}.${k}`
        src = src.split(`t('${full}')`).join(`t('${section}.${screen}.${s}')`)
        writeFileSync(vue, src)
      } catch {
        console.log(`VUE MISS: ${vue}`)
      }
    }
    screens[screen] = newns
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log(`${file}: ${count} keys slugged`)
}
