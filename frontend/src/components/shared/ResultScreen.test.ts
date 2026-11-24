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
//   1. MobileLayout.vue holds a rule `.mobile-layout__main--fog:has(.<class>)`
//      that sets `mask-image: none` and `-webkit-mask-image: none`;
//   2. the root element ResultScreen renders carries `<class>`.
// Renaming either side alone leaves a green build and a broken screen:
// happy-dom computes neither :has() nor masks, so the layout itself is
// browser-verified (the top strip painted as page background under the fog).
// This test reads the rule out of the MobileLayout sources with the real CSS
// parser of @vue/compiler-sfc and matches it against the rendered DOM.
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

const FOG_LIFT = /\.mobile-layout__main--fog:has\(\.([\w-]+)\)/

describe('fog mask lift: MobileLayout rule <-> ResultScreen root', () => {
  it('MobileLayout drops the fog mask for a class that ResultScreen renders on its root', () => {
    const lift = styleRules(mobileLayoutSource).find(
      (rule) => FOG_LIFT.test(rule.selector) && rule.decls['mask-image'] === 'none',
    )

    expect(lift?.decls['-webkit-mask-image']).toBe('none')
    const keyedClass = FOG_LIFT.exec(lift?.selector ?? '')?.[1] ?? ''

    const wrapper = mount(ResultScreen, { props: { title: 'Check-in sent' } })
    expect(wrapper.classes()).toContain(keyedClass)
  })
})
