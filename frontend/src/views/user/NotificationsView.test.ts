// =============================================================================
// VELO Frontend -- NotificationsView Screen Tests (rebuilt for T-26)
// =============================================================================
//
// The screen changed source of truth. It used to write four flags into our own
// backend via authStore.updateProfile; those flags silenced nothing and the
// store is retired. It now reads and writes comms CATEGORIES through the proxy
// (GET/PUT /api/v1/notifications/prefs, @/api/notifications). So the seam moved
// too: @/api/notifications is mocked here, the auth store is no longer involved
// at all, and the old fixture that supplied UserResponse.notifications is gone
// with the field.
//
// FOUR THINGS THESE TESTS EXIST FOR, none of which anything asserted before:
//   1. FOUR, NOT FIVE -- silence-everything writes exactly the categories the
//      screen SHOWS. `msg_support` is returned by the server (it is a real
//      declared category) and must never appear in a write: a student is never
//      the operator side of a thread, so it has no row.
//   2. THE DERIVED MASTER SWITCH -- its position is computed, never stored.
//      Re-enabling one row lifts it by itself (owner ruling 2026-08-13), which
//      is the whole reason a single category can come back without losing the
//      rest.
//   3. THE 404 -- an unsynced recipient must DISABLE the switches, not offer a
//      save with nowhere to go.
//   4. ONE CATEGORY ADDRESSED BY MORE THAN ONE CONTROL -- the master switch and
//      a row both write `reminders`. Nothing anywhere tested that before.
//
// VSwitch is bound ONE-WAY (`:model-value` + `@update:model-value`), so there
// is no dual-binding race and the catch-path revert is live code. VSwitch's own
// `toggle()` returns early when disabled, so a disabled row never even emits --
// which is what the 404 test leans on.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import NotificationsView from '@/views/user/NotificationsView.vue'

const prefsGet = vi.fn()
const prefsPut = vi.fn()
vi.mock('@/api/notifications', () => ({
  getNotificationPrefs: (...a: unknown[]) => prefsGet(...a),
  updateNotificationPrefs: (...a: unknown[]) => prefsPut(...a),
}))

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: toastSuccess }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

// The comms facade reports one key per category the profile DECLARES -- all
// five, including the one this screen deliberately does not show.
function prefs(categories: Record<string, boolean> = {}) {
  return {
    categories: {
      bookings: true,
      finance: true,
      msg_participants: true,
      msg_support: true,
      reminders: true,
      ...categories,
    },
    schedule: null,
    timezone: 'Europe/Moscow',
  }
}

const LABEL = {
  master: 'Уведомления',
  reminders: 'Напоминания о практиках',
  bookings: 'Записи и переносы',
  msg_participants: 'Сообщения',
  finance: 'Кошелёк',
} as const

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(NotificationsView)
  app.mount(host)
  return host
}

// onMounted load -> await -> re-render; then each save is another await chain.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function rowByLabel(label: string): HTMLElement {
  const row = Array.from(host?.querySelectorAll<HTMLElement>('.notifications__row') ?? []).find(
    (r) => r.querySelector('.notifications__label')?.textContent?.trim() === label,
  )
  if (!row) throw new Error(`no row labelled «${label}»`)
  return row
}
function switchByLabel(label: string): HTMLButtonElement {
  const btn = rowByLabel(label).querySelector<HTMLButtonElement>('.v-switch')
  if (!btn) throw new Error(`no VSwitch in row «${label}»`)
  return btn
}
function isOn(label: string): boolean {
  return switchByLabel(label).getAttribute('aria-checked') === 'true'
}
function isDisabled(label: string): boolean {
  return switchByLabel(label).disabled
}
// The body of the most recent PUT. Throws rather than returning undefined: a
// test that reaches here expecting a write and finding none should say so, not
// fail later on an opaque property access.
function lastPutBody(): { categories: Record<string, boolean> } {
  const call = prefsPut.mock.calls.at(-1)
  if (!call) throw new Error('updateNotificationPrefs was never called')
  return call[0] as { categories: Record<string, boolean> }
}

