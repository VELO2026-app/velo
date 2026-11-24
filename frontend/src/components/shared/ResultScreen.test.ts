// =============================================================================
// VELO Frontend -- ResultScreen <-> MobileLayout: the fog-mask lift contract
// =============================================================================
//
// The full-screen result takeover (check-in / feedback / reflection success,
// practice sold-out) sits inside the masked scroller of a fog screen, and its
// white layer would be clipped by the mask (a strip of page background under
// the fog). MobileLayout lifts the mask with
// `.mobile-layout__main--fog:has(.result-screen)` (FE-261).
//
// The two halves live in two files and nothing but this test ties them:
//   1. MobileLayout.vue holds a rule `.mobile-layout__main--fog:has(<args>)`
//      that sets `mask-image: none` and `-webkit-mask-image: none`;
//   2. the root element ResultScreen renders matches one of the `<args>`
//      (`:has()` takes a comma list, and an argument may nest parentheses).
// Renaming either side alone leaves a green build and a broken screen:
// happy-dom computes neither :has() nor masks, so the layout itself is
// browser-verified (the top strip painted as page background under the fog).
// This test reads the rule out of the MobileLayout sources with the real CSS
// parser of @vue/compiler-sfc, splits the :has() arguments on top-level commas
// and matches each one against the rendered ResultScreen root.
// =============================================================================

import { compileStyle, parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultScreen from '@/components/shared/ResultScreen.vue'
import mobileLayoutSource from '@/components/layout/MobileLayout.vue?raw'

interface CssRule {
  selector: string
  /** Declaration values by property name, the last write wins. */
  decls: Record<string, string>
}

/** Every style rule of a .vue file, with its selector and declarations. */
function styleRules(vueSource: string): CssRule[] {
  const rules: CssRule[] = []
  const collect = {
    postcssPlugin: 'collect-rules',
    Rule(rule: {
      selector: string
      walkDecls: (cb: (decl: { prop: string; value: string }) => void) => void
    }) {
      const decls: Record<string, string> = {}
      rule.walkDecls((decl) => {
        decls[decl.prop] = decl.value
      })
      rules.push({ selector: rule.selector, decls })
    },
  }
  for (const style of parse(vueSource).descriptor.styles) {
    compileStyle({
      source: style.content,
      filename: 'collect.vue',
      id: 'data-v-collect',
      postcssPlugins: [collect],
    })
  }
  return rules
}

/**
 * Splits a selector text on commas outside any `(...)` or `[...]` pair, and
 * stops at the first unmatched `)` (the end of a `:has(` argument list). It
 * does not read quoted strings, which the fog rule has none of.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') {
      depth--
      if (depth < 0) {
        parts.push(text.slice(start, i))
        return parts.map((part) => part.trim())
      }
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim())
}

const FOG_HAS = '.mobile-layout__main--fog:has('

/** The `:has()` arguments of every `.mobile-layout__main--fog:has(...)` in a selector list. */
function fogLiftArgs(selector: string): string[] {
  return splitTopLevel(selector).flatMap((complex) => {
    const at = complex.indexOf(FOG_HAS)
    return at < 0 ? [] : splitTopLevel(complex.slice(at + FOG_HAS.length))
  })
}

describe('fog mask lift: MobileLayout rule <-> ResultScreen root', () => {
  it('MobileLayout drops the fog mask for a :has() argument that matches the ResultScreen root', () => {
    const lift = styleRules(mobileLayoutSource).find(
      (rule) => fogLiftArgs(rule.selector).length > 0 && rule.decls['mask-image'] === 'none',
    )

    expect(lift?.decls['-webkit-mask-image']).toBe('none')

    const root = mount(ResultScreen, { props: { title: 'Check-in sent' } }).element
    // `:has(A, B)` fires when a descendant matches any argument.
    expect(fogLiftArgs(lift?.selector ?? '').some((arg) => root.matches(arg))).toBe(true)
  })
})
