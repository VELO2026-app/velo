import { describe, expect, it } from 'vitest'
import type { Result } from 'axe-core'
import { A11Y_ALLOWLIST } from '../../e2e/a11y/allowlist'
import {
  covers,
  declaredException,
  findingsOf,
  hexTokens,
  isDeclaredContrast,
  judge,
  pairFromCss,
  type Finding,
  type ResolvedPair,
} from '../../e2e/a11y/findings'
import { SWEEP } from '../../e2e/sweep/routes'

// =============================================================================
// VELO Frontend -- the accessibility gate's rules (FE-241)
// =============================================================================
//
// e2e/a11y/ runs axe-core on every sweep route on each skin. Its verdict is
// pure logic (e2e/a11y/findings.ts), tested here without a browser: which
// violations the package's `contrastExceptions` waive, which the allowlist
// covers, and that the allowlist itself is whole (a reason, a task, real
// routes). The browser run is the CI job "e2e-stack".
// =============================================================================

const PAIR: ResolvedPair = { text: '#8293ac', surface: '#ffffff' }

/** One color-contrast node the way axe reports it. */
function contrastNode(fg: string, bg: string, ratio: number): Result['nodes'][number] {
  return {
    html: '<span></span>',
    target: ['.label'],
    any: [
      {
        id: 'color-contrast',
        data: { fgColor: fg, bgColor: bg, contrastRatio: ratio },
        relatedNodes: [],
        impact: 'serious',
        message: '',
      },
    ],
    all: [],
    none: [],
  } as Result['nodes'][number]
}

function violation(id: string, nodes: Result['nodes']): Result {
  return { id, impact: 'serious', help: `help of ${id}`, nodes } as Result
}

describe('the declared contrast exception', () => {
  it('waives the declared pair at 3.12:1', () => {
    expect(isDeclaredContrast(contrastNode('#8293ac', '#ffffff', 3.12), PAIR)).toBe(true)
  })

  it('does not waive a ratio under the 3:1 floor', () => {
    expect(isDeclaredContrast(contrastNode('#8293ac', '#ffffff', 2.9), PAIR)).toBe(false)
  })

  it('does not waive another pair at the same ratio', () => {
    expect(isDeclaredContrast(contrastNode('#b2b2b2', '#ffffff', 3.12), PAIR)).toBe(false)
  })

  it('waives nothing when the package declares nothing', () => {
    expect(isDeclaredContrast(contrastNode('#8293ac', '#ffffff', 3.12), null)).toBe(false)
  })

  it('reads the pair of the package record only for the allowed token paths', () => {
    const ok = { text: 'velo.text.secondary', surface: 'velo.bg.card.solid', reason: 'x' }
    expect(declaredException([ok])).toBe(ok)
    expect(declaredException([{ ...ok, text: 'velo.text.primary' }])).toBeNull()
  })
})

describe('findingsOf and judge', () => {
  const results = {
    violations: [
      violation('color-contrast', [
        contrastNode('#8293ac', '#ffffff', 3.12),
        contrastNode('#b2b2b2', '#ffffff', 2.12),
      ]),
      violation('label', [{ ...contrastNode('#000', '#fff', 21), any: [], target: ['input'] }]),
    ],
  }

  it('drops only the declared pair and names the rest', () => {
    const found = findingsOf(results, PAIR)
    expect(found.map((f) => f.rule)).toEqual(['color-contrast', 'label'])
    expect(found[0]?.message).toContain('#b2b2b2 on #ffffff, 2.12:1')
  })

  it('lets an allowance cover one rule on its routes and nothing else', () => {
    const found = findingsOf(results, PAIR)
    const allowance = {
      rule: 'color-contrast',
      routes: ['user-dashboard'],
      detail: '#b2b2b2 on #ffffff',
      reason: 'r',
      task: 'FE-1',
    }
    expect(judge(found, [allowance], 'user-dashboard', 'gold').open.map((f) => f.rule)).toEqual([
      'label',
    ])
    // another route: the contrast finding stays open
    expect(judge(found, [allowance], 'user-diary', 'gold').open).toHaveLength(2)
  })

  it('keeps a finding of the same rule open when its colors differ from the allowance', () => {
    const finding: Finding = {
      rule: 'color-contrast',
      impact: 'serious',
      target: 'p',
      message: 'x (#111111 on #222222, 1.2:1)',
    }
    const allowance = {
      rule: 'color-contrast',
      routes: ['r'],
      detail: '#b2b2b2 on #ffffff',
      reason: 'r',
      task: 'FE-1',
    }
    expect(covers(allowance, finding, 'r', 'goodo')).toBe(false)
  })
})

describe('the allowlist', () => {
  const visited = new Set(
    Object.entries(SWEEP)
      .filter(([, row]) => !('skip' in row))
      .map(([name]) => name),
  )

  it.each(A11Y_ALLOWLIST.map((a, i) => [i, a] as const))(
    'entry %i has a reason, a task and visited routes',
    (_i, a) => {
      expect(a.reason.length).toBeGreaterThan(10)
      expect(a.task).toMatch(/^(?:FE|BE)-\d+$/)
      expect(a.routes.length).toBeGreaterThan(0)
      for (const route of a.routes) expect(visited, `route ${route}`).toContain(route)
    },
  )
})

describe('reading the page and the package', () => {
  it('blends a translucent text color over the surface the way axe does', () => {
    expect(pairFromCss('rgba(76, 101, 137, 0.7)', 'rgb(255, 255, 255)')).toEqual({
      text: '#8293ac',
      surface: '#ffffff',
    })
  })

  it('gives no pair for a surface that is not opaque or a color it cannot read', () => {
    expect(pairFromCss('rgb(0, 0, 0)', 'rgba(255, 255, 255, 0.5)')).toBeNull()
    expect(pairFromCss('color(srgb 1 0 0)', 'rgb(255, 255, 255)')).toBeNull()
  })

  it('lists the plain-hex tokens of a DTCG file under their CSS names', () => {
    const doc = {
      velo: {
        primary: { $value: '#627A9C', dark: { $value: '#4c6589' } },
        text: { secondary: { $value: 'rgba(76, 101, 137, 0.7)' } },
        radius: { $value: 12 },
      },
    }
    expect(hexTokens(doc)).toEqual([
      { css: '--velo-primary', hex: '#627a9c' },
      { css: '--velo-primary-dark', hex: '#4c6589' },
    ])
  })
})
