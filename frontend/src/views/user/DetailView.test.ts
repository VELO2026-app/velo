// =============================================================================
// VELO Frontend -- DetailView Screen Tests
// =============================================================================
//
// WHY: this screen is the read-only detail behind BOTH diary row kinds -- tap a
// check-in card in the feed and you land here; tap a feedback card and you land
// here too, on the same component, told apart only by the `:type` route segment
// (DiaryFeedView.vue:309-315). So the branch IS the product: every computed on
// this screen forks on `detailType`, and a test that exercises one kind proves
// nothing about the other. Both kinds are driven through every derivation below.
//
// ⚠ THE FINDING THIS FILE PINNED -- «the pill is a constant» -- IS NOW FIXED.
// `pillTitle` (.vue:149-158) and `leadIcon` (.vue:142-147) USED TO index the ZONE
// maps (MOOD_LABEL/MOOD_ICON keyed 'low'|'mid'|'high', RATING_* keyed
// 'fire'|'good'|'confused') with the RAW SCORE off the wire. But
// CheckinResponse.mood and FeedbackResponse.rating are `number` -- a 1..10 score
// (generated.ts:377, :554; displayHelpers.ts:64-66 "mood and rating are stored
// as a 1..10 score now"). `MOOD_LABEL[8]` is undefined, so `?? ''` fired, so the
// pill read a bare «Check-in» / «Feedback» for EVERY score, and the face was
// always IconMoodMid / IconRatingGood. The screen rendered the user's mood as a
// shrug no matter what they logged.
//
// It was the sibling-guard shape (five confirmed instances in this repo): this
// screen's OWN PARENT gets it right. useDiaryCardModel.ts:120,124 does
// `moodLabelFromScore(mood)` and :178,180 does `MOOD_ICON[moodZoneFromScore(...)]`
// -- so the feed card you tapped said «Check-in: Огонь!» over a beaming face, and
// the detail you landed on said «Check-in» over a shrug. The conversion helpers
// DetailView needed were already imported one file away. THE FIX is the parent's
// own line, `?? 6` default included (.vue:144,146,152,156).
//
// The TYPECHECKER CANNOT SEE THIS and that is why it shipped: `Record<string,
// string>` accepts a numeric index (TS coerces), and `noUncheckedIndexedAccess`
// (tsconfig:20) types the lookup `string | undefined`, so the author's `?? ''`
// looked like correct defensive code instead of the thing swallowing the bug.
// vue-tsc was clean on the bug and is clean on the fix -- equally silent either
// way. ONLY the rendered assertions below tell the two apart, which is why they
// are the whole guard here and not a formality.
//
// THE FOUR TESTS BELOW WERE WRITTEN INVERTED, pinning the wrong behaviour so the
// bug could not be fixed silently. They went red on the fix, and that red WAS the
// changelog. They now assert the CORRECT behaviour, and each still names the old
// output in a `not.toBe` / `not.toEqual`, so a regression is reported as itself
// rather than as an anonymous mismatch. Mutation-checked: revert the conversion
// in .vue and these four -- and only these four -- go red again.
//
// PATTERN B (local-ref), with a store DEPENDENCY. Verified, not assumed:
// `loading`/`loadError` are the screen's own refs (.vue:125-126), `checkin` and
// `feedback` are refs (.vue:121-122) fed by direct getCheckin/getFeedback in
// onMounted(reload) (.vue:196,200,219), and the practice header is a direct
// getPractice (.vue:206). There is NO store holding this screen's state -- the
// header comment's "No store: this is a one-shot read" (.vue:18-19) checks out.
// So the seams are the two @/api/* wrappers, and useAuthStore is a DEPENDENCY
// read for exactly one thing -- `user?.timezone` (.vue:113) -- mocked wholesale
// behind a getter (velo-idiom §5), no state built in it.
//
// NO PINIA IS INSTALLED, and that is a CHECKED claim, not an omission. The
// Pattern A corollary (SKILL Step 3) says an unstubbed CHILD resolving a store
// of its own hard-throws `getActivePinia()` at mount even when every store the
// SCREEN reads is mocked. So the children were grepped rather than assumed:
// PracticeListCard, VLoader, VEmptyState, VButton, VBackButton, VCard and the
// six Icon* faces import no store and no pinia (grepped for `Store`/`pinia`
// across components/icons/ -- zero hits). Nothing under this mount resolves a
// store, so a real Pinia would be dead setup. Contrast EntryView, which needs
// one because its state genuinely lives in useDiaryStore.
//
// TICKS = 6. Counted (SC-08), not copied -- and this chain is SHALLOWER than
// EntryView's 8 because there is no store and no feed refresh between the screen
// and the wire. The mount chain is the only chain (nothing here mutates):
//   onMounted -> reload -> await getCheckin/getFeedback (1) -> row lands,
//   practiceId read -> await getPractice (2) -> practice lands -> finally,
//   loading=false (3) -> re-render (4).
// 4 counted, 6 used: two ticks of margin, since over-counting is harmless and
// under-counting fails loudly. The failure paths are shorter still (the catch
// short-circuits the getPractice leg).
//
// TRAPS PRESENT:
//  - WALL CLOCK / TIMEZONE, the big one here. dateLine and practiceTime are Intl
//    output keyed on `authStore.user?.timezone ?? 'UTC'` (.vue:113). Pinned
//    THREE WAYS APART on purpose, so no assertion can pass by coincidence:
//      user tz   = Europe/Moscow (UTC+3)  <- the only right answer
//      RUNNER tz = Asia/Tbilisi  (UTC+4)  <- probed, not assumed
//      fallback  = UTC           (UTC+0)  <- where an ignored tz actually lands
//      practice.timezone = Asia/Tokyo (UTC+9) <- NEVER the answer; a reader reads
//                                                in their own zone, not the
//                                                practice's (contrast
//                                                EditPracticeView)
//    22:30Z is 01:30 the NEXT DAY in Moscow, 02:30 in Tbilisi, 22:30 the SAME day
//    in UTC. A screen that ignored tz fails on the TIME against the runner and on
//    the DAY against UTC. It cannot pass by accident.
//  - SC-15: the failed-practice-fetch test pins the POSITIVE set (the row's own
//    comment rendered) BEFORE asserting the header is absent, so a mount that
//    rendered nothing cannot satisfy it.
//  - SC-18: every fixture default DIFFERS from every value any test overrides --
//    mood defaults to 6 and no test passes 6 (they pass 1/2/5/9/10); comment
//    defaults to «Спокойное утро» and no test overrides it to that. A dropped
//    `...overrides` fails loudly here instead of quietly agreeing.
//  - SC-05, the GOOD half: `:description="loadError"` (.vue:45) binds the real
//    message, so the backend's own words reach the DOM. Asserted as propagation,
//    with the screen's own constant title asserted alongside so neither is
//    mistaken for proof of the other.
//  - The two DIVERGENT master fallbacks, asserted together in one test because
//    they are one screen's answer to one missing field: contextLine says
//    «Мастером» (.vue:180) and PracticeListCard's own masterName says «Мастер»
//    (PracticeListCard.vue:133). Both correct, both live, neither a typo.
//
// TRAPS ABSENT (proved by grep, so the next reader does not cargo-cult setup):
//  - NO TELEPORT ANYWHERE in this screen's chain -> no SC-13/13b/13c and NO
//    afterEach purge. Grepped every child (PracticeListCard, VLoader,
//    VEmptyState, VButton, VBackButton, VCard): zero `Teleport`. This screen is
//    read-only -- no modal, no sheet, no confirm, nothing to open.
//  - NO v-show (grepped: zero hits). The ladder is v-if / v-else-if / v-else-if
//    (.vue:36,42,52), so the rungs are genuinely mutually exclusive and SC-14
//    does not bite. Nor the SC-14b sibling-section variant: one section, one
//    loader, one error string, no tab strip.
//  - NO SC-19. This screen passes no slot to any shared shell -- it is a flat
//    template that owns its own `v-if="practice"` (.vue:55). The one nesting that
//    COULD hide a fallback was checked anyway: PracticeListCard's master row is a
//    `<slot name="subtitle">` whose fallback (PracticeListCard.vue:47-56) this
//    screen does not override, and it sits inside no v-if of the card's own -- so
//    «Мастер» really is reachable, and the test below reaches it.
//  - NO MONEY, no formatMoney in this screen or any child -> the ru U+00A0 trap
//    (velo-idiom §11) cannot bite, so there is deliberately NO norm() helper. The
//    Intl strings asserted here were CODEPOINT-SCANNED on this ICU build rather
//    than eyeballed: «17 июля • Пятница • 01:30», «16 июля • Четверг • 10:00»,
//    «13:00» and «1 ч 30 м» contain zero U+00A0/U+202F/U+2009. (formatDuration is
//    a plain template literal, not Intl -- it never could.)
//  - NO vi.setSystemTime. formatFeedDateTime / formatTime / formatDuration
//    (utils/format.ts:264,207,297) are pure Intl over the given instant + zone --
//    none reads `new Date()` for "now". This screen has no «Сегодня»/«Завтра»
//    badge and no relative label, so freezing the clock would be dead setup.
//  - NO IntersectionObserver / ResizeObserver, NO navigator.clipboard, NO
//    window.location assignment, NO window.history.state read, NO waitUntilReady
//    in the chain, NO scrollHeight read, NO localStorage, NO useToast (this
//    screen surfaces failure through the rung, never a toast).
//
// THE `:type` COMMENT (.vue:8-9) IS TRUE -- CHECKED, NOT TRUSTED. It claims the
// segment is constrained to checkin|feedback by the route regex so an invalid
// type never reaches the component. router/index.ts:87 reads
// `path: 'diary/:type(checkin|feedback)/:id'` -- the regex is really there and
// really is that. So `/diary/banana/1` cannot match this route and never
// constructs this component. The screen's `route.params.type === 'feedback' ?
// 'feedback' : 'checkin'` (.vue:114-116) collapses everything-not-feedback to
// checkin, which would be a real hazard on an unconstrained param -- but the
// param is constrained, so the only inputs that exist are the two tested below.
// NOT TESTED, because it is not reachable: see «NOT COVERED, deliberately».
//
// NO ORDER DEPENDENCE. Declaration order is execution order; nothing relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DetailView from '@/views/user/DetailView.vue'
import * as diaryApi from '@/api/diary'
import * as practicesApi from '@/api/practices'
// Stays REAL: vi.mock('@/api/diary') does not touch @/api/client, so the failure
// tests drive the real error class through extractApiError rather than a
// re-implemented one (velo-idiom §4).
import { ApiResponseError } from '@/api/client'
import type { CheckinResponse, FeedbackResponse, PracticeResponse } from '@/api/types'

