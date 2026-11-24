import { describe, expect, it } from 'vitest'
import type { Result } from 'axe-core'
import { A11Y_ALLOWLIST } from '../../e2e/a11y/allowlist'
import {
  allowanceProblems,
  colorTokens,
  covers,
  declaredException,
  findingsOf,
  isDeclaredContrast,
  judge,
  normalizeTarget,
  pairFromCss,
  sameColor,
  unusedAllowances,
  type A11yAllowance,
  type Finding,
  type ResolvedPair,
  type RouteReport,
} from '../../e2e/a11y/findings'
import { SWEEP } from '../../e2e/sweep/routes'

// =============================================================================
// VELO Frontend -- the accessibility gate's rules (FE-241)
// =============================================================================
//
// e2e/a11y/ runs axe-core on every sweep route on each skin. Its verdict is
// pure logic (e2e/a11y/findings.ts), tested here without a browser: which
// violations the package's `contrastExceptions` waive, which the allowlist
// covers (and how narrowly), which entries a run left unused, and that the
// allowlist itself is whole (a reason, a task, real routes, a pinned element
// or color pair). The browser run is the CI job "e2e-a11y".
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

function finding(over: Partial<Finding> = {}): Finding {
  return { rule: 'heading-order', impact: 'moderate', target: 'h3', message: 'x', ...over }
}

