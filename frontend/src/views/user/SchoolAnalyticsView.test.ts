// =============================================================================
// VELO Frontend -- SchoolAnalyticsView Screen Tests (tz-curator.md §6, part 1)
// =============================================================================
//
// ONE screen, both zones, one aggregate per period: the period slider asks
// for week by default and refetches with the selected period, the four
// engagement cards render the server numbers verbatim («приходило из N в
// школе» borrows N from members.students), an out-of-order response never
// lands under a newer period label, a failed switch is the honest retry
// state (never stale numbers under a new label), the masked 404 is the
// SCHOOL being unavailable and its «К школе» action follows the zone. The
// route table is pinned in router/routes.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SchoolAnalyticsView from '@/views/user/SchoolAnalyticsView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupAnalyticsResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
const routeState = {
  name: 'user-curator-group-analytics',
  id: 'g1',
}
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: routeState.id }, name: routeState.name }),
  useRouter: () => ({ push, replace }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SchoolAnalyticsView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function buttonWith(label: string): HTMLButtonElement | null {
  return (
    (Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined) ?? null
  )
}

function analyticsFixture(): CuratorGroupAnalyticsResponse {
  return {
    practices: { total: 5, completed: 3, upcoming: 2 },
    members: { masters: 2, students: 7 },
    engagement: {
      practices_conducted: 3,
      attendees: 4,
      repeat_attendees: 2,
      repeat_pct: 50,
      joined_never_came: 3,
      // BE-107: the share is reviews out of visits, computed by the server
      // (was reviewers / members.students on the client). reviews is the
      // strip's sum (1 + 3 + 1); visits (8) differs from the roster (7) on
      // purpose, so a client still dividing by students would show «из 7».
      visits: 8,
      reviews: 5,
      reviews_pct: 63,
      rating: { bad: 1, low: 0, neutral: 0, good: 3, fire: 1 },
      conducted_practices: [
        {
          practice_id: 'p2',
          title: 'Медитация',
          direction: 'meditation',
          master_name: 'Teacher',
          scheduled_at: '2026-10-02T19:00:00+00:00',
          timezone: 'UTC',
          attendees_count: 2,
          checkins_count: 1,
          master_avatar_url: null,
          reviews_count: 1,
          rating: { bad: 0, low: 0, neutral: 0, good: 0, fire: 1 },
        },
        {
          practice_id: 'p1',
          title: 'Дыхание',
          direction: 'breathwork',
          master_name: 'Vera',
          scheduled_at: '2026-10-01T18:00:00+00:00',
          timezone: 'UTC',
          attendees_count: 3,
          checkins_count: 2,
          master_avatar_url: null,
          reviews_count: 1,
          rating: { bad: 1, low: 0, neutral: 0, good: 0, fire: 0 },
        },
      ],
    },
    feedback: {
      checkins_count: 3,
      reviews_count: 4,
      // BE-77: the mood distribution is five zones too (was low/mid/high).
      mood: { bad: 1, low: 0, neutral: 2, good: 0, fire: 0 },
      rating: { bad: 1, low: 0, neutral: 0, good: 2, fire: 1 },
    },
    top_practices: [],
  }
}

describe('SchoolAnalyticsView', () => {
  beforeEach(() => {
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockResolvedValue(analyticsFixture())
  })

  afterEach(() => {
    app?.unmount()
    app = null
    host?.remove()
    host = null
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockReset()
    vi.clearAllMocks()
  })

  it('renders the four period cards; the first fetch is the default week', async () => {
    mount()
    await flush()

    expect(text()).toContain('Практик проведено')
    // Card 2's denominator is the roster's student count.
    expect(text()).toContain('Человек приходило из 7 в школе')
    expect(text()).toContain('50%')
    expect(text()).toContain('Пришли еще раз, 2 из 4')
    expect(text()).toContain('Вступили и не пришли')
    expect(vi.mocked(cgApi.getCuratorGroupAnalytics)).toHaveBeenCalledWith('g1', 'week')
  })

  it('renders the period practices: one line over a bare strip', async () => {
    mount()
    await flush()

    // The section heading follows the slider (default week).
    expect(text()).toContain('Практики недели')
    // Newest first: Медитация above Дыхание.
    expect(text()).toContain('Медитация')
    expect(text()).toContain('Дыхание')
    // ONE line: date · students · feedbacks.
    expect(text()).toContain('Ученики: 2')
    expect(text()).toContain('Ученики: 3')
    expect(text()).toContain('Фидбеки: 1')
    // Bare five-color strips: one per practice, nothing else on them.
    expect(host?.querySelectorAll('.school-analytics__practice-strip')).toHaveLength(2)
  })

  it('the slider refetches with the selected period and swaps the numbers', async () => {
    const monthFixture = {
      ...analyticsFixture(),
      members: { masters: 2, students: 40 },
      engagement: {
        practices_conducted: 9,
        attendees: 8,
        repeat_attendees: 7,
        repeat_pct: 60,
        joined_never_came: 5,
        visits: 12,
        reviews: 9,
        reviews_pct: 75,
        rating: { bad: 1, low: 1, neutral: 2, good: 2, fire: 3 },
      },
      // Deliberately WITHOUT conducted_practices: this fixture stands for
      // the not-yet-caught-up backend (see the assertion below).
    } as unknown as CuratorGroupAnalyticsResponse
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockImplementation((_id, period) =>
      Promise.resolve(period === 'month' ? monthFixture : analyticsFixture()),
    )
    mount()
    await flush()

    buttonWith('Месяц')?.click()
    await flush()

    expect(vi.mocked(cgApi.getCuratorGroupAnalytics)).toHaveBeenCalledWith('g1', 'month')
    expect(text()).toContain('Человек приходило из 40 в школе')
    expect(text()).toContain('60%')
    expect(text()).toContain('Пришли еще раз, 7 из 8')
    // The month fixture predates part 3 (the «бек доедет» case): the
    // heading follows the slider, the list degrades to its empty state.
    expect(text()).toContain('Практики месяца')
    expect(text()).toContain('Пока нет практик за этот период')
  })

  it('an out-of-order response never lands under a newer period label', async () => {
    let resolveMonth!: (value: CuratorGroupAnalyticsResponse) => void
    const quarterFixture: CuratorGroupAnalyticsResponse = {
      ...analyticsFixture(),
      engagement: {
        practices_conducted: 9,
        attendees: 8,
        repeat_attendees: 7,
        repeat_pct: 60,
        joined_never_came: 5,
        visits: 12,
        reviews: 9,
        reviews_pct: 75,
        rating: { bad: 1, low: 1, neutral: 2, good: 2, fire: 3 },
        conducted_practices: [],
      },
    }
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockImplementation((_id, period) => {
      if (period === 'month') {
        return new Promise((resolve) => {
          resolveMonth = resolve
        })
      }
      return Promise.resolve(period === 'quarter' ? quarterFixture : analyticsFixture())
    })
    mount()
    await flush()
    expect(text()).toContain('63% · 5 из 8')

    // Tap Месяц, then Квартал before Месяц answers; the late month
    // response must not overwrite the quarter numbers.
    buttonWith('Месяц')?.click()
    await flush()
    buttonWith('Квартал')?.click()
    await flush()
    expect(text()).toContain('60%')
    expect(text()).toContain('75% · 9 из 12')

    resolveMonth(analyticsFixture())
    await flush()
    expect(text()).toContain('75% · 9 из 12')
    expect(text()).not.toContain('63% · 5 из 8')
  })

  it('a failed switch is the honest retry state; retry recovers', async () => {
    vi.mocked(cgApi.getCuratorGroupAnalytics)
      .mockResolvedValueOnce(analyticsFixture())
      .mockRejectedValueOnce(new Error('blip'))
    mount()
    await flush()
    expect(text()).toContain('Практик проведено')

    buttonWith('Месяц')?.click()
    await flush()
    expect(text()).toContain('Не удалось загрузить аналитику')
    expect(text()).not.toContain('Практик проведено')

    buttonWith('Повторить')?.click()
    await flush()
    expect(text()).toContain('Практик проведено')
  })

  it('an empty school renders honest zeros, not dashes', async () => {
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockResolvedValue({
      ...analyticsFixture(),
      members: { masters: 0, students: 0 },
      engagement: {
        practices_conducted: 0,
        attendees: 0,
        repeat_attendees: 0,
        repeat_pct: 0,
        joined_never_came: 0,
        visits: 0,
        reviews: 0,
        reviews_pct: 0,
        rating: { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 },
        conducted_practices: [],
      },
    })
    mount()
    await flush()

    expect(text()).toContain('Человек приходило из 0 в школе')
    expect(text()).toContain('Пришли еще раз, 0 из 0')
    expect(text()).toContain('0%')
    expect(text()).toContain('Пока нет практик за этот период')
  })

  it('renders the feedback block: percent line and the colored strip', async () => {
    mount()
    await flush()

    expect(text()).toContain('Процент фидбеков')
    // 5 reviews out of 8 visits, the server's numbers verbatim -- not the
    // 7 students of the roster (BE-107).
    expect(text()).toContain('63% · 5 из 8')
    // bad 1 + good 3 + fire 1 -> 20% / 60% / 20% segments (60% is unique
    // on the screen, unlike 50% which card 3 also carries).
    expect(text()).toContain('60%')
    // «Расшифровка» ships hidden (v-show): in the DOM, not displayed.
    const details = () => host?.querySelector<HTMLElement>('.distribution__details')
    expect(details()).toBeTruthy()
    expect(details()?.style.display).toBe('none')

    buttonWith('Расшифровка')?.click()
    await flush()
    expect(details()?.style.display).not.toBe('none')
    // The five mood-scale gradations, zero-count ones included.
    expect(text()).toContain('Плохо')
    expect(text()).toContain('Не очень')
    expect(text()).toContain('Нормально')
    expect(text()).toContain('(1) 20%')
    expect(text()).toContain('(3) 60%')
    expect(text()).toContain('(0) 0%')
  })

  it('a period without reviews shows the honest empty state', async () => {
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockResolvedValue({
      ...analyticsFixture(),
      engagement: {
        ...analyticsFixture().engagement,
        reviews: 0,
        reviews_pct: 0,
        rating: { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 },
      },
    })
    mount()
    await flush()

    expect(text()).toContain('Пока нет отзывов')
    expect(text()).toContain('0% · 0 из 8')
    // The main block (no reviews) shows its empty text; the practice cards'
    // bare strips never carry a «Расшифровка» button at all.
    const showMoreButtons = () =>
      Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter(
        (b) => b.textContent?.trim() === 'Расшифровка',
      )
    expect(showMoreButtons().length).toBe(0)
  })

  it('a pre-contract payload (no engagement yet) renders the scaffold, not a crash', async () => {
    // «Бек доедет»: until the real backend ships the contract, an older
    // payload renders the honest zero scaffold -- zero cards + the empty
    // feedback block -- and the screen stays alive.
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockResolvedValue({
      practices: { total: 0, completed: 0, upcoming: 0 },
      members: { masters: 0, students: 7 },
      feedback: {
        checkins_count: 0,
        reviews_count: 0,
        mood: { low: 0, mid: 0, high: 0 },
        rating: { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 },
      },
      top_practices: [],
    } as unknown as CuratorGroupAnalyticsResponse)
    mount()
    await flush()

    expect(text()).toContain('Практик проведено')
    expect(text()).toContain('Человек приходило из 7 в школе')
    // No engagement in the payload: the share reads 0 of 0 (the
    // denominator is visits, which the payload does not carry).
    expect(text()).toContain('0% · 0 из 0')
    expect(text()).toContain('Пока нет отзывов')
  })

  it('404 is the school being unavailable; «К школе» follows the zone (user)', async () => {
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Школа недоступна')
    buttonWith('К школе')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'user-curator-group', params: { id: 'g1' } })
  })

  it('the master zone backs into the master school page', async () => {
    routeState.name = 'master-curator-group-analytics'
    vi.mocked(cgApi.getCuratorGroupAnalytics).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()

    buttonWith('К школе')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-curator-group', params: { id: 'g1' } })
  })

  // BE-78 (2): a practice card opens «Аналитика по практике» -- in the MASTER
  // zone only; the user-zone mount stays inert (FE-93 removes it).
  it('master zone: tapping a period practice opens its analytics by id', async () => {
    routeState.name = 'master-curator-group-analytics'
    mount()
    await flush()

    host!.querySelectorAll<HTMLElement>('.school-analytics__practice')[1]!.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-practice-reviews', params: { id: 'p1' } })
  })

  it('user zone: the same card is not a link', async () => {
    routeState.name = 'user-curator-group-analytics'
    mount()
    await flush()

    host!.querySelectorAll<HTMLElement>('.school-analytics__practice')[0]!.click()
    await flush()
    expect(push).not.toHaveBeenCalled()
  })
})
