// =============================================================================
// VELO Frontend -- MasterSummaryView Screen Tests
// =============================================================================
//
// «Саммари недели» — the weekly digest a master reaches from the dashboard.
// It is the one screen that tells a master WHICH student is unhappy and WHICH
// review said so, and nothing downstream contradicts it: if the needs_attention
// filter drops a row or a rating icon is mapped to the wrong bucket, the master
// simply never learns. So every assertion below is on the VALUE that reached the
// DOM (the name, the quote, the accent colour, the pushed route), never on the
// fact that a fetch fired (SC-02).
//
// PATTERN: B (local-ref), TWICE OVER — and the doubling is the whole shape of
// this file. There is no store (grep: zero `@/stores/*` imports), so NO pinia is
// needed; the seam is `@/api/masters`, the module the screen itself imports
// (.vue:143). It owns TWO INDEPENDENT ladders over that one seam:
//   - «Ключевые отзывы»  <- getMasterReviews, refs feedbacksLoading/Error/
//                          keyFeedbacks (.vue:165-181)
//   - «Требуют внимания» <- getStudents, refs attnLoading/attnError/students
//                          (.vue:195-210), filtered by the needsAttention
//                          computed (.vue:216-218)
// Both are fired unawaited from one onMounted (.vue:211-214), so either can fail
// while the other renders. Tested as such — a shared error state here would be a
// dead endpoint reporting the healthy one as broken.
//
// THE SHARP EDGE ON THIS SCREEN: the two sections are INDISTINGUISHABLE from a
// host-wide query, and it is not obvious from a glance at the .vue.
//   - both loaders carry the SAME class, `.summary__attn-state` (.vue:39,82)
//   - both error states render the SAME title, «Не удалось загрузить»
//     (.vue:45,88), the SAME description, «Попробуйте ещё раз» (.vue:177,206),
//     and the SAME “Повторить” button label (.vue:48,91)
// So `expect(text()).toContain('Не удалось загрузить')` passes when EITHER
// section failed and cannot tell you which — an SC-14-shaped hazard on a screen
// with no v-show at all. Every query below is therefore scoped through
// section(), which partitions .summary__content by its <h2> headings. The
// template is flat (h2, block, h2, block as siblings, .vue:28-124), so DOM order
// IS the sectioning; there is no wrapper element to hang a scope on.
//
// SC-05 — the backend message is SWALLOWED on BOTH ladders: `catch {
// feedbacksError.value = 'Попробуйте ещё раз' }` (.vue:176-178) and the same on
// .vue:205-207. The error tests prove the screen's own constant reaches the DOM
// and explicitly assert that the rejection's detail does NOT. A master told
// «Попробуйте ещё раз» learns nothing about why; that is pinned as the known
// behaviour rather than left for a reader to assume otherwise.
//
// SC-06 — CHECKED, and it does not bite here, which is worth writing down
// because the sibling screens ARE guarded and the asymmetry is what produced a
// real bug elsewhere. Neither rung on either ladder carries `&& length === 0`
// (.vue:39,42,82,85) — and neither NEEDS one, because this screen has NO
// load-more and NO pagination. The only re-fetch is «Повторить», which only
// exists INSIDE the error state, so an error can never arrive while a populated
// list is on screen. The unguarded rungs are symmetric loading-vs-error twins,
// not a latent list-wipe. Both retry paths are driven below to prove it.
//
// SC-16 — there is NO CLIENT-SIDE PREVIEW CAP, and the constant is a trap that
// reads like one. `FEEDBACKS_PAGE = 3` (.vue:165) is the request's LIMIT, passed
// to getMasterReviews (.vue:174); the screen then v-for's over the whole
// response with no .slice() (.vue:51-53). So the cap is entirely the server's,
// and a five-item page renders five rows. Asserted explicitly below — a future
// slice(0,3) would be a silent behaviour change this file catches.
//
// SC-13 — the reap IS needed here: SendMessageModal (.vue:126) wraps VModal,
// which Teleports to body (VModal.vue:20-22). A closed overlay parks on
// document.body at `v-modal-leave-active` awaiting a transitionend happy-dom
// never fires, so afterEach purges `.v-modal__overlay` unconditionally. It is
// the ONLY overlay on this screen: VHeader's Teleport (VHeader.vue:23) is
// `:disabled="!floating"` targeting `.mobile-layout__island`, and under a bare
// createApp mount there is no MobileLayout ancestor, so useFloatingHeader()
// injects its `false` default and the header renders INLINE. Nothing else
// teleports.
//
// SC-14 — NOT APPLICABLE to the panes: grep finds zero `v-show` on this screen;
// every branch is v-if/v-else-if, so the DOM really does hold one rung per
// section at a time. There is no tab strip either. (The section-scoping above is
// a DIFFERENT hazard — duplicate strings across two v-if sections, not a hidden
// pane.)
//
// NO TIME IS PINNED, deliberately, and this is verified rather than assumed:
// grep finds zero `Date.now()` / `new Date()` on this screen, and `created_at`
// is carried on MasterReviewItem but NEVER RENDERED (.vue:65-69 shows name,
// practice_title and comment only). vi.setSystemTime here would be cargo.
//
// NO norm() / NBSP GUARD, also deliberate (velo-idiom §11): grep finds zero
// formatMoney, zero formatShortDate, zero Intl on this screen — it renders no
// money and no dates. There is no Intl output anywhere in its DOM, so there is
// no U+00A0 to normalise and a norm() here would be dead setup carrying a false
// justification. Add it the day this screen formats an amount.
//
// No order dependence: every test mounts its own app; beforeEach rebuilds the
// mocks and afterEach unmounts and purges.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterSummaryView from '@/views/master/MasterSummaryView.vue'
import * as mastersApi from '@/api/masters'
import { ApiResponseError } from '@/api/client'
import type { StudentListItem, MasterReviewItem } from '@/api/types'

