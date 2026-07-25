// =============================================================================
// VELO Frontend -- AdminPracticeDetailView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 282 lines. Read-only admin oversight of a single practice -- NO mutating
// actions, no store, no dialogs. PATTERN = route-param read-only detail
// screen, confirmed by reading every import: ONE seam from @/api/admin
// (getAdminPracticeDetail), plus ApiResponseError (@/api/client, kept REAL
// via importOriginal -- not mocked) and formatDateShort (@/utils/format,
// Date.now-dependent for its "Сегодня"/"Завтра" labels -- display only, not
// asserted with an exact string, same caution as prior admin coverage).
// PracticeHeroCard (@/components/shared) verified by READING its source
// (the MethodTaxonomyPicker precedent, checked so it isn't just assumed):
// props (title/direction/...) + a #meta slot only, NO onMounted, NO api
// import anywhere in its script -- purely presentational, no fetch seam, no
// dedicated test needed for it beyond the normal ladder/content tests that
// already render it.
//
// FOUR-RUNG LADDER, unlike AdminReportDetailView/AdminMasterReviewView's TWO
// (recon confirmed correct): loading (.vue:25) / error with a distinct
// "Повторить" retry (.vue:27-34, its OWN rung -- this screen DOES set an
// error ref on failure, unlike the two prior detail screens where a failed
// fetch collapsed into the same not-found rung) / content (.vue:36) / a
// final v-else "Практика недоступна" card (.vue:100-102). That fourth rung
// is reachable TWO ways, both measured below, not assumed:
//   (1) TRANSIENT, on every mount: `loading` starts as `ref(false)`, and
//       Vue's initial render/patch (inside the synchronous `app.mount()`
//       call) happens BEFORE `onMounted`'s `load()` gets a chance to flip
//       `loading.value = true` -- and that flip itself only SCHEDULES a
//       re-render (Vue's reactivity is microtask-batched), it doesn't force
//       one synchronously. So for one microtask, right after `app.mount()`
//       returns and before any `await`, the DOM is showing "Практика
//       недоступна", not the loader. Asserted below with a synchronous
//       (pre-`flush()`) DOM check.
//   (2) a genuinely malformed/empty success response (`practice.value`
//       stays falsy after `loading.value = false` because the resolved
//       body itself was falsy) would strand the screen here PERMANENTLY --
//       the API's declared return type is non-null, so this is a defensive/
//       contract-violation path, not a normal error or empty-list case
//       (empty roster is a DIFFERENT, correctly-labelled empty state, see
//       below) -- asserted below as an honest edge case, not a bug report.
//
// THE isPast SPLIT (.vue:133): `practice.status === 'past'` -- a SERVER
// FIELD read directly, NOT a clock/Date comparison (confirmed by reading
// the computed). Fixtures control the branch deterministically via
// `status`; formatDateShort's Date.now-dependence only affects the
// (unasserted-exact) `whenLabel` display string, not this branch.
//
// THREE EMPTY STATES ON THREE SEPARATE BRANCHES, each with a DISTINCT
// string that is exactly the kind of thing a copy-paste slip would cross:
// registered-empty = "Данных пока нет" (.vue:63), present-empty = "Данных
// пока нет" (.vue:81, SAME string as registered-empty, different branch),
// absent-empty = "Нет данных" (.vue:96, the ONLY one that differs). Queried
// below by walking to the DOM sibling immediately after each section's own
// <h3>, not by a page-wide text().toContain(), so a swap between the
// present/absent branches would actually fail the test that targets the
// swapped-into branch.
//
// ROSTER DERIVATION (.vue:156-163): `registered` = the whole roster
// (unfiltered); `present` = `roster.filter(r => r.status === 'attended')`;
// `absent` = `roster.filter(r => r.status !== 'attended')` -- an inverse
// boolean predicate, NOT an enum match against a specific "no_show" value,
// so ANY non-"attended" status (no_show, cancelled-but-still-listed,
// whatever) lands in `absent`. A mixed roster with three DIFFERENT status
// strings is used below to prove the predicate is boolean, not enum-based,
// and that nobody is lost or double-counted (present.length + absent.length
// === roster.length, no user_id in both).
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminPracticeDetailView from '@/views/admin/AdminPracticeDetailView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminPracticeDetailResponse, AdminRosterEntry } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
const routeParams: { id: string } = { id: 'p_upcoming' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

// -----------------------------------------------------------------------------
// Fixtures -- factory functions (not shared consts). This screen never
// mutates the loaded object in place (no mutating actions at all, unlike
// AdminMasterReviewView -- confirmed by reading every function in the
// script), so the №482 shared-fixture trap does not actually apply here,
// but factories cost nothing and keep the same discipline.
// -----------------------------------------------------------------------------

function rosterEntry(overrides: Partial<AdminRosterEntry> = {}): AdminRosterEntry {
  return {
    user_id: 'u_1',
    name: 'Анна Иванова',
    avatar_url: null,
    status: 'registered',
    ...overrides,
  }
}

function practice(overrides: Partial<AdminPracticeDetailResponse> = {}): AdminPracticeDetailResponse {
  return {
    id: 'p_1',
    title: 'Утренняя медитация',
    direction: 'meditation',
    master_name: 'Мария Петрова',
    master_verified: true,
    scheduled_at: '2020-01-15T10:00:00Z', // far from "today" -- avoids Сегодня/Завтра
    duration_minutes: 60,
    booked: 2,
    capacity: 10,
    status: 'upcoming',
    timezone: 'Europe/Berlin',
    attended: 0,
    roster: [rosterEntry({ user_id: 'u_1' }), rosterEntry({ user_id: 'u_2', name: 'Борис Сидоров' })],
    ...overrides,
  }
}

function PRACTICE_UPCOMING(): AdminPracticeDetailResponse {
  return practice({ id: 'p_upcoming', status: 'upcoming' })
}

function PRACTICE_PAST(): AdminPracticeDetailResponse {
  return practice({
    id: 'p_past',
    status: 'past',
    attended: 1,
    roster: [
      rosterEntry({ user_id: 'u_1', name: 'Пришедший Первый', status: 'attended' }),
      rosterEntry({ user_id: 'u_2', name: 'Отсутствовавший Второй', status: 'no_show' }),
    ],
  })
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(id: string): HTMLElement {
  routeParams.id = id
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminPracticeDetailView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function statValue(label: string): string {
  const cards = Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? [])
  const card = cards.find((c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label)
  if (!card) throw new Error(`no stat card labelled «${label}»`)
  return card.querySelector('.v-stat__value')?.textContent?.trim() ?? ''
}

/** The DOM node immediately after a section's own <h3>, i.e. that section's
 *  OWN items-list-or-empty-card -- not a page-wide text() search, so a
 *  present/absent string swap actually fails the test targeting it. */
function sectionAfterHeading(headingPrefix: string): HTMLElement {
  const headings = Array.from(host?.querySelectorAll<HTMLElement>('.admin-detail__section') ?? [])
  const h = headings.find((el) => el.textContent?.trim().startsWith(headingPrefix))
  if (!h) throw new Error(`no section heading starting with «${headingPrefix}»`)
  const sibling = h.nextElementSibling as HTMLElement | null
  if (!sibling) throw new Error(`no content after heading «${headingPrefix}»`)
  return sibling
}

function retryBtn(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === 'Повторить',
  )
}

function errorDesc(): string {
  return host?.querySelector('.v-empty__desc')?.textContent?.trim() ?? ''
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getAdminPracticeDetail).mockReset().mockResolvedValue(PRACTICE_UPCOMING())
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminPracticeDetailView', () => {
  // ===========================================================================
  describe('ladder (FOUR rungs -- see banner)', () => {
    it('loading -> content', async () => {
      let resolveGet!: (v: AdminPracticeDetailResponse) => void
      vi.mocked(adminApi.getAdminPracticeDetail).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve
          }),
      )
      mount('p_upcoming')
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()

      resolveGet(PRACTICE_UPCOMING())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(text()).toContain('Утренняя медитация')
    })

    it('failure (generic Error): falls back to "Ошибка загрузки", own error rung (not the not-found card)', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockRejectedValue(new Error('ECONNRESET'))
      mount('p_missing')
      await flush()

      expect(errorDesc()).toBe('Ошибка загрузки')
      expect(host?.querySelector('.v-empty')).not.toBeNull()
      expect(text()).not.toContain('Практика недоступна') // the OTHER rung -- not this one
    })

    it('failure (ApiResponseError): the error rung shows the real backend detail', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена', 'not_found'),
      )
      mount('p_missing')
      await flush()

      expect(errorDesc()).toBe('Практика не найдена')
    })

    it('«Повторить» recovers to content after a failure', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount('p_upcoming')
      await flush()

      expect(retryBtn()).toBeDefined()
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValueOnce(PRACTICE_UPCOMING())
      retryBtn()?.click()
      await flush()

      expect(host?.querySelector('.v-empty')).toBeNull()
      expect(text()).toContain('Утренняя медитация')
      expect(adminApi.getAdminPracticeDetail).toHaveBeenCalledTimes(2)
    })

    it('the FOURTH rung ("Практика недоступна") is transiently reachable right after mount, before the load() flip to loading=true has painted', () => {
      let resolveGet!: (v: AdminPracticeDetailResponse) => void
      vi.mocked(adminApi.getAdminPracticeDetail).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve
          }),
      )
      mount('p_upcoming')
      // NO await at all here -- checking the DOM in the exact synchronous tick
      // app.mount() returns in, before Vue's microtask-batched re-render from
      // onMounted's `loading.value = true` has had a chance to run.
      expect(text()).toContain('Практика недоступна')

      resolveGet(PRACTICE_UPCOMING())
    })

    it('the FOURTH rung is also reachable (permanently, not transiently) if the resolved response body itself is falsy -- an honest edge case for a contract violation, not a normal empty-list state', async () => {
      // @ts-expect-error -- deliberately violating the non-null return type to
      // simulate a malformed/empty backend response.
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(null)
      mount('p_upcoming')
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.v-empty')).toBeNull() // NOT the error rung -- no throw happened
      expect(text()).toContain('Практика недоступна')
    })
  })

  // ===========================================================================
  describe('THE isPast SPLIT (.vue:133) -- a server field, not a clock comparison', () => {
    it('NOT past: registered list + "Свободно" stat; the past-only sections do not render at all', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(PRACTICE_UPCOMING())
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('Свободно')
      expect(text()).not.toContain('Пришли')
      expect(text()).toContain('Записались')
      expect(text()).not.toContain('Присутствовали')
      expect(text()).not.toContain('Не пришли')
    })

    it('PAST: present + absent lists + "Пришли" stat; the registered section does not render at all', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(PRACTICE_PAST())
      mount('p_past')
      await flush()

      expect(text()).toContain('Пришли')
      expect(text()).not.toContain('Свободно')
      expect(text()).toContain('Присутствовали')
      expect(text()).toContain('Не пришли')
      expect(text()).not.toContain('Записались')
    })
  })

  // ===========================================================================
  describe('the three empty states -- distinct strings, correctly placed (see banner)', () => {
    it('registered-empty (upcoming, empty roster): "Данных пока нет" under «Записались»', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        PRACTICE_UPCOMING() && practice({ id: 'p_upcoming', status: 'upcoming', booked: 0, roster: [] }),
      )
      mount('p_upcoming')
      await flush()

      expect(sectionAfterHeading('Записались').textContent?.trim()).toBe('Данных пока нет')
      expect(host?.querySelector('.admin-detail__items')).toBeNull()
    })

    it('present-empty, absent has rows: "Данных пока нет" under «Присутствовали», real rows under «Не пришли»', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({
          id: 'p_past',
          status: 'past',
          attended: 0,
          roster: [rosterEntry({ user_id: 'u_1', name: 'Отсутствовавший', status: 'no_show' })],
        }),
      )
      mount('p_past')
      await flush()

      expect(sectionAfterHeading('Присутствовали').textContent?.trim()).toBe('Данных пока нет')
      expect(sectionAfterHeading('Не пришли').textContent).toContain('Отсутствовавший')
    })

    it('absent-empty, present has rows: "Нет данных" under «Не пришли», real rows under «Присутствовали»', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({
          id: 'p_past',
          status: 'past',
          attended: 1,
          roster: [rosterEntry({ user_id: 'u_1', name: 'Пришедший', status: 'attended' })],
        }),
      )
      mount('p_past')
      await flush()

      expect(sectionAfterHeading('Не пришли').textContent?.trim()).toBe('Нет данных')
      expect(sectionAfterHeading('Присутствовали').textContent).toContain('Пришедший')
    })

    it('BOTH past sections empty at once: "Данных пока нет" and "Нет данных" render in their OWN section, not swapped', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({ id: 'p_past', status: 'past', attended: 0, roster: [] }),
      )
      mount('p_past')
      await flush()

      expect(sectionAfterHeading('Присутствовали').textContent?.trim()).toBe('Данных пока нет')
      expect(sectionAfterHeading('Не пришли').textContent?.trim()).toBe('Нет данных')
    })
  })

  // ===========================================================================
  describe('roster derivation (.vue:156-163)', () => {
    it('a mixed roster (three DIFFERENT status strings) splits into present/absent by a boolean !== "attended" predicate -- nobody lost or double-counted', async () => {
      const mixed = [
        rosterEntry({ user_id: 'u_att_1', name: 'Пришёл Один', status: 'attended' }),
        rosterEntry({ user_id: 'u_att_2', name: 'Пришёл Два', status: 'attended' }),
        rosterEntry({ user_id: 'u_no_show', name: 'Не Пришёл', status: 'no_show' }),
        rosterEntry({ user_id: 'u_other', name: 'Третий Статус', status: 'cancelled' }),
      ]
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({ id: 'p_past', status: 'past', attended: 2, roster: mixed }),
      )
      mount('p_past')
      await flush()

      const presentBlock = sectionAfterHeading('Присутствовали').textContent ?? ''
      const absentBlock = sectionAfterHeading('Не пришли').textContent ?? ''

      expect(presentBlock).toContain('Пришёл Один')
      expect(presentBlock).toContain('Пришёл Два')
      expect(presentBlock).not.toContain('Не Пришёл')
      expect(presentBlock).not.toContain('Третий Статус')

      // "cancelled" is not "no_show" but the predicate is !== 'attended', so
      // it still lands in absent -- proving the boolean, not an enum match.
      expect(absentBlock).toContain('Не Пришёл')
      expect(absentBlock).toContain('Третий Статус')
      expect(absentBlock).not.toContain('Пришёл Один')
      expect(absentBlock).not.toContain('Пришёл Два')

      // Headings themselves carry the counts (.vue:68,83) -- 2 present, 2 absent.
      expect(host?.textContent).toContain('Присутствовали (2)')
      expect(host?.textContent).toContain('Не пришли (2)')
    })
  })

  // ===========================================================================
  describe('labels (.vue:143-153)', () => {
    it('attendedLabel falls back to "—" when attended is missing from a malformed response', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({
          id: 'p_past',
          status: 'past',
          attended: undefined, // Partial<> allows this -- attendedLabel's ?? still guards it
        }),
      )
      mount('p_past')
      await flush()

      expect(statValue('Пришли')).toBe('—')
    })

    it('freeLabel and capacityText both fall back to "∞" when capacity is null (unlimited)', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({ id: 'p_upcoming', status: 'upcoming', capacity: null, booked: 3 }),
      )
      mount('p_upcoming')
      await flush()

      expect(statValue('Свободно')).toBe('∞')
      expect(text()).toContain('Записались (3/∞)') // capacityText, same null-safe pattern
    })

    it('freeLabel clamps to "0" (never negative) when booked exceeds capacity', async () => {
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({ id: 'p_upcoming', status: 'upcoming', capacity: 5, booked: 8 }),
      )
      mount('p_upcoming')
      await flush()

      expect(statValue('Свободно')).toBe('0')
    })

    it('SW5: whenLabel renders in the PRACTICE\'s own timezone, not a hardcoded UTC default -- must agree with AdminPracticesView\'s list item, which already threads timezone through', async () => {
      // 2020-01-15T00:30:00Z: in UTC this is 15 января. In Pacific/Honolulu
      // (UTC-10, no DST) it is still 2020-01-14 14:30 local -- 14 января.
      // Before this fix, formatDateShort's timezone param defaulted to 'UTC'
      // (no third arg was ever passed), so this practice's OWN timezone
      // field was silently ignored and every detail page showed the UTC
      // date regardless of where the practice actually happens.
      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
        practice({
          id: 'p_upcoming',
          status: 'upcoming',
          scheduled_at: '2020-01-15T00:30:00Z',
          timezone: 'Pacific/Honolulu',
        }),
      )
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('14 января')
      expect(text()).not.toContain('15 января')
    })
  })

  // ===========================================================================
  // T21-1 (ПРОМТ №541): the Zoom section was built to close ПРОМТ №540's audit
  // finding -- the endpoint and its unmatched bucket existed with ZERO
  // frontend consumers. Fetched separately from the main practice detail
  // (own try/catch, own ref) so a failure here never blocks the roster/stats
  // that already worked before this section existed.
  describe('Zoom section (T21-1)', () => {
    function zoomAttendance(
      overrides: Partial<adminApi.AdminZoomAttendanceResponse> = {},
    ): adminApi.AdminZoomAttendanceResponse {
      return {
        practice_id: 'p_upcoming',
        zoom_meeting_status: 'active',
        report_ingested: false,
        bookings: [],
        unmatched: [],
        unmatched_count: 0,
        ...overrides,
      }
    }

    it('does not render at all when the fetch fails -- never blocks the rest of the page', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockRejectedValue(new Error('network down'))
      mount('p_upcoming')
      await flush()

      expect(text()).not.toContain('Статус встречи')
      // the rest of the page is unaffected
      expect(statValue('Записалось')).not.toBe('')
    })

    it('active meeting: shows the "Активна" badge', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockResolvedValue(zoomAttendance({ zoom_meeting_status: 'active' }))
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('Статус встречи')
      expect(text()).toContain('Активна')
    })

    it('no ZoomMeeting row at all (null status): shows "Не создана", not blank', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockResolvedValue(
        zoomAttendance({ zoom_meeting_status: null }),
      )
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('Не создана')
    })

    it('create_failed: shows "Ошибка создания", distinguishable from a healthy meeting', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockResolvedValue(
        zoomAttendance({ zoom_meeting_status: 'create_failed' }),
      )
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('Ошибка создания')
      expect(text()).not.toContain('Активна')
    })

    it('the unmatched bucket is VISIBLE as a count, not hidden -- both zero and non-zero', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockResolvedValue(
        zoomAttendance({ unmatched_count: 0 }),
      )
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('Нераспознанные участники')
      expect(text()).toContain('0')
    })

    it('a non-zero unmatched count is shown plainly, the whole point of the design (E21 step G)', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockResolvedValue(
        zoomAttendance({ unmatched_count: 4 }),
      )
      mount('p_upcoming')
      await flush()

      expect(text()).toContain('Нераспознанные участники')
      expect(text()).toContain('4')
    })
  })
})
