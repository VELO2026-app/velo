import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Distribution from './PracticeMoodDistribution.vue'
import Analytics from './PracticeAnalytics.vue'
import type { PracticeAnalyticsData } from './analytics'
import { countMoods, formatPercent } from './analytics'

describe('practice analytics snippets', () => {
  it('does not round a real response to 0% or an incomplete distribution to 100%', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.001)).toBe('<1%')
    expect(formatPercent(99.999)).toBe('>99%')
    expect(formatPercent(100)).toBe('100%')
  })
  it('excludes missing and invalid responses from the denominator', () => {
    const answers = [null, 0, 1, 2, 3, 10, 11, NaN, Infinity].map((score, i) => ({
      userId: String(i),
      name: 'Ученик',
      before: score,
      after: null,
      comment: null,
    }))
    expect(countMoods(answers, 'before')).toEqual({ bad: 2, low: 1, neutral: 0, good: 0, fire: 1 })
    expect(countMoods(answers, 'after')).toEqual({ bad: 0, low: 0, neutral: 0, good: 0, fire: 0 })
  })
  it('always keeps tiny and large percentages inside their segments', async () => {
    const wrapper = mount(Distribution, {
      props: {
        title: 'До практики',
        participants: 10000,
        counts: { bad: 1, low: 0, neutral: 0, good: 0, fire: 9999 },
      },
    })
    expect(wrapper.findAll('.distribution__segment').map((segment) => segment.text())).toEqual([
      '<1%',
      '>99%',
    ])
    expect(wrapper.find('.distribution__outside').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('.distribution__details').isVisible()).toBe(true)
    expect(wrapper.get('.distribution__details').text()).toContain('(1) <1%')
    expect(wrapper.findAll('.distribution__segment').map((segment) => segment.text())).toEqual([
      '<1%',
      '>99%',
    ])
    await wrapper.setProps({ counts: { bad: 1, low: 1, neutral: 1, good: 1, fire: 9996 } })
    expect(wrapper.findAll('.distribution__segment').map((segment) => segment.text())).toEqual([
      '<1%',
      '<1%',
      '<1%',
      '<1%',
      '>99%',
    ])
    wrapper.unmount()
  })
  it('shows a truthful empty state and supports a single 100% segment', async () => {
    const wrapper = mount(Distribution, {
      props: {
        title: 'До практики',
        participants: 22,
        counts: { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 },
      },
    })
    expect(wrapper.text()).toContain('Пока нет отметок')
    expect(wrapper.find('button').exists()).toBe(false)
    await wrapper.setProps({ counts: { bad: 0, low: 0, neutral: 0, good: 0, fire: 20 } })
    await flushPromises()
    expect(wrapper.findAll('.distribution__segment')).toHaveLength(1)
    expect(wrapper.get('.distribution__segment').attributes('aria-label')).toContain('100%')
    wrapper.unmount()
  })
})

describe('practice screen', () => {
  it('counts only complete pairs, displays comments, reveals and resets the list', async () => {
    const practice = {
      id: 'p1',
      title: 'Вечерний холотроп',
      direction: 'breathwork',
      scheduled_at: '2026-08-14T18:00:00Z',
      timezone: 'Europe/Berlin',
      master_name: 'Alex Mindful',
      checkin_count: null,
    } as PracticeAnalyticsData['practice']
    const answers = Array.from({ length: 13 }, (_, i) => ({
      userId: String(i),
      name: `Ученик ${i}`,
      before: 2,
      after: 10,
      comment: i === 0 ? 'Спасибо!' : null,
    }))
    const data: PracticeAnalyticsData = {
      practice,
      participants: 22,
      answers: [
        ...answers,
        { userId: 'missing', name: 'Без пары', before: 2, after: null, comment: '   ' },
      ],
    }
    const wrapper = mount(Analytics, { props: { data } })
    expect(wrapper.findAll('.practice-analytics__pair')).toHaveLength(4)
    expect(wrapper.findAll('.practice-analytics__review')).toHaveLength(1)
    expect(wrapper.get('.practice-analytics__pairs').text()).toContain('13 из 22')
    expect(wrapper.get('.practice-analytics__meta').text()).not.toContain('Чек-ины:')
    await wrapper.get('.practice-analytics__pairs button').trigger('click')
    expect(wrapper.findAll('.practice-analytics__pair')).toHaveLength(13)
    await wrapper.setProps({ data: { ...data, practice: { ...practice, id: 'p2' } } })
    expect(wrapper.findAll('.practice-analytics__pair')).toHaveLength(4)
    wrapper.unmount()
  })
  it('renders loading and recoverable error without fabricating empty statistics', async () => {
    const wrapper = mount(Analytics, { props: { data: null, loading: true } })
    expect(wrapper.get('[role="status"]').text()).toContain('Загружаем')
    expect(wrapper.find('.distribution').exists()).toBe(false)
    await wrapper.setProps({ loading: false, error: 'Сеть недоступна' })
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Повторить')!
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    wrapper.unmount()
  })
})
