// =============================================================================
// VELO Frontend -- AdminMastersView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 428 lines. FIRST admin-zone screen covered -- establishes the shared admin
// harness (the @/api/admin seam, adminHelpers, the methodTaxonomy prime, and
// formatMoney NBSP handling) that later admin screens are expected to reuse.
//
// PATTERN = list-with-full-ladder + local refs. NO Pinia store -- the screen
// calls `getMastersList` (@/api/admin) DIRECTLY (.vue:128,248), confirmed by
// reading every import. Mocked seams: @/api/admin's getMastersList,
// @/utils/methodTaxonomy's primeMethodTaxonomyCatalog, @/composables/useToast.
// ApiResponseError kept REAL (importOriginal) for realistic error-path tests,
// same idiom as api/bookings.test.ts / TopupView.test.ts.
//
// WRONG-LAYER TRAP, CONFIRMED LIVE (.vue:248): `load()` does
// `await Promise.all([getMastersList(...), primeMethodTaxonomyCatalog()])`.
// primeMethodTaxonomyCatalog (methodTaxonomy.ts) calls the REAL
// `getActiveTaxonomy` (@/api/taxonomy) internally -- left unmocked, that is a
// real network call happy-dom has no way to satisfy, so it hangs/rejects and
// EVERY test (including the success/list ones) lands on the error rung
// instead of what it's meant to test. Fixed via a PARTIAL mock
// (`importOriginal`) on @/utils/methodTaxonomy: `primeMethodTaxonomyCatalog`
// is replaced with an always-resolving stub, while `parseMethods` and
// `directionLabel` stay REAL -- both are pure, and taxonomyChips (behaviour 5
// below) is testing THEIR actual output, not a fixture standing in for them.
//
// TAXONOMY FIXTURES ARE REAL, NOT INVENTED: read parseMethods (methodTaxonomy.ts:239-283)
// and practiceOptions.ts's DIRECTION_OPTIONS/STYLE_OPTIONS_BY_DIRECTION before
// authoring these. The SEP is ' — ' (space + U+2014 em dash + space,
// methodTaxonomy.ts:55) -- 'Медитация' -> direction 'meditation',
// 'Медитация — Медитация молчания' -> direction 'meditation' + style
// 'silence'. A string that matches neither a bare direction label nor a
// direction+style pair surfaces verbatim as the "custom" branch (Q3=А,
// SURFACE-UNMATCHED) -- used below to exercise taxonomyChips' legacy/unparsed
// fallback for real, not simulated.
//
// MONEY (NBSP -- the trap that has bitten agents before): payoutVal uses
// formatMoney(cents, 'EUR', 'ru', true). Verified directly in node that this
// repo's ICU renders "1 523,50 €" with TWO U+00A0 (NBSP) characters (as the
// thousands separator and before the currency symbol) for cents=152350.
// norm() below strips NBSP/narrow-no-break-space/thin-space (the same
// character class EditProfileView.test.ts's norm() targets, U+00A0/U+202F/
// U+2009, verified byte-for-byte after writing via `node -e` reading this
// file back). The regex's literal invisible characters and the EXPECTED
// string's plain ASCII space were both written through the Write tool, never
// a shell heredoc, which is what eats an NBSP before the test ever sees it.
//
// No modal, no v-show (grepped -- v-if throughout). No order dependence --
// every test mounts its own app.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminMastersView from '@/views/admin/AdminMastersView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminMasterListItem } from '@/api/admin'
import { applyTaxonomyCatalog } from '@/utils/methodTaxonomy'
import type { TaxonomyListResponse } from '@/api/taxonomy'

vi.mock('@/api/admin')

vi.mock('@/utils/methodTaxonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/methodTaxonomy')>()
  return {
    ...actual,
    primeMethodTaxonomyCatalog: vi.fn().mockResolvedValue(undefined),
  }
})

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function master(overrides: Partial<AdminMasterListItem> = {}): AdminMasterListItem {
  return {
    id: 'm_1',
    telegram_id: 1,
    first_name: 'Анна',
    last_name: 'Мастерова',
    avatar_url: null,
    role: 'master',
    is_active: true,
    master_status: 'verified',
    methods: [],
    practices_count: 0,
    students_count: 0,
    available_cents: null,
    ...overrides,
  }
}

