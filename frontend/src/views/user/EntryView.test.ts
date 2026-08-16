// =============================================================================
// VELO Frontend -- EntryView Screen Tests
// =============================================================================
//
// WHY: this is the only screen from which a user can destroy their own diary
// entry. onDelete() (.vue:286-297) fires DELETE /api/v1/diary/{id} and then
// hands the user back to the feed. Everything below exists to pin what that
// tap actually does -- because two things a reader would assume about it are
// FALSE, and both are load-bearing:
//
//   1. THERE IS NO CONFIRM. The trash VMenuItem's handler is
//      `() => { onDelete(); close() }` (.vue:54-59) and onDelete calls
//      diaryStore.deleteEntry(id) on the spot. No VConfirmDialog, no VModal, no
//      second tap. This is NOT the EditPracticeView shape ("Это действие нельзя
//      отменить" behind a dialog) -- one tap destroys. Pinned below, as the
//      behaviour that ships, in «one tap deletes».
//   2. IT IS NOT IRREVERSIBLE. deleteDiaryEntry is a SOFT delete
//      (api/diary.ts:239-244) and restoreDiaryEntry (:249-251) is its inverse.
//      The undo is not on this screen: the delete hands it to the feed through
//      `router.replace({ name:'user-diary', query:{ deleted: id } })` (.vue:296),
//      and DiaryFeedView raises the «Запись удалена / Отменить» bar off that
//      query param (covered in DiaryFeedView.test.ts).
//
// Those two facts are one design, not two accidents: the undo handoff IS the
// confirm. Which is why the sharpest assertion in this file is not "the dialog
// warned the user" -- there is no dialog -- but that the handoff carries THIS
// entry's id, and that a FAILED delete never performs it. Drop the id and the
// only recovery path the user has is gone; perform it on a failure and the feed
// offers to undo a delete that never happened.
//
// PATTERN A (store-backed). The entry's whole ladder lives in useDiaryStore --
// selectedEntry / selectedEntryLoading / selectedEntryError via storeToRefs
// (.vue:181) -- so the store and its useCursorPagination are REAL and the seam
// is @/api/diary, the wrapper the store imports. One pinia instance goes to BOTH
// setActivePinia and app.use (SC-03). @/api/practices is the second seam: the
// optional practice header is a direct getPractice() from the screen itself
// (.vue:227), not through any store.
//
// NOT PATTERN C, though it has a form. The edit fields (editTitle/editContent,
// .vue:239-240) are local refs, but they are not an independent half: startEdit
// seeds them FROM the fetched entry (.vue:253-260) and there is no form to drive
// before the data lands. So the form is exercised through real DOM typing (never
// by poking the refs) but it hangs off the same seam, not a second one.
//
// TICKS = 8. Counted (SC-08), not copied from the sibling that also lands on 8.
// The deepest chain is onSave, and it is deeper than the mount's:
//   onSave -> updateEntry -> updateDiaryEntry (1) -> feed.refresh -> loadMore ->
//   listDiaryFeed (2,3) -> loadMore returns (4) -> updateEntry resumes and
//   re-points selectedEntry (5) -> onSave resumes, saving=false, mode='view' (6)
//   -> re-render (7).
// onDelete is the same shape and depth (deleteEntry also refreshes the feed).
// The mount chain is shallower -- fetchEntry -> getDiaryEntry (1,2), then the
// practice branch's getPractice (3), re-render (4). 8 is one over the deepest;
// over-counting is harmless, under-counting fails loudly.
//
// listDiaryFeed IS MOCKED even though this screen never renders a feed. It is
// not decoration: EVERY entry mutation ends in `await feed.refresh()`
// (stores/diary.ts:300,317), so an automocked listDiaryFeed returning undefined
// would make loadMore throw on `result.items`. It is swallowed by loadMore's own
// catch (useCursorPagination.ts:83) rather than surfacing, which is exactly why
// it needs stating: the mutation would still report ok:true and nothing here
// would go red, while every save/delete test silently drove a broken refresh.
//
// TRAPS PRESENT:
//  - Wall clock / timezone: entryDate and practiceTime are Intl output keyed on
//    `authStore.user?.timezone ?? 'UTC'` (.vue:186). The RUNNER's zone must never
//    reach them, so the mocked auth store pins the zone per test and the fixtures
//    are literals against it. No vi.setSystemTime is needed -- see TRAPS ABSENT.
//  - SC-15: the "no practice link" and "failed practice fetch" tests pin the
//    POSITIVE set (the entry's own content rendered) BEFORE asserting the header
//    is absent, so a mount that rendered nothing cannot satisfy them.
//  - SC-17: VButton binds `:disabled="disabled || loading"` (VButton.vue:27) and
//    «Сохранить» is bound to `saving` on both (.vue:137-138). So the re-entry test
//    clicks twice with NO tick between -- nothing has re-rendered, no disabled
//    attribute can be doing the work, and the `saving` ref (.vue:263) is the only
//    defence. The disabled ATTRIBUTE is proven separately, as its own test, so
//    each mechanism is attributed to the right one. The delete path has no button
//    and no ref -- see the finding.
//  - SC-05, inverted: unlike DiaryFeedView (which hardcodes its rung copy), THIS
//    screen binds `:description="loadError"` (.vue:77), so the backend's own words
//    really do reach the DOM. Asserted as propagation, and the screen's own
//    constant title asserted alongside it, so neither is mistaken for the other.
//
// TRAPS ABSENT (proved, so the next reader does not cargo-cult the setup):
//  - NO teleported overlay AT ALL, therefore no SC-13/13b/13c and NO afterEach
//    purge. Grepped: this screen renders no VModal and no VBottomSheet. Its only
//    popover is VMenu's panel, which is a plain `position: absolute` div INSIDE
//    `.v-menu` (VMenu.vue:42, :127-129) -- it is not a Teleport, it lives under
//    host, and `v-if="open"` removes it outright with no <Transition> to park a
//    corpse. The «one tap deletes» test asserts `.v-modal__overlay` is null on
//    document.body, which is both the finding's proof AND this claim's.
//  - NO money, NO formatMoney anywhere in this screen's chain -> the ru U+00A0
//    trap (velo-idiom §11) cannot bite, so there is no norm() helper. The Intl
//    strings asserted here were codepoint-scanned directly rather than assumed:
//    «16 июля • Четверг • 10:00», «17 июля • Пятница • 01:30» and «13:00» contain
//    zero U+00A0/U+202F/U+2009 on this ICU build. Defensive code carrying a false
//    justification is worse than none.
//  - NO vi.setSystemTime. formatFeedDateTime / formatTime / formatDuration
//    (utils/format.ts:207,264,297) are pure Intl over the given instant + zone --
//    none of them reads `new Date()`. This screen has no «Сегодня»/«Завтра» badge
//    and no relative label, so freezing the clock would be dead setup. (Contrast
//    DiaryFeedView, whose day dividers DO call new Date().)
//  - NO v-show (grepped): the ladder is v-if / v-else-if / v-else-if and the two
//    modes are v-if / v-else, so the panes are genuinely mutually exclusive and
//    SC-14 does not bite. Nor the SC-14b sibling-section variant: there is one
//    section, one loader, one error string.
//  - NO IntersectionObserver / ResizeObserver, NO navigator.clipboard, NO
//    window.location assignment, NO window.history.state read, NO waitUntilReady
//    in the chain, NO localStorage.
//  - NO EMPTY RUNG. This screen fetches ONE record, so there is no empty state to
//    build -- fetchEntry (stores/diary.ts:250-261) always lands in exactly one of
//    entry-or-error, and `v-else-if="entry"` (.vue:84) has no v-else. Manufacturing
//    an empty rung here would assert a state the store cannot produce.
//
// NO ORDER DEPENDENCE. Declaration order is execution order; nothing relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import EntryView from '@/views/user/EntryView.vue'
import * as diaryApi from '@/api/diary'
import * as practicesApi from '@/api/practices'
// Stays REAL: vi.mock('@/api/diary') does not touch @/api/client, so the failure
// tests drive the real error class through extractApiError rather than a
// re-implemented one (velo-idiom §4).
import { ApiResponseError } from '@/api/client'
import type {
  DiaryEntryResponse,
  DiaryFeedResponse,
  PracticeResponse,
  UpdateDiaryEntryRequest,
} from '@/api/types'