function allowance(over: Partial<A11yAllowance> = {}): A11yAllowance {
  return {
    rule: 'heading-order',
    routes: ['user-dashboard'],
    target: 'h3',
    reason: 'a reason of a sentence',
    task: 'FE-1',
    ...over,
  }
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

describe('findingsOf', () => {
  const results = {
    violations: [
      violation('color-contrast', [
        contrastNode('#8293ac', '#ffffff', 3.12),
        contrastNode('#b2b2b2', '#ffffff', 2.12),
      ]),
      violation('label', [{ ...contrastNode('#000', '#fff', 21), any: [], target: ['input'] }]),
    ],
  }

  it('sets the declared pair aside and names the rest', () => {
    const { findings, waived } = findingsOf(results, PAIR)
    expect(waived).toHaveLength(1)
    expect(findings.map((f) => f.rule)).toEqual(['color-contrast', 'label'])
    expect(findings[0]?.message).toContain('#b2b2b2 on #ffffff, 2.12:1')
  })

  it('keeps every node when no pair is declared', () => {
    const { findings, waived } = findingsOf(results, null)
    expect(waived).toEqual([])
    expect(findings).toHaveLength(3)
  })
})

describe('what an allowance covers', () => {
  it('pins a non-contrast rule to the element, however the list is numbered', () => {
    const a = allowance({ target: '.students__row[role="button"]' })
    const row = finding({
      target: '.students__row[role="button"][data-v-b8c0302b=""]:nth-child(2)',
    })
    expect(covers(a, row, 'user-dashboard', 'gold')).toBe(true)
    // the same rule, another element of the same route stays open
    expect(covers(a, finding({ target: '.other-row' }), 'user-dashboard', 'gold')).toBe(false)
  })

  it('does not cover another route', () => {
    expect(covers(allowance(), finding(), 'user-diary', 'gold')).toBe(false)
  })

  it('holds only on its skins', () => {
    const a = allowance({ skins: ['gold'] })
    expect(covers(a, finding(), 'user-dashboard', 'gold')).toBe(true)
    expect(covers(a, finding(), 'user-dashboard', 'goodo')).toBe(false)
  })

  it('pins a contrast entry to its color pair', () => {
    const a = allowance({ rule: 'color-contrast', detail: '#b2b2b2 on #ffffff' })
    const ok = finding({ rule: 'color-contrast', message: 'x (#b2b2b2 on #ffffff, 2.12:1)' })
    const other = finding({ rule: 'color-contrast', message: 'x (#111111 on #222222, 1.2:1)' })
    expect(covers(a, ok, 'user-dashboard', 'gold')).toBe(true)
    expect(covers(a, other, 'user-dashboard', 'gold')).toBe(false)
  })

  it('judge counts what each entry covered and leaves the rest open', () => {
    const list = [allowance(), allowance({ target: 'h4' })]
    const { open, covered } = judge(
      [finding(), finding(), finding({ target: 'h5' })],
      list,
      'user-dashboard',
      'gold',
    )
    expect(open.map((f) => f.target)).toEqual(['h5'])
    expect([...covered]).toEqual([[0, 2]])
  })
})

describe('unused allowances', () => {
  const list = [
    allowance(),
    allowance({ target: 'h4' }),
    allowance({ target: 'h5', skins: ['goodo'] }),
  ]
  const report = (covered: Array<[number, number]>): RouteReport => ({
    route: 'user-dashboard',
    role: 'student',
    skin: 'gold',
    open: [],
    covered,
    waived: 0,
  })

  it('names an entry of this skin that covered nothing', () => {
    expect(unusedAllowances(list, [report([[0, 1]])], 'gold')).toEqual([1])
  })

  it('leaves out an entry of the other skin', () => {
    expect(
      unusedAllowances(
        list,
        [
          report([
            [0, 1],
            [1, 3],
          ]),
        ],
        'gold',
      ),
    ).toEqual([])
  })
})

describe('normalizeTarget', () => {
  it('drops the scoped-style hash and the list position', () => {
    expect(
      normalizeTarget(
        '.row[data-v-1a2b3c4d=""][data-v-9f9f9f9f=""]:nth-child(3) > .name:nth-child(1)',
      ),
    ).toBe('.row > .name')
  })
})

describe('the allowlist', () => {
  const visited = new Set(
    Object.entries(SWEEP)
      .filter(([, row]) => !('skip' in row))
      .map(([name]) => name),
  )

  it.each(A11Y_ALLOWLIST.map((a, i) => [i, a] as const))(
    'entry %i is whole and pinned',
    (_i, a) => {
      expect(allowanceProblems(a)).toEqual([])
      for (const route of a.routes) expect(visited, `route ${route}`).toContain(route)
      if (a.target !== undefined) expect(a.target).toBe(normalizeTarget(a.target))
    },
  )

  it('refuses an entry that switches a rule off for a whole route', () => {
    const { target: _target, ...bare } = allowance()
    expect(allowanceProblems(bare)).toContain('heading-order needs `target`')
    expect(allowanceProblems({ ...bare, rule: 'color-contrast' })).toContain(
      'contrast needs `detail`',
    )
    expect(allowanceProblems(allowance({ reason: '', task: 'later', routes: [] }))).toEqual([
      'no reason',
      'no task key',
      'no routes',
    ])
  })
})

describe('telling the build by the package', () => {
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

  it('lists the hex and rgba tokens of a DTCG file under their CSS names', () => {
    const doc = {
      velo: {
        primary: { $value: '#627A9C', dark: { $value: '#4c6589' } },
        text: { secondary: { $value: 'rgba(76, 101, 137, 0.7)' } },
        bg: { start: { $value: 'var(--velo-white)' } },
        radius: { $value: 12 },
      },
    }
    expect(colorTokens(doc)).toEqual([
      { css: '--velo-primary', value: '#627A9C' },
      { css: '--velo-primary-dark', value: '#4c6589' },
      { css: '--velo-text-secondary', value: 'rgba(76, 101, 137, 0.7)' },
    ])
  })

  it('compares what the package says with what the page paints, alpha included', () => {
    expect(sameColor('#627A9C', 'rgb(98, 122, 156)')).toBe(true)
    expect(sameColor('rgba(76, 101, 137, 0.7)', 'rgba(76, 101, 137, 0.7)')).toBe(true)
    // the same hue, another opacity: another build
    expect(sameColor('rgba(76, 101, 137, 0.7)', 'rgba(76, 101, 137, 0.5)')).toBe(false)
    expect(sameColor('#627a9c', 'rgb(18, 0, 84)')).toBe(false)
    expect(sameColor('#627a9c', '')).toBe(false)
  })
})