const M_VERIFIED = master({
  id: 'm_verified',
  first_name: 'Анна',
  last_name: 'Верифицированная',
  master_status: 'verified',
  methods: ['Медитация — Медитация молчания'],
  practices_count: 12,
  students_count: 34,
  available_cents: 152350, // -> "1 523,50 €"
})
const M_PENDING_1 = master({
  id: 'm_pending_1',
  first_name: 'Борис',
  last_name: 'Ожидающий',
  master_status: 'pending',
  methods: ['Йога'], // bare direction, no style
  practices_count: null,
  students_count: 0,
  available_cents: null,
})
const M_PENDING_2 = master({
  id: 'm_pending_2',
  first_name: 'Вера',
  last_name: 'Тоже Ожидающая',
  master_status: 'pending',
  methods: [],
})
const M_REJECTED = master({
  id: 'm_rejected',
  first_name: 'Григорий',
  last_name: 'Отклонённый',
  master_status: 'rejected',
  methods: ['Кастомный метод'], // matches neither a direction nor a direction+style
  practices_count: 5,
  students_count: 2,
  available_cents: 0, // allowZero=true -> real "0,00 €", NOT '—'
})
const M_SUSPENDED = master({
  id: 'm_suspended',
  first_name: 'Дарья',
  last_name: 'Заблокированная',
  master_status: 'suspended',
  methods: [],
})

// T21-10 (ПРОМТ №546): a promoted custom direction+style pair, exact shape as
// the bug report (custom_xxxxxxxx slugs, minted by admin/masters/service.py's
// _promote_custom_methods) -- resolvable ONLY via the catalog, never the
// hardcoded DIRECTION_LABEL/STYLE_LABEL maps. Kept OUT of FULL_LIST so it
// never affects the other list/pagination/ordering tests; used standalone.
const M_CUSTOM_TAXONOMY = master({
  id: 'm_custom_taxonomy',
  first_name: 'Ирина',
  last_name: 'Кастомная',
  master_status: 'verified',
  methods: ['IFS — Ifstest'],
})

const FULL_LIST = [M_VERIFIED, M_PENDING_1, M_PENDING_2, M_REJECTED, M_SUSPENDED]

function paginated(items: AdminMasterListItem[], total?: number) {
  return { items, total: total ?? items.length, limit: 100, offset: 0 }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminMastersView)
  app.mount(host)
  return host
}

// onMounted -> await Promise.all([getMastersList, primeMethodTaxonomyCatalog])
// -- one microtask hop, then the ladder re-render. Generous headroom (SC-08).
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[   ]/g, ' ')
}