vi.mock('@/api/diary')
vi.mock('@/api/practices')

const push = vi.fn()
const replace = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'e1' }

vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
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

function entry(overrides: Partial<DiaryEntryResponse> = {}): DiaryEntryResponse {
  return {
    id: 'e1',
    user_id: 'u1',
    practice_id: null,
    entry_type: 'note',
    practice_phase: null,
    title: 'Тихое утро',
    content: 'Сегодня было спокойно и ясно.',
    mood: null,
    is_deleted: false,
    created_at: '2026-07-16T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

// `timezone: 'Asia/Tokyo'` on purpose and it is NEVER the answer: this screen
// renders the practice in the VIEWER's zone, not the practice's. See the
// timezone test.
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

const EMPTY_FEED: DiaryFeedResponse = { items: [], next_cursor: null }

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(EntryView)
  app.use(pinia)
  app.mount(host)
  return host
}

// 8 ticks -- counted in the banner, not copied.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function bodyEl(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.entry__body')
  if (!el) throw new Error('.entry__body did not render')
  return el
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

/** The "..." kebab. Its items only exist in the DOM while the panel is open. */
function openMenu(): void {
  const trigger = host?.querySelector<HTMLButtonElement>('.v-menu__trigger')
  if (!trigger) throw new Error('the kebab trigger is not rendered')
  trigger.click()
}

function menuItem(ariaLabel: string): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`) ?? undefined
}

function titleInput(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('.entry__edit-title') ?? null
}

function contentArea(): HTMLTextAreaElement | null {
  return host?.querySelector<HTMLTextAreaElement>('.entry__edit-content') ?? null
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!el) throw new Error('field not rendered')
  el.value = value
  el.dispatchEvent(new Event('input'))
}

/** The body the screen actually PATCHed. */
function sentBody(): UpdateDiaryEntryRequest {
  const call = vi.mocked(diaryApi.updateDiaryEntry).mock.calls[0]
  if (!call) throw new Error('updateDiaryEntry was never called')
  return call[1]
}

/** Open the kebab and enter edit mode through the real pencil. */
async function startEditing(): Promise<void> {
  openMenu()
  await flush()
  menuItem('Редактировать')?.click()
  await flush()
}

beforeEach(() => {
  routeParams.id = 'e1'
  authState.user = { timezone: 'UTC' }
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(diaryApi.getDiaryEntry).mockReset().mockResolvedValue(entry())
  vi.mocked(diaryApi.updateDiaryEntry).mockReset().mockResolvedValue(entry())
  vi.mocked(diaryApi.deleteDiaryEntry).mockReset().mockResolvedValue(undefined)
  // Not decoration -- every mutation ends in feed.refresh(). See the banner.
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue(EMPTY_FEED)
  vi.mocked(practicesApi.getPractice).mockReset().mockResolvedValue(practice())

  push.mockReset()
  replace.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  // NO overlay purge here, deliberately: this screen teleports nothing. See
  // "TRAPS ABSENT" in the banner -- VMenu's panel is a plain absolute div under
  // host, so app.unmount() takes it with everything else.
  vi.clearAllMocks()
})

describe('EntryView', () => {
  describe('the state ladder', () => {
    it('shows the loader while the entry is in flight', async () => {
      vi.mocked(diaryApi.getDiaryEntry).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__state')).not.toBeNull()
      expect(bodyEl().querySelector('.entry__card')).toBeNull()
      expect(text()).not.toContain('Не удалось загрузить запись')
    })

    it('fetches THIS entry by the route id', async () => {
      routeParams.id = 'e42'
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ id: 'e42', content: 'Из сети' }))
      mount()
      await flush()

      expect(diaryApi.getDiaryEntry).toHaveBeenCalledWith('e42')
      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe('Из сети')
    })

    it('a failed fetch shows the rung AND surfaces the mapped table phrase for a real code', async () => {
      // SC-05, and this screen is the GOOD half of it: «Не удалось загрузить
      // запись» is the screen's own constant (.vue:76) but the description is
      // bound to `:description="loadError"` (.vue:77) -- unlike DiaryFeedView,
      // which hardcodes both. Both halves asserted so neither is read as
      // proof of the other.
      // B8 (PROMPT №747): 'not_found' IS a real backend code --
      // extractApiError now returns its table phrase regardless of the
      // mocked detail text.
      vi.mocked(diaryApi.getDiaryEntry).mockRejectedValue(
        new ApiResponseError(404, 'Запись удалена или не ваша', 'not_found'),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить запись',
      )
      expect(bodyEl().querySelector('.v-empty__desc')?.textContent).toBe(
        'Запрошенный ресурс не найден',
      )
      expect(bodyEl().querySelector('.entry__card')).toBeNull()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(diaryApi.getDiaryEntry).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(bodyEl().querySelector('.v-empty__desc')?.textContent).toBe('Запись не найдена')
    })

    it('«Повторить» re-fetches and replaces the rung with the entry', async () => {
      vi.mocked(diaryApi.getDiaryEntry).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить запись')

      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ content: 'Загрузилось' }))
      button('Повторить')?.click()
      await flush()

      expect(text()).not.toContain('Не удалось загрузить запись')
      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe('Загрузилось')
    })

    it('content: renders the title and body the store actually returned', async () => {
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ title: 'Тихое утро', content: 'Сегодня было спокойно и ясно.' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__heading')?.textContent).toBe('Тихое утро')
      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe(
        'Сегодня было спокойно и ясно.',
      )
      expect(bodyEl().querySelector('.entry__state')).toBeNull()
    })

    it('an untitled entry renders no heading, only the body', async () => {
      // `v-if="entry.title"` (.vue:102). A null title must not paint an empty
      // <h2> above the note.
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ title: null, content: 'Без заголовка' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe('Без заголовка')
      expect(bodyEl().querySelector('.entry__heading')).toBeNull()
    })
  })

  describe("the date line is the READER's clock", () => {
    it("renders created_at in the user's timezone, not the runner's", async () => {
      // entryDate = formatFeedDateTime(created_at, authStore.user.timezone)
      // (.vue:214-216). 22:30Z is 01:30 the NEXT DAY in Moscow -- so a screen
      // that fell back to UTC (or to the runner's zone) would show the user a
      // different DAY than the one they wrote on.
      authState.user = { timezone: 'Europe/Moscow' }
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ created_at: '2026-07-16T22:30:00Z' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__date')?.textContent).toBe('17 июля • Пятница • 01:30')
    })

    it('falls back to UTC when the user has no timezone at all', async () => {
      // `authStore.user?.timezone ?? 'UTC'` (.vue:186). A user row with no zone
      // must still get a date, not a crash or an "Invalid Date".
      authState.user = null
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ created_at: '2026-07-16T10:00:00Z' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__date')?.textContent).toBe('16 июля • Четверг • 10:00')
    })
  })

  describe('the optional practice header', () => {
    it('an entry with no practice link renders no header and no context line', async () => {
      // Screen 57. Pin the POSITIVE set first (SC-15): a mount that rendered
      // nothing would satisfy the two absences below for free.
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ practice_id: null, content: 'Просто заметка' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe('Просто заметка')
      expect(practicesApi.getPractice).not.toHaveBeenCalled()
      expect(bodyEl().querySelector('.practice-list-card')).toBeNull()
      expect(bodyEl().querySelector('.entry__context')).toBeNull()
    })

    it('a linked entry fetches THAT practice and renders it above the note', async () => {
      // Screen 56. The id must come from the ENTRY's practice_id (.vue:223) --
      // fetching anything else would head a private note with a stranger's class.
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: 'Анна' }),
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

    it("the practice time is shown in the READER's zone, not the practice's own", async () => {
      // practiceTime = formatTime(scheduled_at, tz) where tz is the USER's
      // (.vue:198-200) -- deliberately NOT practice.timezone, which is what
      // EditPracticeView uses (a master edits in the practice's zone; a reader
      // reads in their own). The fixture is pinned to Asia/Tokyo precisely so the
      // two answers differ: 10:00Z is 19:00 in Tokyo and 13:00 in Moscow.
      authState.user = { timezone: 'Europe/Moscow' }
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', scheduled_at: '2026-07-22T10:00:00Z', timezone: 'Asia/Tokyo' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.practice-list-card__when')?.textContent).toBe('13:00')
      expect(text()).not.toContain('19:00')
    })

    it('the context line names the practice and its master', async () => {
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: 'Анна' }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__context')?.textContent).toBe(
        'Связано с практикой: Утренняя йога с Анна',
      )
    })

    it('a nameless master degrades to «Мастером», not to «null»', async () => {
      // `practice.master_name ?? 'Мастером'` (.vue:208).
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ practice_id: 'p7' }))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p7', title: 'Утренняя йога', master_name: null }),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__context')?.textContent).toBe(
        'Связано с практикой: Утренняя йога с Мастером',
      )
    })

    it('a FAILED practice fetch degrades to the no-header layout -- the note still renders', async () => {
      // .vue:228-231, best-effort by design: a deleted or forbidden practice must
      // never cost the user their own note. Positive set pinned first (SC-15).
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ practice_id: 'p7', content: 'Уцелевшая заметка' }),
      )
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(403, 'Нет доступа', 'forbidden'),
      )
      mount()
      await flush()

      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe('Уцелевшая заметка')
      expect(bodyEl().querySelector('.practice-list-card')).toBeNull()
      expect(bodyEl().querySelector('.entry__context')).toBeNull()
      // The rung is for the ENTRY's failure, not the header's -- a best-effort
      // extra must not hijack the screen or nag the reader.
      expect(text()).not.toContain('Не удалось загрузить запись')
      expect(toastError).not.toHaveBeenCalled()
    })
  })

  describe('editing', () => {
    it('the pencil seeds the fields from the entry and swaps the card for the form', async () => {
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(
        entry({ title: 'Тихое утро', content: 'Сегодня было спокойно и ясно.' }),
      )
      mount()
      await flush()
      expect(titleInput()).toBeNull()

      await startEditing()

      expect(titleInput()?.value).toBe('Тихое утро')
      expect(contentArea()?.value).toBe('Сегодня было спокойно и ясно.')
      expect(bodyEl().querySelector('.entry__heading')).toBeNull()
      expect(button('Сохранить')).toBeDefined()
    })

    it('an untitled entry opens the editor with an EMPTY title, not «null»', async () => {
      // `entry.value.title ?? ''` (.vue:255).
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ title: null }))
      mount()
      await flush()

      await startEditing()

      expect(titleInput()?.value).toBe('')
    })

    it('DELETE IS UNREACHABLE WHILE EDITING -- the kebab is gone in edit mode', async () => {
      // `<VMenu v-if="mode === 'view'">` (.vue:39). Since the trash needs no
      // confirm (see the delete block), the mode gate is the only thing keeping a
      // one-tap destroy off a screen where the user is mid-sentence.
      mount()
      await flush()
      expect(host?.querySelector('.v-menu__trigger')).not.toBeNull()

      await startEditing()

      expect(host?.querySelector('.v-menu__trigger')).toBeNull()
      expect(menuItem('Удалить')).toBeUndefined()
    })

    it('back in EDIT mode returns to view without navigating away', async () => {
      // goBack branches on mode (.vue:301-307). Leaving the screen here would
      // drop the user's unsaved text on a control labelled «Назад».
      mount()
      await flush()
      await startEditing()

      host?.querySelector<HTMLButtonElement>('.v-back')?.click()
      await flush()

      expect(push).not.toHaveBeenCalled()
      expect(titleInput()).toBeNull()
      expect(bodyEl().querySelector('.entry__heading')?.textContent).toBe('Тихое утро')
    })

    it('an emptied body disables Сохранить and reaches no API', async () => {
      // canSave = content.trim().length > 0 (.vue:244), and onSave re-checks it
      // (.vue:263). An empty note is not an edit -- it is a delete by another name,
      // through a control that does not say so.
      mount()
      await flush()
      await startEditing()

      typeInto(contentArea(), '   ')
      await flush()

      const save = button('Сохранить')
      expect(save?.disabled).toBe(true)
      save?.click()
      await flush()

      expect(diaryApi.updateDiaryEntry).not.toHaveBeenCalled()
    })

    it('saves THIS entry by id with the exact body the backend expects', async () => {
      routeParams.id = 'e7'
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ id: 'e7' }))
      mount()
      await flush()
      await startEditing()

      typeInto(titleInput(), '  Новое имя  ')
      typeInto(contentArea(), '  Новый текст  ')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(diaryApi.updateDiaryEntry).toHaveBeenCalledTimes(1)
      expect(vi.mocked(diaryApi.updateDiaryEntry).mock.calls[0]?.[0]).toBe('e7')
      // Trimmed on both fields; clear_title false because a title survives.
      expect(sentBody()).toEqual({
        content: 'Новый текст',
        title: 'Новое имя',
        clear_title: false,
      })
    })

    it('emptying the title sends clear_title -- the sentinel, not a bare null', async () => {
      // `title: trimmedTitle || null, clear_title: !trimmedTitle` (.vue:268-270).
      // The backend distinguishes "not sent" from "set to null" via the sentinel
      // (api/diary.ts:228-230); a bare null with no flag would leave the old title
      // standing, so the user would delete their heading and watch it come back.
      mount()
      await flush()
      await startEditing()

      typeInto(titleInput(), '   ')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(sentBody()).toEqual({
        content: 'Сегодня было спокойно и ясно.',
        title: null,
        clear_title: true,
      })
    })

    it("on success it shows the SERVER's entry, not the text that was typed", async () => {
      // updateEntry re-points selectedEntry at the RESPONSE (stores/diary.ts:301-303),
      // so the view rung re-renders from the server's record. If the screen echoed
      // the local ref instead, a backend that normalised or rejected part of the
      // edit would be invisible until reload.
      mount()
      await flush()
      await startEditing()

      typeInto(contentArea(), 'Что я напечатал')
      await flush()
      vi.mocked(diaryApi.updateDiaryEntry).mockResolvedValue(
        entry({ title: 'Что вернул сервер', content: 'Нормализовано сервером' }),
      )

      button('Сохранить')?.click()
      await flush()

      expect(titleInput()).toBeNull()
      expect(bodyEl().querySelector('.entry__heading')?.textContent).toBe('Что вернул сервер')
      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe('Нормализовано сервером')
    })

    it('a FAILED save falls back to the generic message (unmapped code) and KEEPS the user in the editor', async () => {
      // .vue:274-277. Dropping back to view mode on a failure would show the user
      // the OLD text with no warning that their edit evaporated.
      // B8 (PROMPT №747): 'too_long' is not a real backend code -- unmapped,
      // lands on diaryStore.updateEntry's own fallback (stores/diary.ts:313).
      vi.mocked(diaryApi.updateDiaryEntry).mockRejectedValue(
        new ApiResponseError(422, 'Текст слишком длинный', 'too_long'),
      )
      mount()
      await flush()
      await startEditing()

      typeInto(contentArea(), 'Мой текст')
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось обновить запись')
      expect(contentArea()?.value).toBe('Мой текст')
      expect(button('Сохранить')).toBeDefined()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(diaryApi.updateDiaryEntry).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      await startEditing()

      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось обновить запись')
    })

    it('re-entry: two clicks with NO tick between them PATCH once', async () => {
      // SC-17. No await between the clicks, so the button has not re-rendered and
      // `:disabled="!canSave || saving"` cannot be what stops the second call --
      // the `saving` ref (.vue:263, set synchronously before the first await) is
      // the ONLY defence. Rip it out and this fails. The disabled attribute is
      // proven separately in the next test, so each mechanism gets its own credit.
      vi.mocked(diaryApi.updateDiaryEntry).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()
      await startEditing()

      const save = button('Сохранить')
      expect(save).toBeDefined()
      save!.click()
      save!.click()
      await flush()

      expect(diaryApi.updateDiaryEntry).toHaveBeenCalledTimes(1)
    })

    it('the disabled rung: an in-flight save disables the button and shows the spinner', async () => {
      // The OTHER half of SC-17, asserted on its own so the test above cannot be
      // credited to it. This one really is about the attribute:
      // `:disabled="!canSave || saving"` + `:loading="saving"` (.vue:137-138) ->
      // VButton binds `disabled || loading` (VButton.vue:27).
      vi.mocked(diaryApi.updateDiaryEntry).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()
      await startEditing()

      const save = button('Сохранить')
      expect(save?.disabled).toBe(false)

      save?.click()
      await flush()

      expect(button('Сохранить')?.disabled).toBe(true)
      expect(host?.querySelector('.v-btn__spinner')).not.toBeNull()
    })
  })

  describe('deleting: one tap, no confirm, undo delegated to the feed', () => {
    it('ONE TAP DELETES -- there is no confirm between the user and the DELETE', async () => {
      // FINDING, pinned as today's behaviour rather than fixed (this file does not
      // touch product code). The trash's handler is `onDelete(); close()`
      // (.vue:54-59) and onDelete calls the store immediately (.vue:289). Contrast
      // EditPracticeView, where the equivalent tap only OPENS a dialog and its test
      // asserts `deletePractice` was NOT called.
      //
      // The `.v-modal__overlay` assertion is doing real work twice over: it proves
      // no VConfirmDialog/VModal stands in the way (the finding), and it is this
      // file's evidence for the "no teleported overlay" claim in the banner -- the
      // reason there is no SC-13 purge in afterEach.
      routeParams.id = 'e7'
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ id: 'e7' }))
      mount()
      await flush()

      openMenu()
      await flush()
      menuItem('Удалить')?.click()
      await flush()

      expect(document.body.querySelector('.v-modal__overlay')).toBeNull()
      expect(diaryApi.deleteDiaryEntry).toHaveBeenCalledTimes(1)
      expect(diaryApi.deleteDiaryEntry).toHaveBeenCalledWith('e7')
    })

    it('the trash is marked destructive and the pencil is not (danger added №444)', async () => {
      // VMenuItem ships `danger?: boolean` (VMenuItem.vue:36, default false) painting
      // `.v-menu-item--danger` (:16,63). EntryView passed it on NEITHER item until
      // №444, so the control that destroys the entry looked identical to the one that
      // edits it. Deliberately NO confirm dialog (operator ruling): the undo bar IS
      // the confirm -- that is what the soft delete is for -- so this colour is the
      // whole of the signal and is worth asserting.
      //
      // The pencil assertion is the non-vacuous half: `danger` on BOTH would make
      // the first line pass while proving nothing about distinguishing them.
      mount()
      await flush()

      openMenu()
      await flush()

      expect(menuItem('Удалить')).toBeDefined()
      expect(menuItem('Удалить')?.classList.contains('v-menu-item--danger')).toBe(true)
      expect(menuItem('Редактировать')?.classList.contains('v-menu-item--danger')).toBe(false)
    })

    it("a successful delete hands the undo to the feed carrying THIS entry's id", async () => {
      // .vue:296. THE assertion of this file. The delete is soft
      // (api/diary.ts:239-244) and restoreDiaryEntry is its inverse -- but the only
      // way a user can ever reach that inverse is this query param, which
      // DiaryFeedView turns into the «Запись удалена / Отменить» bar. A wrong id
      // restores someone else's note; a missing one silently strips the user's only
      // recovery path while still telling them it is gone.
      routeParams.id = 'e7'
      vi.mocked(diaryApi.getDiaryEntry).mockResolvedValue(entry({ id: 'e7' }))
      mount()
      await flush()

      openMenu()
      await flush()
      menuItem('Удалить')?.click()
      await flush()

      expect(replace).toHaveBeenCalledTimes(1)
      expect(replace).toHaveBeenCalledWith({ name: 'user-diary', query: { deleted: 'e7' } })
      // replace, not push: the dead entry's URL must not sit in the back stack.
      expect(push).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a FAILED delete shows the mapped table phrase for a real code and NEVER navigates -- no undo bar for a delete that did not happen', async () => {
      // .vue:290-293. Navigating on a failure would hand the feed a `deleted=` id,
      // which raises «Запись удалена / Отменить» over an entry that is still there
      // -- the screen would be lying, and the offered undo would restore nothing.
      // B8 (PROMPT №747): 'conflict' IS a real backend code -- extractApiError
      // now returns its table phrase regardless of the mocked detail text.
      vi.mocked(diaryApi.deleteDiaryEntry).mockRejectedValue(
        new ApiResponseError(409, 'Запись уже удалена', 'conflict'),
      )
      mount()
      await flush()

      openMenu()
      await flush()
      menuItem('Удалить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith(
        'Конфликт с текущим состоянием — попробуйте обновить страницу',
      )
      expect(replace).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      // Still on the entry, still readable -- the failure cost the user nothing.
      expect(bodyEl().querySelector('.entry__content')?.textContent).toBe(
        'Сегодня было спокойно и ясно.',
      )
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(diaryApi.deleteDiaryEntry).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      openMenu()
      await flush()
      menuItem('Удалить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось удалить запись')
      expect(replace).not.toHaveBeenCalled()
    })

    it('re-entry: two taps with NO tick between them fire ONE DELETE (guard added №444)', async () => {
      // Was the FINDING from №443, fixed by operator ruling: onDelete had no
      // `deleting` ref while onSave twenty lines up had `saving` (.vue:263) -- the
      // one destructive path in the repo without a guard.
      //
      // THE REF IS THE ONLY DEFENCE HERE, and that is what makes this test honest
      // rather than SC-17-shaped. VMenuItem ships NO `disabled` prop at all
      // (VMenuItem.vue -- grepped), so there is no disabled attribute that could be
      // quietly doing the work, the way VButton's `:disabled="disabled || loading"`
      // does elsewhere. And `close()` only flips `open`, which takes effect on the
      // NEXT render -- so with no tick between the taps the panel and its handler
      // are still live and the second tap genuinely re-enters onDelete. The store
      // cannot save it either: deleteEntry nulls selectedEntry only AFTER its await
      // (stores/diary.ts:317-320), long after a second call would have read
      // `entry.value` and gone.
      //
      // Mutation-verified: removing `|| deleting.value` from .vue:287 turns this
      // back to 2 and fails. Nothing else in the file catches that.
      vi.mocked(diaryApi.deleteDiaryEntry).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      openMenu()
      await flush()
      const trash = menuItem('Удалить')
      expect(trash).toBeDefined()
      trash!.click()
      trash!.click()
      await flush()

      expect(diaryApi.deleteDiaryEntry).toHaveBeenCalledTimes(1)
    })

    it('a failed delete releases the guard so the user can retry', async () => {
      // The other side: latching `deleting` forever on failure would leave the entry
      // undeletable until a remount. Not reset on SUCCESS -- there we navigate away
      // and staying latched is what stops a double handoff mid-navigation.
      vi.mocked(diaryApi.deleteDiaryEntry).mockRejectedValueOnce(
        new ApiResponseError(500, 'Не удалось удалить запись', 'server_error'),
      )
      mount()
      await flush()

      openMenu()
      await flush()
      menuItem('Удалить')!.click()
      await flush()
      expect(toastError).toHaveBeenCalledWith('Не удалось удалить запись')

      vi.mocked(diaryApi.deleteDiaryEntry).mockClear()
      vi.mocked(diaryApi.deleteDiaryEntry).mockResolvedValue(undefined as never)
      openMenu()
      await flush()
      menuItem('Удалить')!.click()
      await flush()

      expect(diaryApi.deleteDiaryEntry).toHaveBeenCalledTimes(1)
    })
  })

  describe('navigation', () => {
    it('back in VIEW mode returns to the diary feed', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-back')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-diary' })
    })

    it('the kebab closes after an action instead of hanging over the screen', async () => {
      // The `close` slot-prop (VMenu.vue:42-44) is wired by the CALLER on each item
      // (.vue:47,57) -- VMenu does not close itself. Forget it on one item and that
      // action leaves the popover parked over the content it just changed.
      mount()
      await flush()

      openMenu()
      await flush()
      expect(host?.querySelector('.v-menu__panel')).not.toBeNull()

      menuItem('Редактировать')?.click()
      await flush()

      expect(host?.querySelector('.v-menu__panel')).toBeNull()
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
//
// - autogrow() (.vue:246-251). It reads `el.scrollHeight`, and happy-dom has NO
//   layout engine -- scrollHeight is a hard 0, so the branch runs, computes
//   `height: 0px`, and "passes" while proving nothing about whether the textarea
//   grows. That is the SC-14 shape (a test that cannot fail), so it is left out
//   rather than faked. Genuinely needs a browser.
// - MAX_TITLE_LEN / MAX_CONTENT_LEN (.vue:172-173). They reach the DOM as
//   `maxlength` attributes, and the enforcement is the BROWSER's -- happy-dom does
//   not truncate on programmatic `.value =`, so a test would be asserting the
//   attribute's presence, i.e. that the literal is bound to itself. The gate that
//   is really this screen's own (canSave / the empty-body refusal) IS covered.
// - The «Запись удалена / Отменить» bar and restoreEntry. This screen's half of
//   the handoff -- the exact replace() payload -- is asserted above; the feed's
//   half (reading ?deleted=, raising the bar, calling restoreEntry, and the failed
//   restore) is DiaryFeedView's own screen and is covered in DiaryFeedView.test.ts.
//   Duplicating it here would test that file's screen, not this one.
// - VMenu's outside-click / Esc dismissal (VMenu.vue:73-90). Component-level
//   behaviour of a shared UI primitive, identical on every screen that mounts it;
//   what belongs to EntryView is that each item wires `close`, which IS covered.
// - The unreachable fourth ladder state (`loading` false, `loadError` null,
//   `entry` null -> an empty body). fetchEntry always lands in entry-or-error
//   (stores/diary.ts:250-261), so no seam here can produce it. See the banner.
// =============================================================================