// Both ladders' seam. Auto-mocked: nothing in this module needs preserving --
// ApiResponseError lives in @/api/client, which stays REAL so the
// swallowed-detail assertions run against the real class.
vi.mock('@/api/masters')

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function student(id: string, overrides: Partial<StudentListItem> = {}): StudentListItem {
  return {
    id,
    name: `Ученик ${id}`,
    avatar_url: null,
    practices_count: 3,
    needs_attention: false,
    ...overrides,
  }
}

function studentsPage(items: StudentListItem[]) {
  return { items, total: items.length, limit: 50, offset: 0 }
}

function review(n: number, overrides: Partial<MasterReviewItem> = {}): MasterReviewItem {
  return {
    user_id: `u${n}`,
    reviewer_name: `Рецензент ${n}`,
    avatar_url: null,
    rating: 'fire',
    comment: null,
    practice_title: `Практика ${n}`,
    // Carried by the endpoint, never rendered (.vue:65-69) -- present so the
    // fixture is a real MasterReviewItem, not a trimmed one.
    created_at: '2026-07-14T10:00:00Z',
    ...overrides,
  }
}

const RV_FIRE = review(1, {
  reviewer_name: 'Анна',
  rating: 'fire',
  comment: 'Лучшая практика за месяц',
  practice_title: 'Утренняя йога',
})
const RV_GOOD = review(2, { reviewer_name: 'Борис', rating: 'good', comment: null })
const RV_CONFUSED = review(3, {
  reviewer_name: 'Вера',
  rating: 'confused',
  comment: 'Было сложно успевать',
  practice_title: 'Вечерняя медитация',
})

function reviewsPage(items: MasterReviewItem[]) {
  return { items, total: items.length, limit: 3, offset: 0 }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterSummaryView)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). onMounted (.vue:211-214) fires
// BOTH loaders unawaited, so the two chains run in parallel rather than in
// series and the deepest one sets the count:
//   (1) the mount itself
//   (2) getStudents() resolves -> students.value assigned, the finally flips
//       attnLoading in the same continuation
//   (3) getMasterReviews() resolves -> keyFeedbacks assigned + finally
//   (4) the re-render both flag flips scheduled.
// Four on the deepest path. Six, because over-counting is free (velo-idiom §3)
// and the same flush() is reused after a retry click, which re-enters the chain
// from the top.
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

// -----------------------------------------------------------------------------
// Section scoping -- see the banner. The two sections share loader classes AND
// error strings, so nothing may be queried host-wide.
// -----------------------------------------------------------------------------

const FEEDBACKS = 'Ключевые отзывы'
const ATTENTION = 'Требуют внимания'

/**
 * The elements belonging to one <h2> section of .summary__content.
 *
 * The template is FLAT (.vue:28-124): the headings and their blocks are all
 * siblings, and `<template v-else>` renders its v-for straight into the same
 * parent as a fragment. So a section is "everything after MY heading, up to the
 * next heading" -- there is no wrapper element to select instead.
 */
