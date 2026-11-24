import { describe, expect, it } from 'vitest'
import { reportTitle } from '@/components/console/requests/reportTitle'

describe('reportTitle', () => {
  it.each([
    ['user', 'Жалоба на пользователя'],
    ['master', 'Жалоба на мастера'],
    ['practice', 'Жалоба на практику'],
  ])('titles a %s complaint by what it is about', (target_type, title) => {
    expect(reportTitle({ target_type })).toBe(title)
  })

  it('names an unknown target type as it came', () => {
    expect(reportTitle({ target_type: 'school' })).toBe('Жалоба: school')
  })
})
