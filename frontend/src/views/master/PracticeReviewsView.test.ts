// =============================================================================
// VELO Frontend -- PracticeReviewsView Screen Tests («Аналитика по практике»)
// =============================================================================
//
// BE-78: one screen for every entitled reader, on three server endpoints
// (/analytics, /analytics/pairs, /analytics/reviews). This view owns the
// requests and the paging; PracticeAnalytics renders (its own rendering
// tests live in practice-analytics/analytics.test.ts). So the assertions here
// are on what reaches the screen and what the paging asks for: the route's
// id, the offsets, append-not-replace, one request per tap, and an honest
// error with a way out. The previous screen of this route (insights +
// reviews, stat cards, the shared insights cache, tap-a-review navigation)
// and the ANALYTICS_SIMULATION demo were removed with BE-78, and their tests
// with them.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import PracticeReviewsView from '@/views/master/PracticeReviewsView.vue'
import * as practicesApi from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import type {
  PaginatedPracticeAnalyticsPairs,
  PaginatedPracticeAnalyticsReviews,
  PracticeAnalyticsPair,
  PracticeAnalyticsResponse,
} from '@/api/types'

vi.mock('@/api/practices')

// The DM modal is the BE-76 component; here only WHAT it is opened with.
vi.mock('@/components/shared/SendMessageModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: { open: Boolean, studentId: String, name: String },
      setup: (props) => () =>
        props.open ? h('div', { class: 'dm-stub', 'data-id': props.studentId }, props.name) : null,
    }),
  }
})

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

function summary(overrides: Partial<PracticeAnalyticsResponse> = {}): PracticeAnalyticsResponse {
  return {
    practice_id: 'p1',
    title: 'Утренняя медитация',
    direction: 'meditation',
    scheduled_at: '2026-08-14T07:00:00Z',
    timezone: 'Europe/Berlin',
    master_name: 'Анна Мастер',
    master_avatar_url: null,
    attended: 10,
    before: { bad: 1, low: 1, neutral: 2, good: 2, fire: 1 },
    after: { bad: 0, low: 0, neutral: 1, good: 3, fire: 4 },
    pairs_total: 3,
    reviews_total: 1,
    viewer_role: 'leader',
    curator_group_id: null,
    ...overrides,
  }
}

const pair = (i: number): PracticeAnalyticsPair => ({
  user_id: `u${i}`,
  name: `Ученик ${i}`,
  avatar_url: null,
  before_zone: 'low',
  after_zone: 'good',
  is_school_student: i === 0,
})

function pairsPage(items: PracticeAnalyticsPair[], total: number, offset = 0) {
  return { items, total, limit: 20, offset } satisfies PaginatedPracticeAnalyticsPairs
}