function section(heading: string): HTMLElement[] {
  const content = host?.querySelector('.summary__content')
  if (!content) return []
  const kids = Array.from(content.children) as HTMLElement[]
  const start = kids.findIndex((k) => k.tagName === 'H2' && k.textContent?.trim() === heading)
  if (start === -1) return []
  const rest = kids.slice(start + 1)
  const end = rest.findIndex((k) => k.tagName === 'H2')
  return end === -1 ? rest : rest.slice(0, end)
}

function sectionText(heading: string): string {
  return section(heading)
    .map((el) => el.textContent ?? '')
    .join(' ')
}

function sectionQuery<T extends Element>(heading: string, selector: string): T[] {
  return section(heading).flatMap((el) => [
    ...(el.matches(selector) ? [el as unknown as T] : []),
    ...Array.from(el.querySelectorAll<T>(selector)),
  ])
}

/** Is THIS section showing its loader? Both use `.summary__attn-state` (.vue:39,82). */
function loading(heading: string): boolean {
  return sectionQuery(heading, '.summary__attn-state').length > 0
}

/** Is THIS section showing its error state? Both render the same title (.vue:45,88). */
function errored(heading: string): boolean {
  return sectionQuery<HTMLElement>(heading, '.v-empty__title').some(
    (el) => el.textContent?.trim() === 'Не удалось загрузить',
  )
}

function buttonIn(heading: string, label: string): HTMLButtonElement | undefined {
  return sectionQuery<HTMLButtonElement>(heading, 'button').find((b) =>
    b.textContent?.includes(label),
  )
}

// -- «Ключевые отзывы» --------------------------------------------------------

function feedbackCards(): HTMLElement[] {
  return sectionQuery<HTMLElement>(FEEDBACKS, '.summary__feedback')
}

function feedbackNames(): string[] {
  return feedbackCards().map(
    (c) => c.querySelector('.summary__feedback-name')?.textContent?.trim() ?? '',
  )
}

function feedbackPractices(): string[] {
  return feedbackCards().map(
    (c) => c.querySelector('.summary__feedback-practice')?.textContent?.trim() ?? '',
  )
}

function feedbackQuotes(): (string | null)[] {
  return feedbackCards().map(
    (c) => c.querySelector('.summary__feedback-quote')?.textContent?.trim() ?? null,
  )
}

/** The inline colour the screen stamped on each review's rating icon (.vue:60-64). */
function feedbackIconColors(): string[] {
  return feedbackCards().map((c) => c.querySelector('svg')?.getAttribute('style')?.trim() ?? '')
}

/**
 * Each rating icon's viewBox -- the only thing that tells the three IconRating*
 * components apart from the DOM. Asserted for DISTINCTNESS, not for literal
 * values: the claim is that RATING_ICON (.vue:159-163) maps each bucket to a
 * DIFFERENT component, and pinning viewBoxes would fail on an icon redesign that
 * broke nothing.
 */
function feedbackIconShapes(): string[] {
  return feedbackCards().map((c) => c.querySelector('svg')?.getAttribute('viewBox')?.trim() ?? '')
}

// -- «Требуют внимания» -------------------------------------------------------

function attnRows(): HTMLElement[] {
  return sectionQuery<HTMLElement>(ATTENTION, '.summary__attn')
}

function attnNames(): string[] {
  return attnRows().map((r) => r.querySelector('.summary__attn-name')?.textContent?.trim() ?? '')
}

function attnMetas(): string[] {
  return attnRows().map((r) => r.querySelector('.summary__attn-meta')?.textContent?.trim() ?? '')
}

// -- The message modal (teleported to body -- SC-07) ---------------------------

/**
 * The LIVE overlay, excluding any corpse a previous close parked on body
 * (SC-13c). Robust either way: if the leave ever does resolve, this still finds
 * the live one.
 */
function liveModal(): HTMLElement | null {
  return document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
}

function modalName(): string | null {
  return liveModal()?.querySelector('.send-msg__name')?.textContent?.trim() ?? null
}

/** SC-13b: the overlay is never REMOVED in happy-dom -- assert the leave STARTED. */
function modalDismissed(): boolean {
  return !!document.body.querySelector('.v-modal-leave-active')
}

