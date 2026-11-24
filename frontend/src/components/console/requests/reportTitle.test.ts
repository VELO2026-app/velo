import { describe, expect, it } from 'vitest'
import { reportTitle } from '@/components/console/requests/reportTitle'

describe('reportTitle', () => {
  it.each([
    ['user', 'Жалоба: Юзер'],
    ['master', 'Жалоба: Мастер'],
    ['practice', 'Жалоба: Практика'],
  ])('titles a %s complaint with the target label of the admin helpers', (target_type, title) => {
    expect(reportTitle({ target_type })).toBe(title)
  })

  it('names an unknown target type as it came', () => {
    expect(reportTitle({ target_type: 'school' })).toBe('Жалоба: school')
  })
})