function cards(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.mcard') ?? [])
}
function cardByName(name: string): HTMLButtonElement | undefined {
  return cards().find((c) => c.querySelector('.mcard__name')?.textContent?.trim() === name)
}
function segmentItem(label: string): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment__item') ?? []).find(
    (b) => b.textContent?.includes(label),
  )
  if (!btn) throw new Error(`no segment item containing «${label}»`)
  return btn
}
function segmentBadge(label: string): string | undefined {
  return segmentItem(label).querySelector('.v-segment__badge')?.textContent?.trim()
}
function buttonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
    (b) => b.textContent?.trim() === t,
  )
}
function badgeIconKind(card: HTMLElement): 'check' | 'pending' | 'close' | 'unknown' {
  const svg = card.querySelector('.mcard__badge svg')
  if (!svg) return 'unknown'
  if ((svg.getAttribute('viewBox') ?? '').startsWith('72.69')) return 'pending'
  const d = svg.querySelector('path')?.getAttribute('d') ?? ''
  if (d.includes('M5 12.5L10 17.5L19 6.5')) return 'check'
  if (d.includes('M6 6L18 18M18 6L6 18')) return 'close'
  return 'unknown'
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(adminApi.getMastersList).mockReset().mockResolvedValue(paginated(FULL_LIST, 42))
  back.mockReset()
  push.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminMastersView', () => {
  // ===========================================================================
  describe('ladder + recovery', () => {
    it('shows the loading spinner while the fetch is in flight, then replaces it on resolve', async () => {
      // A controlled (never-auto-resolving) promise -- the default
      // mockResolvedValue fixture settles within one microtask, too fast to
      // ever observe the loading=true render (Vue schedules that re-render on
      // its OWN microtask, so it never beats an already-resolved fetch).
      let resolveList!: (v: ReturnType<typeof paginated>) => void
      vi.mocked(adminApi.getMastersList).mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveList = resolve
          }),
      )
      mount()
      await nextTick()

      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(cards()).toHaveLength(0)

      resolveList(paginated(FULL_LIST, 42))
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(cards()).toHaveLength(5)
    })

    it('success: renders one card per master', async () => {
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(cards()).toHaveLength(5)
    })

    // ПРОМТ №523 (T20-3 recon): pins the exact call args. Before ПРОМТ №289
    // (commit e579c17) this call sent `limit=200`, which the backend's
    // `le=100` constraint (admin/users/router.py:94) 422-rejected with
    // literally "Input should be less than or equal to 100" -- this test
    // mocks the api module, so it can only catch a regression in the value
    // .vue:248 passes, NOT a real backend-constraint mismatch (that needs a
    // real request; see the pytest/deploy battery, not this suite).
    it('requests exactly the backend page cap (limit=100, offset=0)', async () => {
      mount()
      await flush()

      expect(adminApi.getMastersList).toHaveBeenCalledWith(undefined, 100, 0)
    })

    it('failure (generic error): shows the error rung and toasts the fallback message', async () => {
      vi.mocked(adminApi.getMastersList).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Не удалось загрузить мастеров')
      expect(cards()).toHaveLength(0)
      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки мастеров')
    })

    it('failure (ApiResponseError): the error rung shows AND the toast carries the real backend detail', async () => {
      vi.mocked(adminApi.getMastersList).mockRejectedValue(
        new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Не удалось загрузить мастеров')
      expect(toastError).toHaveBeenCalledWith('Сервер недоступен')
    })

    it('"Повторить" re-calls load and recovers from error to content', async () => {
      vi.mocked(adminApi.getMastersList).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(host?.querySelector('.v-empty__title')).not.toBeNull()

      vi.mocked(adminApi.getMastersList).mockResolvedValue(paginated(FULL_LIST, 42))
      buttonByText('Повторить')?.click()
      await flush()

      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(cards()).toHaveLength(5)
    })
  })

  // ===========================================================================
  describe('empty rung, text varies by active filter', () => {
    it('"all" with zero masters: "Мастеров пока нет"', async () => {
      vi.mocked(adminApi.getMastersList).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.admin-list__empty')?.textContent).toBe('Мастеров пока нет')
      expect(cards()).toHaveLength(0)
    })

    it('"pending" with zero matching masters: "Нет мастеров на проверке"', async () => {
      vi.mocked(adminApi.getMastersList).mockResolvedValue(paginated([M_VERIFIED], 1))
      mount()
      await flush()

      segmentItem('Проверка').click()
      await flush()

      expect(host?.querySelector('.admin-list__empty')?.textContent).toBe('Нет мастеров на проверке')
    })
  })

  // ===========================================================================
  describe('status filter matrix (.vue:204-208)', () => {
    it('"all" shows every master', async () => {
      mount()
      await flush()

      expect(cards()).toHaveLength(5)
    })

    it('selecting "Проверка" shows only the pending masters', async () => {
      mount()
      await flush()

      segmentItem('Проверка').click()
      await flush()

      expect(cards()).toHaveLength(2)
      expect(cardByName('Борис Ожидающий')).toBeDefined()
      expect(cardByName('Вера Тоже Ожидающая')).toBeDefined()
      expect(cardByName('Анна Верифицированная')).toBeUndefined()
    })

    it('selecting "Верифиц." shows only the verified master', async () => {
      mount()
      await flush()

      segmentItem('Верифиц.').click()
      await flush()

      expect(cards()).toHaveLength(1)
      expect(cardByName('Анна Верифицированная')).toBeDefined()
    })
  })

  // ===========================================================================
  describe('counts (.vue:185-202)', () => {
    it('header shows the API total, not the fetched array length', async () => {
      mount()
      await flush()

      // total=42 from the fixture, but FULL_LIST only has 5 items.
      expect(host?.querySelector('.admin-list__count')?.textContent).toBe('42')
    })

    it('header shows "—" when total is 0', async () => {
      vi.mocked(adminApi.getMastersList).mockResolvedValue(paginated([], 0))
      mount()
      await flush()

      expect(host?.querySelector('.admin-list__count')?.textContent).toBe('—')
    })

    it('the "Проверка" segment badge shows the per-status count derived from the list (2)', async () => {
      mount()
      await flush()

      expect(segmentBadge('Проверка')).toBe('2')
    })
  })

  // ===========================================================================
  describe('taxonomyChips (.vue:141-160), REAL parseMethods/directionLabel', () => {
    it('a parsed direction+style method: a filled direction chip + a muted style chip', async () => {
      mount()
      await flush()

      const card = cardByName('Анна Верифицированная')!
      const chips = Array.from(card.querySelectorAll('.v-chip'))
      expect(chips.map((c) => c.textContent?.trim())).toEqual(['Медитация', 'Медитация молчания'])
      expect(chips[0]?.classList.contains('v-chip--active')).toBe(true) // direction: filled
      expect(chips[1]?.classList.contains('v-chip--active')).toBe(false) // style: muted
    })

    it('a fully-legacy/unparsed method: shown verbatim (the custom fallback)', async () => {
      mount()
      await flush()

      const card = cardByName('Григорий Отклонённый')!
      const chips = Array.from(card.querySelectorAll('.v-chip'))
      expect(chips.map((c) => c.textContent?.trim())).toEqual(['Кастомный метод'])
    })

    it('empty methods: "Направления не указаны", no chips', async () => {
      mount()
      await flush()

      const card = cardByName('Дарья Заблокированная')!
      expect(card.querySelectorAll('.v-chip')).toHaveLength(0)
      expect(card.querySelector('.mcard__muted')?.textContent).toBe('Направления не указаны')
    })
  })

  // ===========================================================================
  // T21-10 (ПРОМТ №546): the collapsed card's STYLE half used to read
  // STYLE_LABEL[st] ?? st (hardcoded map only) -- a catalog-only style (e.g.
  // under a promoted custom direction) fell through to its raw
  // custom_xxxxxxxx slug. Fixed by switching to resolveStyleLabel, which
  // also checks the catalog. This test MUST seed the REAL catalog
  // (applyTaxonomyCatalog, imported un-mocked) -- this file's
  // primeMethodTaxonomyCatalog mock is a no-op that never populates it, so a
  // test written only against that mock would pass with the bug present
  // (confirmed: every OTHER test in this describe block runs with an empty
  // catalog and only exercises the hardcoded-map/verbatim-fallback paths).
  describe('taxonomyChips: catalog-only custom direction+style (T21-10)', () => {
    afterEach(() => {
      // Module-level cache in methodTaxonomy.ts is a plain ref, not reset by
      // vi.clearAllMocks() -- clear it back to empty so this seed never
      // leaks into a sibling test that assumes an unprimed catalog.
      applyTaxonomyCatalog({ directions: [] } as TaxonomyListResponse)
    })

    it('resolves a catalog-only style label instead of printing the raw custom_ slug', async () => {
      applyTaxonomyCatalog({
        directions: [
          {
            id: 'd_custom',
            value: 'custom_9kzhq6f2',
            label: 'IFS',
            source: 'custom',
            is_active: true,
            styles: [
              {
                id: 's_custom',
                value: 'custom_orwj5nsl',
                label: 'Ifstest',
                is_active: true,
              },
            ],
          },
        ],
      } as unknown as TaxonomyListResponse)
      vi.mocked(adminApi.getMastersList).mockResolvedValue(paginated([M_CUSTOM_TAXONOMY], 1))
      mount()
      await flush()

      const card = cardByName('Ирина Кастомная')!
      const chips = Array.from(card.querySelectorAll('.v-chip'))
      expect(chips.map((c) => c.textContent?.trim())).toEqual(['IFS', 'Ifstest'])
      // The bug's exact symptom, pinned as a negative assertion:
      expect(card.textContent).not.toContain('custom_orwj5nsl')
      expect(card.textContent).not.toContain('custom_9kzhq6f2')
    })
  })

  // ===========================================================================
  describe('money (NBSP-safe) + stat values', () => {
    it('a real payout renders the formatted amount (NBSP-normalised)', async () => {
      mount()
      await flush()

      const card = cardByName('Анна Верифицированная')!
      const statVals = card.querySelectorAll('.mcard__stat-val')
      expect(statVals[0]?.textContent).toBe('12') // practices_count
      expect(statVals[1]?.textContent).toBe('34') // students_count
      expect(norm(statVals[2]?.textContent)).toBe('1 523,50 €') // available_cents
    })

    it('null practices/students/payout all render "—"', async () => {
      mount()
      await flush()

      const card = cardByName('Борис Ожидающий')!
      const statVals = card.querySelectorAll('.mcard__stat-val')
      expect(statVals[0]?.textContent).toBe('—') // practices_count: null
      expect(statVals[2]?.textContent).toBe('—') // available_cents: null
    })

    it('available_cents = 0 renders as REAL money, not "—" (allowZero)', async () => {
      mount()
      await flush()

      const card = cardByName('Григорий Отклонённый')!
      const payout = card.querySelectorAll('.mcard__stat-val')[2]
      expect(norm(payout?.textContent)).not.toBe('—')
      expect(norm(payout?.textContent)).toContain('0,00')
    })
  })

  // ===========================================================================
  describe('status badge label + icon (.vue:222-235)', () => {
    it('verified -> "Верифицирован" + the check icon', async () => {
      mount()
      await flush()

      const card = cardByName('Анна Верифицированная')!
      expect(card.querySelector('.mcard__badge')?.textContent).toContain('Верифицирован')
      expect(badgeIconKind(card)).toBe('check')
    })

    it('pending -> "Ожидает верификации" + the pending icon', async () => {
      mount()
      await flush()

      const card = cardByName('Борис Ожидающий')!
      expect(card.querySelector('.mcard__badge')?.textContent).toContain('Ожидает верификации')
      expect(badgeIconKind(card)).toBe('pending')
    })

    it('rejected -> "Отклонён" + the close icon', async () => {
      mount()
      await flush()

      const card = cardByName('Григорий Отклонённый')!
      expect(card.querySelector('.mcard__badge')?.textContent).toContain('Отклонён')
      expect(badgeIconKind(card)).toBe('close')
    })

    it('suspended -> "Заблокирован" + the close icon (else-branch)', async () => {
      mount()
      await flush()

      const card = cardByName('Дарья Заблокированная')!
      expect(card.querySelector('.mcard__badge')?.textContent).toContain('Заблокирован')
      expect(badgeIconKind(card)).toBe('close')
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('clicking a card pushes admin-master-review with the id and a DEEP-CLONED master in state', async () => {
      mount()
      await flush()

      cardByName('Анна Верифицированная')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'admin-master-review',
        params: { id: 'm_verified' },
        state: { master: M_VERIFIED },
      })
      // Deep-cloned (.vue:264, JSON round-trip) -- not the same object reference.
      const call = push.mock.calls[0]?.[0] as { state: { master: AdminMasterListItem } }
      expect(call.state.master).not.toBe(M_VERIFIED)
    })

    it('"Пригласить мастера" pushes admin-master-invite', async () => {
      mount()
      await flush()

      buttonByText('Пригласить мастера')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'admin-master-invite' })
    })
  })
})