function reviewsPage(n: number, total: number, offset = 0) {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      user_id: `r${offset + i}`,
      name: `Автор ${offset + i}`,
      avatar_url: null,
      comment: `Текст ${offset + i}`,
      created_at: '2026-08-14T09:00:00Z',
      is_school_student: true,
    })),
    total,
    limit: 20,
    offset,
  } satisfies PaginatedPracticeAnalyticsReviews
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(PracticeReviewsView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

function pairNames(): string[] {
  return Array.from(
    host?.querySelectorAll('.practice-analytics__pair .practice-analytics__name') ?? [],
  ).map((el) => el.textContent?.trim() ?? '')
}

function reviewCount(): number {
  return host?.querySelectorAll('.practice-analytics__review').length ?? 0
}

function pager(section: '.practice-analytics__pairs' | '.practice-analytics__reviews') {
  return host?.querySelector(section)?.querySelector('button') ?? null
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  routeParams.id = 'p1'
  vi.mocked(practicesApi.getPracticeAnalytics).mockReset().mockResolvedValue(summary())
  vi.mocked(practicesApi.getPracticeAnalyticsPairs)
    .mockReset()
    .mockResolvedValue(pairsPage([pair(0)], 1))
  vi.mocked(practicesApi.getPracticeAnalyticsReviews)
    .mockReset()
    .mockResolvedValue(reviewsPage(1, 1))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('PracticeReviewsView', () => {
  describe('loading the screen', () => {
    it('asks all three endpoints for the id in the route, first pages from offset 0', async () => {
      routeParams.id = 'p42'
      mount()
      await flush()

      expect(practicesApi.getPracticeAnalytics).toHaveBeenCalledWith('p42')
      expect(practicesApi.getPracticeAnalyticsPairs).toHaveBeenCalledWith('p42', 20, 0)
      expect(practicesApi.getPracticeAnalyticsReviews).toHaveBeenCalledWith('p42', 20, 0)
    })

    it('renders the server summary: title, attended as the denominator', async () => {
      mount()
      await flush()

      expect(host?.textContent).toContain('Утренняя медитация')
      expect(host?.querySelector('.practice-analytics__meta')?.textContent).toContain('Пришли: 10')
      expect(host?.querySelector('.practice-analytics__pairs')?.textContent).toContain('3 из 10')
      expect(pairNames()).toEqual(['Ученик 0'])
      expect(reviewCount()).toBe(1)
    })

    it('a 404 (not entitled) is an error state with «Повторить», not an empty screen', async () => {
      vi.mocked(practicesApi.getPracticeAnalytics).mockRejectedValue(
        new ApiResponseError(404, 'Practice not found', 'not_found'),
      )
      mount()
      await flush()

      expect(host?.textContent).toContain('Не удалось загрузить аналитику')
      expect(host?.querySelector('.distribution')).toBeNull()
      expect(
        Array.from(host?.querySelectorAll('button') ?? []).some((b) =>
          b.textContent?.includes('Повторить'),
        ),
      ).toBe(true)
    })

    it('«Повторить» recovers a failed load into real content', async () => {
      vi.mocked(practicesApi.getPracticeAnalytics).mockRejectedValueOnce(new TypeError('net'))
      mount()
      await flush()
      const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('Повторить'),
      )
      retry?.click()
      await flush()

      expect(host?.textContent).toContain('Утренняя медитация')
      expect(practicesApi.getPracticeAnalytics).toHaveBeenCalledTimes(2)
    })
  })

  describe('paging', () => {
    it('pairs: «Показать ещё» only while loaded < total; pages from the loaded offset and APPENDS', async () => {
      vi.mocked(practicesApi.getPracticeAnalyticsPairs)
        .mockResolvedValueOnce(pairsPage([pair(0), pair(1)], 3))
        .mockResolvedValueOnce(pairsPage([pair(2)], 3, 2))
      mount()
      await flush()

      pager('.practice-analytics__pairs')?.click()
      await flush()

      expect(practicesApi.getPracticeAnalyticsPairs).toHaveBeenLastCalledWith('p1', 20, 2)
      expect(pairNames()).toEqual(['Ученик 0', 'Ученик 1', 'Ученик 2'])
      expect(pager('.practice-analytics__pairs')).toBeNull()
    })

    it('reviews: a second tap while a page is in flight does not fire a second request', async () => {
      vi.mocked(practicesApi.getPracticeAnalytics).mockResolvedValue(summary({ reviews_total: 3 }))
      vi.mocked(practicesApi.getPracticeAnalyticsReviews)
        .mockResolvedValueOnce(reviewsPage(1, 3))
        .mockReturnValueOnce(new Promise(() => {}))
      mount()
      await flush()

      pager('.practice-analytics__reviews')?.click()
      await nextTick()
      pager('.practice-analytics__reviews')?.click()
      await flush()

      expect(practicesApi.getPracticeAnalyticsReviews).toHaveBeenCalledTimes(2)
      expect(reviewCount()).toBe(1)
    })

    it('a FAILED load-more keeps the loaded page and the button, and says so', async () => {
      vi.mocked(practicesApi.getPracticeAnalytics).mockResolvedValue(summary({ reviews_total: 3 }))
      vi.mocked(practicesApi.getPracticeAnalyticsReviews)
        .mockResolvedValueOnce(reviewsPage(1, 3))
        .mockRejectedValueOnce(new TypeError('net'))
      mount()
      await flush()

      pager('.practice-analytics__reviews')?.click()
      await flush()

      expect(reviewCount()).toBe(1)
      expect(pager('.practice-analytics__reviews')).not.toBeNull()
      expect(toastError).toHaveBeenCalled()
    })
  })

  describe('a tap on a person (BE-78 (2))', () => {
    it('leader: a pair opens the student dossier', async () => {
      mount()
      await flush()
      host!.querySelector<HTMLElement>('.practice-analytics__pair')!.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'master-student-profile', params: { id: 'u0' } })
    })

    it("curator: a school student's review opens the school student profile", async () => {
      vi.mocked(practicesApi.getPracticeAnalytics).mockResolvedValue(
        summary({ viewer_role: 'curator', curator_group_id: 'g9' }),
      )
      mount()
      await flush()
      host!.querySelector<HTMLElement>('.practice-analytics__review')!.click()
      await flush()
      expect(push).toHaveBeenCalledWith({
        name: 'master-curator-group-student',
        params: { groupId: 'g9', userId: 'r0' },
      })
    })

    it('school master: a tap opens the direct-message modal for THAT person, no route', async () => {
      vi.mocked(practicesApi.getPracticeAnalytics).mockResolvedValue(
        summary({ viewer_role: 'school_master' }),
      )
      mount()
      await flush()
      host!.querySelector<HTMLElement>('.practice-analytics__pair')!.click()
      await flush()
      const dm = host!.querySelector<HTMLElement>('.dm-stub')
      expect(dm?.dataset.id).toBe('u0')
      expect(dm?.textContent).toBe('Ученик 0')
      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('navigation', () => {
    it('the back button goes back, and does not push a route', async () => {
      mount()
      await flush()
      const backBtn =
        host?.querySelector<HTMLButtonElement>('button[aria-label="Назад"]') ??
        document.body.querySelector<HTMLButtonElement>('button[aria-label="Назад"]')
      backBtn?.click()
      await flush()

      expect(back).toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    })
  })
})
