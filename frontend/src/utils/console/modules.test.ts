import { describe, expect, it } from 'vitest'
import { consoleModuleOf, groupHasCaption } from '@/utils/console/modules'
import { consoleNavGroups } from '@/utils/console/nav'

describe('consoleNavGroups', () => {
  it('lists every module in menu groups when every instance option is on', () => {
    const groups = consoleNavGroups(() => true)

    expect(groups.map((g) => [g.key, g.modules.map((m) => m.key)])).toEqual([
      ['overview', ['dashboard']],
      ['people', ['masters', 'users', 'schools']],
      ['content', ['practices', 'catalog']],
      ['requests', ['moderation', 'support']],
      ['money', ['finance']],
      ['growth', ['analytics', 'mail']],
      ['system', ['settings']],
    ])
  })

  it('drops the module of an option the instance does not have', () => {
    const groups = consoleNavGroups((option) => option !== 'schools')

    expect(groups.find((g) => g.key === 'people')?.modules.map((m) => m.key)).toEqual([
      'masters',
      'users',
    ])
  })
})

describe('consoleModuleOf', () => {
  it.each([
    ['console-masters', 'masters'],
    ['console-masters-detail', 'masters'],
    ['console-mail', 'mail'],
    ['admin-masters', null],
    [undefined, null],
  ])('maps route %s to module %s', (name, key) => {
    expect(consoleModuleOf(name)).toBe(key)
  })
})

describe('groupHasCaption', () => {
  it('gives every group a caption except the overview', () => {
    expect(groupHasCaption('overview')).toBe(false)
    expect(groupHasCaption('people')).toBe(true)
  })
})
