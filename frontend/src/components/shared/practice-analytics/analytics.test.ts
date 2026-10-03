import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Distribution from './PracticeMoodDistribution.vue'
import Analytics from './PracticeAnalytics.vue'
import type {
  PracticeAnalyticsPair,
  PracticeAnalyticsResponse,
  PracticeAnalyticsReview,
} from '@/api/types'
import { formatPercent } from './analytics'

describe('practice analytics snippets', () => {
  it('does not round a real response to 0% or an incomplete distribution to 100%', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.001)).toBe('<1%')
    expect(formatPercent(99.999)).toBe('>99%')
    expect(formatPercent(100)).toBe('100%')
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

// BE-78: the screen renders the SERVER's numbers -- zones arrive as
// ScoreZone, distributions as ScoreZoneCounts, and every "X из N" divides by
// `attended`. The former client-side zone counting (countMoods over raw
// 1..10 answers) is gone together with the raw answers.
function summary(overrides: Partial<PracticeAnalyticsResponse> = {}): PracticeAnalyticsResponse {
  return {
    practice_id: 'p1',
    title: 'Вечерний холотроп',
    direction: 'breathwork',
    scheduled_at: '2026-08-14T18:00:00Z',
    timezone: 'Europe/Berlin',
    master_name: 'Alex Mindful',
    master_avatar_url: null,
    attended: 22,
    before: { bad: 13, low: 0, neutral: 2, good: 0, fire: 0 },
    after: { bad: 0, low: 0, neutral: 0, good: 1, fire: 13 },
    pairs_total: 13,
    reviews_total: 1,
    ...overrides,
  }
}
const pair = (i: number): PracticeAnalyticsPair => ({
  user_id: `u${i}`,
  name: `Ученик ${i}`,
  avatar_url: null,
  before_zone: 'bad',
  after_zone: 'fire',
})
const review: PracticeAnalyticsReview = {
  user_id: 'u0',
  name: 'Ученик 0',
  avatar_url: null,
  comment: '  Спасибо!  ',
  created_at: '2026-08-14T20:00:00Z',
}

describe('practice screen', () => {
  it('renders the server zones, divides by attended and pages on request', async () => {
    const wrapper = mount(Analytics, {
      props: {
        summary: summary(),
        pairs: Array.from({ length: 4 }, (_, i) => pair(i)),
        reviews: [review],
      },
    })
    // «Чек-ины» is the «до» total (15), «Пришли» the attended (22).
    const meta = wrapper.get('.practice-analytics__meta').text()
    expect(meta).toContain('Пришли: 22')
    expect(meta).toContain('Чек-ины: 15')
    expect(wrapper.get('.practice-analytics__pairs').text()).toContain('13 из 22')
    expect(wrapper.get('.practice-analytics__reviews').text()).toContain('1 из 22')
    const pairs = wrapper.findAll('.practice-analytics__pair')
    expect(pairs).toHaveLength(4)
    expect(pairs[0]!.text()).toContain('Плохо')
    expect(pairs[0]!.text()).toContain('Огонь')
    const rv = wrapper.get('.practice-analytics__review')
    expect(rv.text()).toContain('«Спасибо!»')
    expect(rv.find('time').attributes('datetime')).toBe('2026-08-14T20:00:00Z')
    // 4 loaded of 13 -> a «Показать ещё» that asks the container for a page.
    await wrapper.get('.practice-analytics__pairs button').trigger('click')
    expect(wrapper.emitted('morePairs')).toHaveLength(1)
    // All reviews loaded (1 of 1) -> no reviews pager.
    expect(wrapper.get('.practice-analytics__reviews').find('button').exists()).toBe(false)
    wrapper.unmount()
  })
  it('a pager does not re-ask while its page is in flight', async () => {
    const wrapper = mount(Analytics, {
      props: { summary: summary(), pairs: [pair(0)], loadingMorePairs: true },
    })
    await wrapper.get('.practice-analytics__pairs button').trigger('click')
    expect(wrapper.emitted('morePairs')).toBeUndefined()
    wrapper.unmount()
  })
  it('renders loading and recoverable error without fabricating empty statistics', async () => {
    const wrapper = mount(Analytics, { props: { summary: null, loading: true } })
    expect(wrapper.get('[role="status"]').text()).toContain('Загружаем')
    expect(wrapper.find('.distribution').exists()).toBe(false)
    await wrapper.setProps({ loading: false, error: 'Сеть недоступна' })
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Повторить')!
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    wrapper.unmount()
  })
})