beforeEach(() => {
  vi.clearAllMocks()
  prefsGet.mockResolvedValue(prefs())
  prefsPut.mockImplementation(() => Promise.resolve(prefs()))
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

// -----------------------------------------------------------------------------

describe('NotificationsView -- shape', () => {
  it('renders the master row plus one row per shown category, and no others', async () => {
    mount()
    await flush()

    const labels = Array.from(host?.querySelectorAll('.notifications__label') ?? []).map((n) =>
      n.textContent?.trim(),
    )

    expect(labels).toEqual([
      LABEL.master,
      LABEL.reminders,
      LABEL.bookings,
      LABEL.msg_participants,
      LABEL.finance,
    ])
    // Five categories come back from the server; four get a row.
    expect(labels).toHaveLength(5) // 1 master + 4 categories
  })

  it('reflects the server state rather than a local default', async () => {
    prefsGet.mockResolvedValue(prefs({ bookings: false, finance: false }))
    mount()
    await flush()

    expect(isOn(LABEL.reminders)).toBe(true)
    expect(isOn(LABEL.bookings)).toBe(false)
    expect(isOn(LABEL.msg_participants)).toBe(true)
    expect(isOn(LABEL.finance)).toBe(false)
    // Something is still enabled -> the master switch reads ON.
    expect(isOn(LABEL.master)).toBe(true)
  })
})

describe('NotificationsView -- a single category', () => {
  it('writes only the flipped category', async () => {
    mount()
    await flush()

    switchByLabel(LABEL.bookings).click()
    await flush()

    expect(prefsPut).toHaveBeenCalledTimes(1)
    expect(lastPutBody()).toEqual({ categories: { bookings: false } })
    expect(isOn(LABEL.bookings)).toBe(false)
    expect(isOn(LABEL.reminders)).toBe(true)
  })

  it('reverts and toasts when the save fails', async () => {
    mount()
    await flush()
    prefsPut.mockRejectedValueOnce(new Error('boom'))

    switchByLabel(LABEL.finance).click()
    await flush()

    expect(isOn(LABEL.finance)).toBe(true) // reverted, not left off
    expect(toastError).toHaveBeenCalledWith('Не удалось сохранить настройку')
  })
})

describe('NotificationsView -- silence everything (four, not five)', () => {
  it('mutes exactly the four shown categories and never msg_support', async () => {
    mount()
    await flush()

    switchByLabel(LABEL.master).click()
    await flush()

    const body = lastPutBody()
    expect(body).toEqual({
      categories: {
        reminders: false,
        bookings: false,
        msg_participants: false,
        finance: false,
      },
    })
    // The one that matters: a declared category with no row is untouched.
    expect(Object.keys(body.categories)).not.toContain('msg_support')
    expect(Object.keys(body.categories)).toHaveLength(4)
  })

  it('turning it back on re-enables the same four', async () => {
    prefsGet.mockResolvedValue(
      prefs({
        reminders: false,
        bookings: false,
        msg_participants: false,
        finance: false,
      }),
    )
    mount()
    await flush()
    expect(isOn(LABEL.master)).toBe(false)

    switchByLabel(LABEL.master).click()
    await flush()

    expect(lastPutBody()).toEqual({
      categories: {
        reminders: true,
        bookings: true,
        msg_participants: true,
        finance: true,
      },
    })
  })
})

describe('NotificationsView -- the derived master switch', () => {
  it('reads OFF exactly when every shown category is muted', async () => {
    prefsGet.mockResolvedValue(
      prefs({
        reminders: false,
        bookings: false,
        msg_participants: false,
        // finance still enabled -> not "everything off"
      }),
    )
    mount()
    await flush()
    expect(isOn(LABEL.master)).toBe(true)

    switchByLabel(LABEL.finance).click()
    await flush()

    // Now everything shown is muted -- and nobody wrote a master flag.
    expect(isOn(LABEL.master)).toBe(false)
    expect(lastPutBody()).toEqual({ categories: { finance: false } })
  })

  it('is lifted by re-enabling ONE row, without restoring the rest', async () => {
    mount()
    await flush()
    switchByLabel(LABEL.master).click()
    await flush()
    expect(isOn(LABEL.master)).toBe(false)

    // Ruling 2: rows stay live while silenced, so one category can come back.
    expect(isDisabled(LABEL.reminders)).toBe(false)
    switchByLabel(LABEL.reminders).click()
    await flush()

    expect(isOn(LABEL.master)).toBe(true) // lifted by itself
    expect(isOn(LABEL.reminders)).toBe(true)
    // The others stayed muted -- that is the point of keeping the rows live.
    expect(isOn(LABEL.bookings)).toBe(false)
    expect(isOn(LABEL.msg_participants)).toBe(false)
    expect(isOn(LABEL.finance)).toBe(false)
    // And the lift wrote ONE category, not a restore-all.
    expect(lastPutBody()).toEqual({ categories: { reminders: true } })
  })
})

describe('NotificationsView -- one category, two controls', () => {
  it('stays coherent when the master and a row address the same category', async () => {
    mount()
    await flush()

    // Control 1: the row mutes `reminders`.
    switchByLabel(LABEL.reminders).click()
    await flush()
    expect(isOn(LABEL.reminders)).toBe(false)
    expect(isOn(LABEL.master)).toBe(true) // three others still on

    // Control 2: the master mutes everything, including `reminders` again.
    switchByLabel(LABEL.master).click()
    await flush()
    expect(lastPutBody().categories.reminders).toBe(false)
    expect(isOn(LABEL.reminders)).toBe(false)

    // Control 1 again, on the same category the master just wrote.
    switchByLabel(LABEL.reminders).click()
    await flush()
    expect(isOn(LABEL.reminders)).toBe(true)
    expect(isOn(LABEL.master)).toBe(true)
    // No divergence: the row's own write is the last word for that key.
    expect(lastPutBody()).toEqual({ categories: { reminders: true } })
  })

  it('a failed master write leaves every row where it was', async () => {
    prefsGet.mockResolvedValue(prefs({ bookings: false }))
    mount()
    await flush()
    prefsPut.mockRejectedValueOnce(new Error('boom'))

    switchByLabel(LABEL.master).click()
    await flush()

    // The whole batch reverts to its per-row prior state, not to a blanket on.
    expect(isOn(LABEL.reminders)).toBe(true)
    expect(isOn(LABEL.bookings)).toBe(false)
    expect(isOn(LABEL.msg_participants)).toBe(true)
    expect(isOn(LABEL.finance)).toBe(true)
    expect(isOn(LABEL.master)).toBe(true)
  })
})

describe('NotificationsView -- unsynced recipient / comms down', () => {
  it('shows defaults, DISABLES every switch, and says so', async () => {
    prefsGet.mockRejectedValue(new Error('404 recipient not synced'))
    mount()
    await flush()

    expect(toastError).toHaveBeenCalledWith('Не удалось загрузить настройки уведомлений')
    expect(isDisabled(LABEL.master)).toBe(true)
    expect(isDisabled(LABEL.reminders)).toBe(true)
    expect(isDisabled(LABEL.bookings)).toBe(true)
    expect(isDisabled(LABEL.msg_participants)).toBe(true)
    expect(isDisabled(LABEL.finance)).toBe(true)
  })

  it('never attempts a save while the load has failed', async () => {
    prefsGet.mockRejectedValue(new Error('502'))
    mount()
    await flush()

    // VSwitch's own guard returns before emitting when disabled, so this click
    // must not reach the view at all -- nothing is written anywhere.
    switchByLabel(LABEL.reminders).click()
    switchByLabel(LABEL.master).click()
    await flush()

    expect(prefsPut).not.toHaveBeenCalled()
  })

  it('disables only the rows comms did not report', async () => {
    // A category the profile stopped declaring: we cannot honestly control it,
    // so its row is disabled rather than shown as a working switch.
    const partial = prefs()
    delete (partial.categories as Record<string, boolean>).finance
    prefsGet.mockResolvedValue(partial)
    mount()
    await flush()

    expect(isDisabled(LABEL.finance)).toBe(true)
    expect(isDisabled(LABEL.reminders)).toBe(false)

    switchByLabel(LABEL.master).click()
    await flush()
    // Silence-everything skips it too -- writing an undeclared category is a
    // 422 from comms, and claiming to mute it would be a lie.
    expect(Object.keys(lastPutBody().categories)).toEqual([
      'reminders',
      'bookings',
      'msg_participants',
    ])
  })
})