function modalButton(label: string): HTMLButtonElement | undefined {
  return Array.from(liveModal()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(mastersApi.getStudents).mockReset().mockResolvedValue(studentsPage([]))
  vi.mocked(mastersApi.getMasterReviews).mockReset().mockResolvedValue(reviewsPage([]))
  push.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13: a CLOSED teleported overlay survives unmount -- the <Transition>
  // leave awaits a transitionend happy-dom never fires. Without this the first
  // modal test passes and every later one clicks a DEAD node.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('MasterSummaryView', () => {
  // ===========================================================================
  describe('«AI-инсайты за неделю» -- an HONEST STUB', () => {
    it('renders the placeholder sentence, and asks no endpoint for it', async () => {
      // .vue:152 -- a hardcoded ref, because no AI provider exists in this
      // project (backend/app/modules/ai/ is a Protocol + MockAIService). The
      // section is asserted precisely so nobody later mistakes the constant for
      // a rendered API value: the two calls this screen makes are the two
      // ladders below and NOTHING else.
      mount()
      await flush()

      expect(host!.querySelector('.summary__insight')?.textContent?.trim()).toBe(
        'Сводка появится, когда подключится аналитика',
      )
      expect(mastersApi.getStudents).toHaveBeenCalledTimes(1)
      expect(mastersApi.getMasterReviews).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================================================
  describe('«Ключевые отзывы» -- the ladder', () => {
    it('loading: the loader stands in THIS section, with no cards and no empty note', async () => {
      vi.mocked(mastersApi.getMasterReviews).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(loading(FEEDBACKS)).toBe(true)
      expect(feedbackCards()).toHaveLength(0)
      expect(sectionText(FEEDBACKS)).not.toContain('Отзывы появятся здесь')
      // The OTHER ladder resolved on its own: a section-scoped loader, not a
      // screen-wide one.
      expect(loading(ATTENTION)).toBe(false)
    })

    it('error: shows the failure state with a «Повторить» way out', async () => {
      vi.mocked(mastersApi.getMasterReviews).mockRejectedValue(
        new ApiResponseError(503, 'Хранилище отзывов недоступно', 'reviews_down'),
      )
      mount()
      await flush()

      expect(errored(FEEDBACKS)).toBe(true)
      expect(buttonIn(FEEDBACKS, 'Повторить')).toBeDefined()
      expect(feedbackCards()).toHaveLength(0)
      expect(loading(FEEDBACKS)).toBe(false)
    })

    it("error: the copy is the SCREEN's constant -- the backend detail is swallowed", async () => {
      // SC-05. `catch { feedbacksError.value = 'Попробуйте ещё раз' }`
      // (.vue:176-178) keeps no message. The negative assertion is the honest
      // half: this pins "the detail never surfaces" as known behaviour rather
      // than letting a reader assume it does.
      vi.mocked(mastersApi.getMasterReviews).mockRejectedValue(
        new ApiResponseError(503, 'Хранилище отзывов недоступно', 'reviews_down'),
      )
      mount()
      await flush()

      expect(sectionText(FEEDBACKS)).toContain('Попробуйте ещё раз')
      expect(sectionText(FEEDBACKS)).not.toContain('Хранилище отзывов недоступно')
    })

    it('empty: a master with no reviews yet gets the note, not an error', async () => {
      mount()
      await flush()

      expect(sectionQuery<HTMLElement>(FEEDBACKS, '.v-empty-note')[0]?.textContent?.trim()).toBe(
        'Отзывы появятся здесь, когда будут собраны',
      )
      expect(errored(FEEDBACKS)).toBe(false)
      expect(feedbackCards()).toHaveLength(0)
    })

    it('content: renders every reviewer with their practice, in the order the backend returned', async () => {
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(
        reviewsPage([RV_FIRE, RV_GOOD, RV_CONFUSED]),
      )
      mount()
      await flush()

      expect(feedbackNames()).toEqual(['Анна', 'Борис', 'Вера'])
      expect(feedbackPractices()).toEqual(['Утренняя йога', 'Практика 2', 'Вечерняя медитация'])
      // The empty note must NOT ride along under a populated list (.vue:71-75).
      expect(sectionQuery(FEEDBACKS, '.v-empty-note')).toHaveLength(0)
    })

    it('content: quotes the comment, and renders no quote line without one', async () => {
      // `v-if="item.comment"` (.vue:68). An empty «» on a review with no comment
      // reads as a reviewer who said nothing out loud -- a different fact from a
      // reviewer who left no comment at all.
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(
        reviewsPage([RV_FIRE, RV_GOOD, RV_CONFUSED]),
      )
      mount()
      await flush()

      expect(feedbackQuotes()).toEqual([
        '«Лучшая практика за месяц»',
        null,
        '«Было сложно успевать»',
      ])
    })

    it("content: each review carries ITS rating's icon and accent colour", async () => {
      // RATING_ICON (.vue:159-163) picks the component; RATING_ICON_COLOR
      // (displayHelpers.ts:110-114) the accent. Both are Record<FeedbackRating,…>
      // literals -- a transposed key paints a confused review as fire, which is
      // exactly the review a master must not miss.
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(
        reviewsPage([RV_FIRE, RV_GOOD, RV_CONFUSED]),
      )
      mount()
      await flush()

      expect(feedbackIconColors()).toEqual([
        'color: var(--velo-rating-fire);',
        'color: var(--velo-rating-good);',
        'color: var(--velo-rating-confused);',
      ])
      // Three ratings must resolve to three DIFFERENT components -- a constant
      // icon would satisfy the colour assertion above on its own.
      expect(new Set(feedbackIconShapes()).size).toBe(3)
    })

    it('«Повторить» re-runs the fetch and recovers into real content', async () => {
      vi.mocked(mastersApi.getMasterReviews).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(errored(FEEDBACKS)).toBe(true)

      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(reviewsPage([RV_FIRE]))
      buttonIn(FEEDBACKS, 'Повторить')?.click()
      await flush()

      expect(errored(FEEDBACKS)).toBe(false)
      expect(feedbackNames()).toEqual(['Анна'])
    })
  })

  // ===========================================================================
  describe('«Требуют внимания» -- the ladder', () => {
    it('loading: the loader stands in THIS section only', async () => {
      vi.mocked(mastersApi.getStudents).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(loading(ATTENTION)).toBe(true)
      expect(attnRows()).toHaveLength(0)
      expect(sectionText(ATTENTION)).not.toContain('Все ученики в порядке')
      expect(loading(FEEDBACKS)).toBe(false)
    })

    it('error: shows the failure state with a «Повторить» way out', async () => {
      vi.mocked(mastersApi.getStudents).mockRejectedValue(
        new ApiResponseError(500, 'CRM недоступен', 'students_down'),
      )
      mount()
      await flush()

      expect(errored(ATTENTION)).toBe(true)
      expect(buttonIn(ATTENTION, 'Повторить')).toBeDefined()
      expect(attnRows()).toHaveLength(0)
    })

    it("error: the copy is the SCREEN's constant -- the backend detail is swallowed", async () => {
      // SC-05, the twin of the reviews case (.vue:205-207).
      vi.mocked(mastersApi.getStudents).mockRejectedValue(
        new ApiResponseError(500, 'CRM недоступен', 'students_down'),
      )
      mount()
      await flush()

      expect(sectionText(ATTENTION)).toContain('Попробуйте ещё раз')
      expect(sectionText(ATTENTION)).not.toContain('CRM недоступен')
    })

    it('empty: a master with no students at all', async () => {
      mount()
      await flush()

      expect(sectionText(ATTENTION)).toContain('Все ученики в порядке')
      expect(sectionText(ATTENTION)).toContain('Здесь появятся те, кому нужно внимание')
      expect(errored(ATTENTION)).toBe(false)
    })

    it('empty: students exist but NONE needs attention -- the same «всё в порядке»', async () => {
      // The distinction this screen deliberately does not draw: needsAttention
      // (.vue:216-218) filters, and an all-clear roster and an empty roster land
      // on the identical empty state. Correct here -- «Все ученики в порядке» is
      // true in both -- and pinned so the filter is proven to RUN rather than
      // merely proven to render nothing.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([student('s1'), student('s2')]),
      )
      mount()
      await flush()

      expect(attnRows()).toHaveLength(0)
      expect(sectionText(ATTENTION)).toContain('Все ученики в порядке')
    })

    it('content: only the flagged students, and the positive set is pinned first', async () => {
      // SC-15: `expect(attnNames()).not.toContain('Борис')` alone would also pass
      // on a mount that rendered NOTHING -- a broken fixture or a failed flush
      // would look like a working filter. toEqual proves the list rendered AND
      // excluded.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Анна', needs_attention: true }),
          student('s2', { name: 'Борис', needs_attention: false }),
          student('s3', { name: 'Вера', needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      expect(attnNames()).toEqual(['Анна', 'Вера'])
      expect(attnRows()).toHaveLength(2)
    })

    it('content: the filter preserves the order the backend returned', async () => {
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Первый', needs_attention: true }),
          student('s2', { name: 'Второй', needs_attention: false }),
          student('s3', { name: 'Третий', needs_attention: true }),
          student('s4', { name: 'Четвёртый', needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      expect(attnNames()).toEqual(['Первый', 'Третий', 'Четвёртый'])
    })

    it("content: each row states that student's OWN practice count", async () => {
      // Positional data: two rows reading the same number would hide a v-for
      // bound to the wrong item, so the counts differ on purpose.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Анна', practices_count: 7, needs_attention: true }),
          student('s2', { name: 'Вера', practices_count: 1, needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      expect(attnMetas()).toEqual(['Практик: 7', 'Практик: 1'])
    })

    it('content: every rendered row carries the warning badge -- one per row, no more', async () => {
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Анна', needs_attention: true }),
          student('s2', { name: 'Борис', needs_attention: false }),
          student('s3', { name: 'Вера', needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      // The badge is unconditional inside the row (.vue:107) -- the FILTER is
      // what earns it. A badge count above the row count would mean the section
      // is rendering someone it filtered out.
      expect(sectionQuery(ATTENTION, '.summary__attn-badge')).toHaveLength(2)
      expect(attnRows()).toHaveLength(2)
    })

    it('«Повторить» re-runs the fetch and recovers into real content', async () => {
      vi.mocked(mastersApi.getStudents).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(errored(ATTENTION)).toBe(true)

      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([student('s1', { name: 'Анна', needs_attention: true })]),
      )
      buttonIn(ATTENTION, 'Повторить')?.click()
      await flush()

      expect(errored(ATTENTION)).toBe(false)
      expect(attnNames()).toEqual(['Анна'])
    })
  })

  // ===========================================================================
  describe('the two ladders are INDEPENDENT', () => {
    it('a dead reviews endpoint leaves «Требуют внимания» standing', async () => {
      // Two unawaited fetches from one onMounted (.vue:211-214). Shared error
      // state here would report a healthy CRM as broken.
      vi.mocked(mastersApi.getMasterReviews).mockRejectedValue(new TypeError('boom'))
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([student('s1', { name: 'Анна', needs_attention: true })]),
      )
      mount()
      await flush()

      expect(errored(FEEDBACKS)).toBe(true)
      expect(errored(ATTENTION)).toBe(false)
      expect(attnNames()).toEqual(['Анна'])
    })

    it('a dead students endpoint leaves «Ключевые отзывы» standing', async () => {
      vi.mocked(mastersApi.getStudents).mockRejectedValue(new TypeError('boom'))
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(reviewsPage([RV_FIRE]))
      mount()
      await flush()

      expect(errored(ATTENTION)).toBe(true)
      expect(errored(FEEDBACKS)).toBe(false)
      expect(feedbackNames()).toEqual(['Анна'])
    })

    it('a still-loading students fetch does not hold the reviews back', async () => {
      vi.mocked(mastersApi.getStudents).mockReturnValue(new Promise(() => {}))
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(reviewsPage([RV_FIRE]))
      mount()
      await flush()

      expect(loading(ATTENTION)).toBe(true)
      expect(feedbackNames()).toEqual(['Анна'])
    })

    it('both dead: each section errors on its own, and the AI stub survives both', async () => {
      vi.mocked(mastersApi.getStudents).mockRejectedValue(new TypeError('boom'))
      vi.mocked(mastersApi.getMasterReviews).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(errored(FEEDBACKS)).toBe(true)
      expect(errored(ATTENTION)).toBe(true)
      expect(host!.querySelector('.summary__insight')?.textContent?.trim()).toBe(
        'Сводка появится, когда подключится аналитика',
      )
    })
  })

  // ===========================================================================
  describe('the requests this screen makes', () => {
    it('asks for a 3-item HIGHLIGHT REEL: limit 3, offset 0, attention OFF', async () => {
      // .vue:174 -- getMasterReviews(FEEDBACKS_PAGE, 0, false). `attention` is
      // the load-bearing argument: `true` narrows the feed to the negative
      // bucket server-side (api/masters.ts:249), which is what AnalyticsView's
      // «Требуют внимания» wants. THIS section wants the highlight reel --
      // positive included -- so `false` is a deliberate difference from a
      // near-identical call one screen over, not a default.
      mount()
      await flush()

      expect(mastersApi.getMasterReviews).toHaveBeenCalledWith(3, 0, false)
    })

    it('asks for the students page with the wrapper defaults', async () => {
      // .vue:203 -- getStudents(), bare. The wrapper's own defaults (limit 50,
      // offset 0, api/masters.ts:175) are the page; this screen never paginates.
      mount()
      await flush()

      expect(mastersApi.getStudents).toHaveBeenCalledWith()
    })

    it('renders EVERY review the server returned -- the 3 is the request limit, not a client cap', async () => {
      // SC-16 inverted, and the trap is that FEEDBACKS_PAGE = 3 (.vue:165) READS
      // like a preview cap. It is not: the v-for is over the raw response with
      // no .slice() (.vue:51-53). A server that returned five would show five.
      // The row COUNT is asserted first, so a future slice(0, 3) fails here
      // loudly instead of silently truncating a master's digest.
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(
        reviewsPage([
          review(1, { reviewer_name: 'Один' }),
          review(2, { reviewer_name: 'Два' }),
          review(3, { reviewer_name: 'Три' }),
          review(4, { reviewer_name: 'Четыре' }),
          review(5, { reviewer_name: 'Пять' }),
        ]),
      )
      mount()
      await flush()

      expect(feedbackCards()).toHaveLength(5)
      expect(feedbackNames()).toEqual(['Один', 'Два', 'Три', 'Четыре', 'Пять'])
    })

    it('renders EVERY flagged student -- «Требуют внимания» has no cap either', async () => {
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage(
          Array.from({ length: 12 }, (_, i) =>
            student(`s${i}`, { name: `Ученик${i}`, needs_attention: true }),
          ),
        ),
      )
      mount()
      await flush()

      // Contrast MasterStudentsView, which caps its list at 10 behind a
      // show-more pill. This section deliberately does not -- everyone who needs
      // attention is shown.
      expect(attnRows()).toHaveLength(12)
      expect(attnNames()[11]).toBe('Ученик11')
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it("tapping a review opens THAT reviewer's student profile", async () => {
      // goStudentFromReview (.vue:185-191). The id must be the review's
      // user_id -- E1's remainder is what makes these cards navigable at all --
      // and the name rides in the query because the detail endpoint carries none.
      vi.mocked(mastersApi.getMasterReviews).mockResolvedValue(
        reviewsPage([RV_FIRE, RV_GOOD, RV_CONFUSED]),
      )
      mount()
      await flush()

      feedbackCards()[2]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-student-profile',
        params: { id: 'u3' },
        query: { name: 'Вера' },
      })
    })

    it("tapping an attention row opens THAT student's profile, carrying the name forward", async () => {
      // openProfile (.vue:221-227) uses student.id -- a DIFFERENT field from the
      // reviews path's user_id, and both are ids of the same shape in scope on
      // one screen.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Анна', needs_attention: false }),
          student('s2', { name: 'Вера', needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      attnRows()[0]?.click()
      await flush()

      // The FILTERED row, not students[0] -- indexing the unfiltered array would
      // open the wrong student and every count assertion above would still pass.
      expect(push).toHaveBeenCalledWith({
        name: 'master-student-profile',
        params: { id: 's2' },
        query: { name: 'Вера' },
      })
    })

    it('the message button does NOT navigate (@click.stop)', async () => {
      // .vue:112 -- the button sits INSIDE a role="button" row that pushes. Lose
      // the .stop and every attempt to message a student silently navigates away
      // from the digest instead.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([student('s1', { name: 'Анна', needs_attention: true })]),
      )
      mount()
      await flush()

      attnRows()[0]?.querySelector<HTMLElement>('.summary__msg')?.click()
      await flush()

      expect(push).not.toHaveBeenCalled()
    })

    it('the header back PUSHES the dashboard rather than unwinding history', async () => {
      // .vue:26 -- `@back="router.push({ name: 'master-dashboard' })"`, NOT
      // router.back(). Deliberate on a screen reached from exactly one place;
      // asserted because it is the opposite of what most VHeader users do and a
      // "fix" to router.back() would look like a cleanup.
      mount()
      await flush()

      host!.querySelector<HTMLButtonElement>('button[aria-label="Назад"]')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-dashboard' })
    })
  })

  // ===========================================================================
  describe('the «Написать сообщение» modal', () => {
    it('stays shut until a message button is tapped', async () => {
      // A real negative, not SC-13b: nothing has opened, so no corpse exists and
      // the overlay is genuinely absent from body.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([student('s1', { name: 'Анна', needs_attention: true })]),
      )
      mount()
      await flush()

      expect(document.body.querySelector('.v-modal__overlay')).toBeNull()
    })

    it("opens carrying THAT student's name -- teleported to body, not into the screen", async () => {
      // SC-07: VModal Teleports to body (VModal.vue:20), so host.querySelector
      // finds nothing and a test that looked there would conclude "not
      // rendered". openMessage (.vue:231-234) sets msgName from the row.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Анна', needs_attention: true }),
          student('s2', { name: 'Вера', needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      attnRows()[1]?.querySelector<HTMLElement>('.summary__msg')?.click()
      await flush()

      expect(liveModal()).not.toBeNull()
      expect(host!.querySelector('.v-modal__overlay')).toBeNull()
      // The SECOND row's student -- a modal wired to a constant, or to
      // students[0], passes a one-row fixture and misdirects every real message.
      expect(modalName()).toBe('Вера')
    })

    it('re-targets when a different student is tapped', async () => {
      // msgName is a single shared ref (.vue:230). A stale name here means the
      // master writes to the wrong person.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([
          student('s1', { name: 'Анна', needs_attention: true }),
          student('s2', { name: 'Вера', needs_attention: true }),
        ]),
      )
      mount()
      await flush()

      attnRows()[0]?.querySelector<HTMLElement>('.summary__msg')?.click()
      await flush()
      expect(modalName()).toBe('Анна')

      attnRows()[1]?.querySelector<HTMLElement>('.summary__msg')?.click()
      await flush()
      expect(modalName()).toBe('Вера')
    })

    it('«Отмена» closes it, without navigating anywhere', async () => {
      // SC-13b: `expect(overlay).toBeNull()` would NEVER pass -- the overlay is
      // parked at v-modal-leave-active awaiting a transitionend happy-dom does
      // not fire. Assert the leave STARTED, and pin the negative first so the
      // test cannot always-pass.
      vi.mocked(mastersApi.getStudents).mockResolvedValue(
        studentsPage([student('s1', { name: 'Анна', needs_attention: true })]),
      )
      mount()
      await flush()

      attnRows()[0]?.querySelector<HTMLElement>('.summary__msg')?.click()
      await flush()
      expect(modalDismissed()).toBe(false)

      modalButton('Отмена')?.click()
      await flush()

      expect(modalDismissed()).toBe(true)
      expect(push).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // NOT COVERED, deliberately
  //
  // - «Отправить» inside SendMessageModal. It is that COMPONENT's own behaviour
  //   (open-or-get the DM, post, toast -- SendMessageModal.test.ts) and is
  //   shared with MasterStudentsView / MasterStudentProfileView. This screen
  //   only opens the sheet and names the recipient; asserting the send here
  //   would test the child from three different files.
  //   What THIS screen owns -- which name reaches the sheet -- is asserted above.
  // - Keyboard activation (`@keydown.enter.space.prevent`, .vue:58,101). Both
  //   handlers are the same goStudentFromReview / openProfile already driven
  //   through the click path; a second test would assert Vue's event modifier,
  //   not this screen.
  // - A rating outside the three buckets. `MasterReviewItem.rating` is typed
  //   `string` in generated.ts:688 and the screen casts it (`item.rating as
  //   FeedbackRating`, .vue:61-63), so an unknown value would resolve RATING_ICON
  //   to undefined and render a card with no glyph. Not tested because it is NOT
  //   REACHABLE: the backend projects the rating through rating_bucket()
  //   (masters/reviews_service.py:99), a closed 1-3/4-7/8-10 -> confused/good/fire
  //   mapping. A test would have to fabricate a response the server cannot send,
  //   and would then pin the cast's failure mode as if it were a contract.
  //   Recorded as the latent trap it is: the day a fourth bucket is added
  //   backend-side, this screen degrades silently and needs a fallback + a test.
  // - VEmptyState / VLoader / VCard / VAvatar / VHeader internals: DS primitives
  //   with their own homes. Exercised here only through the values this screen
  //   feeds them.
  // - masterStatusGuard on this route: guard-layer behaviour, covered bare in
  //   router/guards.test.ts. Route meta carries no role data to assert from here
  //   (velo-idiom §6).
  // - `attention: attention || undefined` collapsing false out of the query
  //   string (api/masters.ts:249). That is the API wrapper's job and this file
  //   mocks that seam; the screen's half -- passing `false` at all -- is asserted
  //   above.
  // ===========================================================================
})
