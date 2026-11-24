// =============================================================================
// VELO Frontend -- no `:global()` with a neighbour in a scoped style (FE-261)
// =============================================================================
//
// In `<style scoped>` the Vue compiler replaces the WHOLE selector with the
// content of `:global(...)`: `:global(html.is-keyboard-open) .chat-thread`
// becomes `html.is-keyboard-open`, the descendant is lost, and the rule styles
// <html> instead of the element it was written for. Eight keyboard rules
// (chat, diary, onboarding, timezone picker) lived like that unnoticed.
//
// The working form needs no `:global()`: `html.is-keyboard-open .chat-thread`
// compiles to `html.is-keyboard-open .chat-thread[data-v-...]`, the scope
// attribute goes on the last compound. `:global(...)` stays legal only as a
// whole selector: `:global(.a .b) { }`.
//
// Scans every .vue file of the app and of the kit.
// =============================================================================

import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

const files = {
  ...import.meta.glob<string>('/src/**/*.vue', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../../packages/velo-ui/src/**/*.vue', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
}

/** Blank out comments and strings, keeping every newline, so offsets and line numbers survive. */
function blank(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, ' '))
}

/** Split a selector list on the commas that are not inside parentheses. */
function splitSelectors(prelude: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(prelude.slice(from, i))
      from = i + 1
    }
  }
  parts.push(prelude.slice(from))
  return parts
}

/** Remove every `:global(...)` / `::v-global(...)` call (balanced parentheses) from a selector. */
function withoutGlobalCalls(selector: string): { rest: string; found: boolean } {
  const call = /:{1,2}(?:v-)?global\(/g
  let rest = ''
  let from = 0
  let found = false
  for (let m = call.exec(selector); m; m = call.exec(selector)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < selector.length && depth > 0; i++) {
      if (selector[i] === '(') depth++
      else if (selector[i] === ')') depth--
    }
    rest += selector.slice(from, m.index)
    from = i
    call.lastIndex = i
    found = true
  }
  return { rest: rest + selector.slice(from), found }
}

/** `line: selector` of every scoped-style selector that has something next to its `:global()` call. */
function scopedGlobalViolations(vueSource: string): string[] {
  const { descriptor } = parse(vueSource)
  const found: string[] = []
  for (const style of descriptor.styles) {
    if (!style.scoped) continue
    const css = blank(style.content)
    let start = 0
    for (let i = 0; i < css.length; i++) {
      const ch = css[i]
      if (ch === ';' || ch === '}') {
        start = i + 1
      } else if (ch === '{') {
        const prelude = css.slice(start, i)
        if (!prelude.trim().startsWith('@')) {
          for (const selector of splitSelectors(prelude)) {
            const { rest, found: hasGlobal } = withoutGlobalCalls(selector)
            if (hasGlobal && rest.trim() !== '') {
              const lead = prelude.length - prelude.trimStart().length
              const line = style.loc.start.line + css.slice(0, start + lead).split('\n').length - 1
              found.push(`${line}: ${selector.trim().replace(/\s+/g, ' ')}`)
            }
          }
        }
        start = i + 1
      }
    }
  }
  return found
}

describe('scoped styles: :global() is a whole selector (FE-261)', () => {
  it('flags a :global() call that has a neighbour and accepts the whole-selector forms', () => {
    const sfc = (css: string): string =>
      `<template><div class="x" /></template>\n<style scoped>\n${css}\n</style>`
    const bad = [
      ':global(html.kbd) .x { color: red }',
      ':global(.a) > .x { color: red }',
      '.x :global(.a) { color: red }',
      '.x:global(.a) { color: red }',
      ':global(.a):hover { color: red }',
      '.x, :global(.a) .y { color: red }',
      '@media (min-width: 1px) { :global(.a) .x { color: red } }',
    ]
    for (const css of bad) expect(scopedGlobalViolations(sfc(css)), css).toHaveLength(1)

    const fine = [
      ':global(html.kbd) { color: red }',
      ':global(.a .x) { color: red }',
      ':global(.a), :global(.b) { color: red }',
      'html.kbd .x { color: red }',
      '/* :global(.a) .x { } */ .x { color: red }',
      '.x { content: ":global(.a) .y"; }',
    ]
    for (const css of fine) expect(scopedGlobalViolations(sfc(css)), css).toEqual([])

    // The report names the line of the selector inside the .vue file.
    expect(scopedGlobalViolations(sfc('.x { }\n\n:global(html.kbd) .x { color: red }'))).toEqual([
      '5: :global(html.kbd) .x',
    ])
  })

  it('no scoped style of the app or the kit has a :global() call with a neighbour', () => {
    const sources = Object.entries(files)
    expect(sources.length).toBeGreaterThan(100) // the glob saw the codebase
    expect(sources.some(([path]) => path.includes('/velo-ui/src/'))).toBe(true) // ...and the kit
    const violations = sources.flatMap(([path, source]) =>
      scopedGlobalViolations(source).map((v) => `${path}:${v}`),
    )
    expect(violations).toEqual([])
  })
})
