// =============================================================================
// VELO Frontend -- SchoolInviteField Tests (tz-curator.md §1.6, owner 2026-09-22)
// =============================================================================
//
// The field's contract (owner 2026-10-01, fifth iteration: the diary's
// DiaryBubbleShape bead, side="right", PRIMARY lobe -- ONE chip, ONE
// button): mint on mount (get-or-mint -- repeat calls return the SAME
// url), the B2 clipboard copy off the single «Ссылка-приглашение» chip,
// the lazy mint that never refuses a tap, and the one honest-failure case
// that matters -- no fabricated url ever leaves this component. The raw
// url is NOT displayed (owner 2026-09-22: the field IS the interface).
// Rotation has no seat in this form (owner 2026-10-01, 1:1 with the
// mock): the retry path asserts it stays that way -- a retry mints, it
// never revokes.
// happy-dom ships no navigator.clipboard, so it is stubbed (B2 pattern).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SchoolInviteField from '@/components/shared/SchoolInviteField.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/curatorGroups')

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

// happy-dom ships no navigator.clipboard -- stub it (B2 pattern).
const writeText = vi.fn()

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SchoolInviteField, { groupId: 'g1' })
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function copyChip(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.trim().startsWith('Ссылка-приглашение'),
  )
}

const URL_V1 = 'https://t.me/velopractice_bot?start=curator_group_invite__token-one-long'

beforeEach(() => {
  vi.mocked(cgApi.createCuratorGroupInvite).mockReset()
  vi.mocked(cgApi.revokeCuratorGroupInvite).mockReset()
  writeText.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('SchoolInviteField', () => {
  it('mints on mount (get-or-mint); the chip is enabled once a link exists', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({ invite_url: URL_V1 })
    mount()
    await flush()

    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1')
    expect(copyChip()).toBeTruthy()
    expect(copyChip()?.disabled).toBe(false)
    // No input anywhere: the url itself is never displayed, the field IS
    // the interface.
    expect(document.body.querySelector('input')).toBeNull()
  })

  it('the chip writes the url to the clipboard and toasts (B2)', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({ invite_url: URL_V1 })
    writeText.mockResolvedValue(undefined)
    mount()
    await flush()

    copyChip()?.click()
    await flush()

    expect(writeText).toHaveBeenCalledWith(URL_V1)
    expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
  })

  it('without a link a tap lazy-mints and honestly toasts on failure', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockRejectedValue(
      new ApiResponseError(503, 'bot_url_not_configured', 'not configured'),
    )
    mount()
    await flush()

    // The chip never goes dead-disabled: the tap itself re-mints, the
    // failure is the toast.
    expect(copyChip()?.disabled).toBe(false)
    copyChip()?.click()
    await flush()

    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1')
    expect(toastError).toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('a tap without a link lazy-mints, then copies in the same motion', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite)
      .mockRejectedValueOnce(new ApiResponseError(500, 'boom', 'internal'))
      .mockResolvedValueOnce({ invite_url: URL_V1 })
    writeText.mockResolvedValue(undefined)
    mount()
    await flush()

    copyChip()?.click()
    await flush()
    expect(toastError).toHaveBeenCalled()

    copyChip()?.click()
    await flush()

    // The retry re-mints but NEVER revokes -- rotation has no seat in this
    // form; a retry is always just a mint.
    expect(cgApi.revokeCuratorGroupInvite).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(URL_V1)
    expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
  })
})