vi.mock('@/api/diary')
vi.mock('@/api/practices')

const push = vi.fn()
const back = vi.fn()
const routeParams: { type: string; id: string } = { type: 'checkin', id: 'c1' }

vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

// Mocked wholesale behind a getter (velo-idiom §5): the REAL auth store imports
// @/platform eagerly, and this screen reads nothing off it but user?.timezone.
const authState: { user: { timezone: string } | null } = { user: { timezone: 'UTC' } }
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

// -- Fixtures ----------------------------------------------------------------
//
// SC-18: every default below DIFFERS from every value any test overrides, so a
// dropped `...overrides` goes red instead of silently agreeing with the test.
// mood/rating default to 6 -- the ZONE tests pass 1/2/5/9/10 and never 6.

function checkin(overrides: Partial<CheckinResponse> = {}): CheckinResponse {
  return {
    id: 'c1',
    practice_id: 'p1',
    user_id: 'u1',
    booking_id: 'b1',
    mood: 6,
    comment: 'Спокойное утро',
    check_type: 'pre',
    created_at: '2026-07-16T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

function feedback(overrides: Partial<FeedbackResponse> = {}): FeedbackResponse {
  return {
    id: 'f1',
    practice_id: 'p1',
    user_id: 'u1',
    booking_id: 'b1',
    rating: 6,
    comment: 'Было полезно',
    created_at: '2026-07-16T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

// `timezone: 'Asia/Tokyo'` on purpose and it is NEVER the answer: this screen
// renders the practice in the VIEWER's zone, not the practice's. See the
// timezone tests.
function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'm1',
    master_name: 'Анна',
    practice_type: 'live',
    status: 'completed',
    title: 'Утренняя йога',
    description: 'Описание',
    what_to_prepare: null,
    contraindications: null,
    scheduled_at: '2026-07-22T10:00:00Z',
    duration_minutes: 90,
    timezone: 'Asia/Tokyo',
    max_participants: 10,
    current_participants: 3,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    direction: 'yoga',
    style: 'hatha',
    difficulty: 'beginner',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  } as PracticeResponse
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DetailView)
  // NO app.use(pinia), deliberately -- nothing under this mount resolves a
  // store. See the banner; this was grepped, not assumed.
  app.mount(host)
  return host
}

// 6 ticks -- counted in the banner (chain depth 4), not copied.
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function bodyEl(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.detail__body')
  if (!el) throw new Error('.detail__body did not render')
  return el
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

/**
 * Which face the pill actually rendered. The six Icon* assets carry no class and
 * no data attribute -- they are bare <svg> -- so they are told apart the way
 * MasterStudentProfileView.test.ts:470-479 does it: by viewBox, plus mid's
 * <circle> eyes vs high's all-<path> face (the two moods share "0 0 40 40").
 * Scoped to .detail__pill-icon because PracticeListCard renders svgs of its own.
 */
function leadFace(): string {
  const svg = host?.querySelector('.detail__pill-icon svg')
  if (!svg) throw new Error('the pill lead icon did not render')
  const vb = svg.getAttribute('viewBox') ?? ''
  if (vb.startsWith('4.85156')) return 'mood-low'
  if (vb === '0 0 40 40') return svg.querySelector('circle') ? 'mood-mid' : 'mood-high'
  if (vb.startsWith('-26.76')) return 'rating-fire'
  if (vb.startsWith('-26.84')) return 'rating-good'
  if (vb.startsWith('13.18')) return 'rating-confused'
  return `unrecognised viewBox: ${vb}`
}

function pillTitle(): string | undefined {
  return host?.querySelector('.detail__pill-title')?.textContent ?? undefined
}

beforeEach(() => {
  routeParams.type = 'checkin'
  routeParams.id = 'c1'
  authState.user = { timezone: 'UTC' }

  vi.mocked(diaryApi.getCheckin).mockReset().mockResolvedValue(checkin())
  vi.mocked(diaryApi.getFeedback).mockReset().mockResolvedValue(feedback())
  vi.mocked(practicesApi.getPractice).mockReset().mockResolvedValue(practice())

  push.mockReset()
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  // NO overlay purge here, deliberately: this screen teleports nothing. See
  // "TRAPS ABSENT" in the banner -- it is read-only, it opens nothing.
  vi.clearAllMocks()
})

describe('DetailView', () => {
  describe('the state ladder', () => {
    it('shows the loader while the row is in flight', async () => {
      vi.mocked(diaryApi.getCheckin).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__state')).not.toBeNull()
      expect(bodyEl().querySelector('.detail__card')).toBeNull()
      expect(text()).not.toContain('Не удалось загрузить запись')
    })

    it('a failed fetch shows the rung AND surfaces the REAL backend message', async () => {
      // SC-05, and this screen is the GOOD half of it: «Не удалось загрузить
      // запись» is the screen's own constant (.vue:44) but the description is
      // bound to `:description="loadError"` (.vue:45), so the backend's words
      // really do reach the DOM. Both halves asserted so neither is read as
      // proof of the other.
      vi.mocked(diaryApi.getCheckin).mockRejectedValue(
        new ApiResponseError(404, 'Check-in удалён или не ваш', 'not_found'),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить запись',
      )
      expect(bodyEl().querySelector('.v-empty__desc')?.textContent).toBe(
        'Check-in удалён или не ваш',
      )
      expect(bodyEl().querySelector('.detail__card')).toBeNull()
      expect(bodyEl().querySelector('.detail__pill')).toBeNull()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(diaryApi.getCheckin).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(bodyEl().querySelector('.v-empty__desc')?.textContent).toBe('Запись не найдена')
    })

    it('«Повторить» re-fetches and replaces the rung with the row', async () => {
      // reload() is bound straight to the retry button (.vue:48) and re-runs the
      // whole load, including nulling the previous refs (.vue:190-192).
      vi.mocked(diaryApi.getCheckin).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить запись')

      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ comment: 'Загрузилось' }))
      button('Повторить')?.click()
      await flush()

      expect(text()).not.toContain('Не удалось загрузить запись')
      expect(bodyEl().querySelector('.detail__content')?.textContent).toBe('Загрузилось')
    })
  })

  describe('the two row kinds -- the :type branch IS the product', () => {
    it('type=checkin reads the CHECK-IN endpoint by the route id, and never the feedback one', async () => {
      // detailType (.vue:114-116) forks reload (.vue:195-203). Hitting the wrong
      // endpoint would 404 on an id that exists -- the two id spaces are separate.
      routeParams.type = 'checkin'
      routeParams.id = 'c42'
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(
        checkin({ id: 'c42', comment: 'Из чек-ина' }),
      )
      mount()
      await flush()

      expect(diaryApi.getCheckin).toHaveBeenCalledWith('c42')
      expect(diaryApi.getFeedback).not.toHaveBeenCalled()
      expect(bodyEl().querySelector('.detail__content')?.textContent).toBe('Из чек-ина')
    })

    it('type=feedback reads the FEEDBACK endpoint by the route id, and never the check-in one', async () => {
      routeParams.type = 'feedback'
      routeParams.id = 'f42'
      vi.mocked(diaryApi.getFeedback).mockResolvedValue(
        feedback({ id: 'f42', comment: 'Из фидбека' }),
      )
      mount()
      await flush()

      expect(diaryApi.getFeedback).toHaveBeenCalledWith('f42')
      expect(diaryApi.getCheckin).not.toHaveBeenCalled()
      expect(bodyEl().querySelector('.detail__content')?.textContent).toBe('Из фидбека')
    })
  })

  describe('the pill: the score reaches the screen as its zone (see the banner)', () => {
    it('a check-in pill carries the mood label -- «Check-in: Хорошо» + the high face', async () => {
      // mood 9 -> high (displayHelpers.ts:69-73, 8-10 -> high) -> «Хорошо».
      // The `not.toBe` lines pin the OLD BUG's exact output -- the bare kind over
      // the mid face, which is what MOOD_LABEL[9] / MOOD_ICON[9] returning
      // undefined used to produce. Revert .vue:144,152 to a raw-score index and
      // this test names the regression instead of merely failing.
      routeParams.type = 'checkin'
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ mood: 9 }))
      mount()
      await flush()

      expect(pillTitle()).toBe('Check-in: Хорошо')
      expect(pillTitle()).not.toBe('Check-in')
      expect(leadFace()).toBe('mood-high')
      expect(leadFace()).not.toBe('mood-mid')
    })

    it('a feedback pill carries the rating label -- «Feedback: Огонь!» + the fire glyph', async () => {
      // rating 10 -> fire (displayHelpers.ts:76-80, 8-10 -> fire) -> «Огонь!».
      // Same mechanism, the other half of the branch -- which is exactly why both
      // kinds are driven: one test would prove nothing about the other, and the
      // bug was duplicated across both maps, so the fix had to be too
      // (.vue:146,156).
      routeParams.type = 'feedback'
      vi.mocked(diaryApi.getFeedback).mockResolvedValue(feedback({ rating: 10 }))
      mount()
      await flush()

      expect(pillTitle()).toBe('Feedback: Огонь!')
      expect(pillTitle()).not.toBe('Feedback')
      expect(leadFace()).toBe('rating-fire')
      expect(leadFace()).not.toBe('rating-good')
    })

    it('sharpest form: the check-in pill MOVES with the mood zone -- low / mid / high all differ', async () => {
      // The two tests above could each be read as one lucky fixture. This one
      // cannot: it walks all three zones (1 -> low, 5 -> mid, 10 -> high) and the
      // pill must move on EVERY one. This is the assertion that was inverted while
      // the bug stood -- the user's worst morning and their best rendered the same
      // shrug over the same word. Now they render three different answers.
      routeParams.type = 'checkin'
      const seen: Array<{ mood: number; title: string | undefined; face: string }> = []
      for (const mood of [1, 5, 10]) {
        vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ mood }))
        mount()
        await flush()
        seen.push({ mood, title: pillTitle(), face: leadFace() })
        app?.unmount()
        host?.remove()
        app = null
        host = null
      }

      expect(seen).toEqual([
        { mood: 1, title: 'Check-in: Не очень', face: 'mood-low' },
        { mood: 5, title: 'Check-in: Нормально', face: 'mood-mid' },
        { mood: 10, title: 'Check-in: Хорошо', face: 'mood-high' },
      ])
      // The constant the screen used to render, in one line: three identical
      // shrugs. A regression collapses straight back to this.
      expect(seen.map((s) => s.face)).not.toEqual(['mood-mid', 'mood-mid', 'mood-mid'])
    })

    it('sharpest form: the feedback pill MOVES with the rating zone -- confused / good / fire all differ', async () => {
      routeParams.type = 'feedback'
      const seen: Array<{ rating: number; title: string | undefined; face: string }> = []
      for (const rating of [2, 5, 9]) {
        vi.mocked(diaryApi.getFeedback).mockResolvedValue(feedback({ rating }))
        mount()
        await flush()
        seen.push({ rating, title: pillTitle(), face: leadFace() })
        app?.unmount()
        host?.remove()
        app = null
        host = null
      }

      expect(seen).toEqual([
        { rating: 2, title: 'Feedback: Есть вопросы', face: 'rating-confused' },
        { rating: 5, title: 'Feedback: Хорошо', face: 'rating-good' },
        { rating: 9, title: 'Feedback: Огонь!', face: 'rating-fire' },
      ])
      expect(seen.map((s) => s.face)).not.toEqual(['rating-good', 'rating-good', 'rating-good'])
    })

    it('the pill renders at all, and only on the content rung', async () => {
      // The non-vacuous floor under the four tests above: they assert a CONSTANT,
      // so they must not be satisfiable by a pill that simply never rendered.
      // leadFace() throws when the icon is missing, and this pins the container.
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__pill')).not.toBeNull()
      expect(bodyEl().querySelector('.detail__pill-icon svg')).not.toBeNull()
      expect(bodyEl().querySelector('.detail__state')).toBeNull()
    })
  })

  describe('the date line is the READER\'s clock', () => {
    it('renders created_at in the user\'s timezone -- not the runner\'s, not UTC', async () => {
      // dateLine = formatFeedDateTime(created_at, tz) where tz is
      // `authStore.user?.timezone ?? 'UTC'` (.vue:113,163-165). Pinned three ways
      // apart (see the banner): 22:30Z is 01:30 on the 17th in MOSCOW (right),
      // 02:30 on the 17th in the RUNNER's Asia/Tbilisi, and 22:30 on the 16th in
      // UTC. So a screen that ignored tz shows the user the wrong DAY they wrote
      // on -- and this assertion cannot pass by coincidence in either direction.
      authState.user = { timezone: 'Europe/Moscow' }
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(
        checkin({ created_at: '2026-07-16T22:30:00Z' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__date')?.textContent).toBe(
        '17 июля • Пятница • 01:30',
      )
      expect(text()).not.toContain('02:30') // the runner's zone
      expect(text()).not.toContain('22:30') // the UTC fallback
    })

    it('falls back to UTC when the user has no timezone at all', async () => {
      // `authStore.user?.timezone ?? 'UTC'` (.vue:113). A user row with no zone
      // must still get a date, not a crash or an "Invalid Date".
      authState.user = null
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(
        checkin({ created_at: '2026-07-16T10:00:00Z' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__date')?.textContent).toBe(
        '16 июля • Четверг • 10:00',
      )
    })

    it('a feedback\'s date line comes off ITS created_at, through the same clock', async () => {
      // createdAt (.vue:162) coalesces checkin ?? feedback. The feedback half of
      // the branch must reach the same formatter with the same zone.
      routeParams.type = 'feedback'
      authState.user = { timezone: 'Europe/Moscow' }
      vi.mocked(diaryApi.getFeedback).mockResolvedValue(
        feedback({ created_at: '2026-07-16T22:30:00Z' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__date')?.textContent).toBe(
        '17 июля • Пятница • 01:30',
      )
    })
  })

  describe('the comment', () => {
    it('renders the row\'s full comment', async () => {
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(
        checkin({ comment: 'Проснулся до будильника и это было хорошо.' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__content')?.textContent).toBe(
        'Проснулся до будильника и это было хорошо.',
      )
      expect(bodyEl().querySelector('.detail__empty')).toBeNull()
    })

    it('a null comment renders «Без комментария», not an empty paragraph', async () => {
      // `v-if="comment"` / `v-else` (.vue:74-75). comment is nullable on both
      // kinds (generated.ts:378,555) -- a check-in is a mood tap with the text
      // optional, so this is the COMMON case, not an edge one.
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ comment: null }))
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__empty')?.textContent).toBe('Без комментария')
      expect(bodyEl().querySelector('.detail__content')).toBeNull()
    })

    it('a feedback\'s null comment takes the same fallback -- the coalesce does not leak the other kind', async () => {
      // comment = `checkin?.comment ?? feedback?.comment ?? null` (.vue:160). On
      // the feedback branch `checkin` is null, so the chain must fall THROUGH to
      // feedback rather than short-circuit. Asserted on the null case because
      // that is where a mis-ordered coalesce would show.
      routeParams.type = 'feedback'
      vi.mocked(diaryApi.getFeedback).mockResolvedValue(feedback({ comment: null }))
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__empty')?.textContent).toBe('Без комментария')
      expect(text()).not.toContain('Спокойное утро') // the check-in fixture's comment
    })
  })

  describe('the linked practice header', () => {
    it('fetches THAT practice by the row\'s practice_id and renders it above the pill', async () => {
      // The id must come from the ROW's practice_id (.vue:198,202,206) -- fetching
      // anything else would head a private entry with a stranger's class.
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: 'Анна', duration_minutes: 90 }),
      )
      mount()
      await flush()

      expect(practicesApi.getPractice).toHaveBeenCalledWith('p7')
      expect(bodyEl().querySelector('.practice-list-card__title')?.textContent).toBe(
        'Утренняя йога',
      )
      expect(bodyEl().querySelector('.practice-list-card__master-name')?.textContent).toBe('Анна')
      expect(bodyEl().querySelector('.practice-list-card__dur')?.textContent?.trim()).toBe(
        '1 ч 30 м',
      )
    })

    it('the practice time is shown in the READER\'s zone, not the practice\'s own', async () => {
      // practiceTime = formatTime(scheduled_at, tz) where tz is the USER's
      // (.vue:169-171) -- deliberately NOT practice.timezone, which is what
      // EditPracticeView uses (a master edits in the practice's zone; a reader
      // reads in their own). The fixture is pinned to Asia/Tokyo precisely so the
      // two answers differ: 10:00Z is 19:00 in Tokyo and 13:00 in Moscow.
      authState.user = { timezone: 'Europe/Moscow' }
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', scheduled_at: '2026-07-22T10:00:00Z', timezone: 'Asia/Tokyo' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.practice-list-card__when')?.textContent).toBe('13:00')
      expect(text()).not.toContain('19:00') // the practice's own zone
      expect(text()).not.toContain('14:00') // the runner's Asia/Tbilisi
    })

    it('the verified badge is deliberately omitted -- PracticeResponse carries no such flag', async () => {
      // `:show-verified="false"` (.vue:60), and the .vue:15-16 header comment says
      // why. PracticeListCard defaults showVerified to TRUE
      // (PracticeListCard.vue:76), so the prop is load-bearing: drop it and the
      // card paints a teal check this screen has no data to justify.
      mount()
      await flush()

      expect(bodyEl().querySelector('.practice-list-card')).not.toBeNull()
      expect(bodyEl().querySelector('.practice-list-card__verified')).toBeNull()
    })

    it('the header is inert -- a read-only screen must not offer a tap that goes nowhere', async () => {
      // `:clickable="false"` (.vue:59) makes PracticeListCard render a <div>
      // instead of a <button> (PracticeListCard.vue:32-37). It defaults to TRUE,
      // so without the prop the card would look tappable and emit @click into a
      // screen with no handler.
      mount()
      await flush()

      const card = bodyEl().querySelector('.practice-list-card')
      expect(card).not.toBeNull()
      expect(card?.tagName).toBe('DIV')
      expect(card?.classList.contains('practice-list-card--clickable')).toBe(false)
    })
  })

  describe('the context line -- the other half of the :type branch', () => {
    it('a CHECK-IN reads «Перед практикой», because it was written before', async () => {
      // contextLine (.vue:178-183). The preposition is the whole point: a check-in
      // is the pre-practice row and a feedback the post-practice one, and the line
      // is the only thing on this screen that says which.
      routeParams.type = 'checkin'
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: 'Анна' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__context')?.textContent).toBe(
        'Перед практикой: Утренняя йога с Анна',
      )
    })

    it('a FEEDBACK reads «После практики», because it was written after', async () => {
      routeParams.type = 'feedback'
      vi.mocked(diaryApi.getFeedback).mockResolvedValue(feedback({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: 'Анна' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__context')?.textContent).toBe(
        'После практики: Утренняя йога с Анна',
      )
    })

    it('a nameless master degrades to TWO DIFFERENT words -- «Мастером» in the line, «Мастер» on the card', async () => {
      // Not a typo on either side, and asserted together because they are one
      // screen's answer to one missing field. contextLine builds a Russian
      // instrumental case for "с ..." (.vue:180 -> «с Мастером»), while
      // PracticeListCard's own masterName fallback is the nominative
      // (PracticeListCard.vue:133 -> «Мастер»). Assert one alone and the next
      // editor "fixes" the mismatch by making them agree, breaking the grammar of
      // whichever side they align to.
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(checkin({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: null }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__context')?.textContent).toBe(
        'Перед практикой: Утренняя йога с Мастером',
      )
      expect(bodyEl().querySelector('.practice-list-card__master-name')?.textContent).toBe(
        'Мастер',
      )
      expect(text()).not.toContain('null')
    })

    it('a FAILED practice fetch degrades to the bare row -- the entry still renders', async () => {
      // .vue:205-210, best-effort by design: a deleted or forbidden practice must
      // never cost the user their own entry. Positive set pinned FIRST (SC-15) --
      // a mount that rendered nothing would satisfy the three absences for free.
      vi.mocked(diaryApi.getCheckin).mockResolvedValue(
        checkin({ practice_id: 'p7', comment: 'Уцелевший чек-ин' }),
      )
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(403, 'Нет доступа', 'forbidden'),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.detail__content')?.textContent).toBe('Уцелевший чек-ин')
      expect(bodyEl().querySelector('.detail__pill')).not.toBeNull()
      expect(bodyEl().querySelector('.practice-list-card')).toBeNull()
      expect(bodyEl().querySelector('.detail__context')).toBeNull()
      // The rung is for the ROW's failure, not the header's -- a best-effort extra
      // must not hijack the screen.
      expect(text()).not.toContain('Не удалось загрузить запись')
    })
  })

  describe('navigation', () => {
    it('back returns to the diary feed', async () => {
      // goBack pushes a NAMED route (.vue:223-225) rather than router.back() --
      // this screen is reachable by deep link, where there is no history to pop.
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-diary' })
    })

    it('back works from the ERROR rung too -- a failed load must not trap the user', async () => {
      // The header sits OUTSIDE the ladder (.vue:28-31), so the back button is
      // mounted on every rung. Worth pinning: a row that 404s would otherwise be a
      // dead end on a screen with no tab bar (UserShell.vue:52 hides it here).
      vi.mocked(diaryApi.getCheckin).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить запись')

      host?.querySelector<HTMLButtonElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-diary' })
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
//
// - AN INVALID `:type`. The .vue:8-9 comment claims the route regex constrains
//   the segment, and it CHECKS OUT -- router/index.ts:87 is
//   `path: 'diary/:type(checkin|feedback)/:id'`. So `/diary/banana/1` never
//   matches and never constructs this component, and `route.params.type ===
//   'feedback' ? 'feedback' : 'checkin'` (.vue:109-111) can only ever see the two
//   values tested above. Driving a third through the mocked useRoute would prove
//   the collapse-to-checkin default against an input the router cannot deliver --
//   testing the impossible, and worse, enshrining it so a later reader thinks the
//   default is load-bearing. It is not. (If the regex is ever relaxed, THAT is
//   when this becomes a real case -- and a real hazard.)
// - THE NO-PRACTICE BRANCH (`v-if="practice"` false via a null practice_id).
//   Unlike DiaryEntryResponse.practice_id, which is `string | null` (hence
//   EntryView's "no practice link" test), CheckinResponse.practice_id and
//   FeedbackResponse.practice_id are NON-NULLABLE `string` (generated.ts:374,
//   :551) -- a check-in exists only against a booking, so it always has one. The
//   `if (practiceId)` guard (.vue:204) is therefore unreachable from any record
//   the backend can send. The header's ABSENCE is covered where it is genuinely
//   reachable: the FAILED getPractice test above.
// - THE FOURTH LADDER STATE (loading false, loadError null, loaded false -> an
//   empty body). `loading` initialises to FALSE (.vue:125) and onMounted fires
//   reload (.vue:219), so this state exists for exactly the first render, before
//   any tick, and reload always lands in row-or-error thereafter. Not a state a
//   user can observe and not one a seam here can hold open.
// - PracticeListCard's own internals (the direction icon via practiceIconFor, the
//   master initial, the meta layout). Component-level behaviour of a shared DS
//   card, identical on the six screens that mount it. What belongs to DetailView
//   is WHICH props it passes -- the when/duration derivations, show-verified and
//   clickable -- and those ARE covered above.
// - formatFeedDateTime / formatTime / formatDuration themselves. Pure functions
//   covered at the util layer; this file asserts that the screen feeds them the
//   right instant and the right ZONE, which is the part that is DetailView's own.
// =============================================================================
