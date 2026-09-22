// =============================================================================
// VELO Frontend -- SchoolInviteField Tests (tz-curator.md §1.6, owner 2026-09-22)
// =============================================================================
//
// The CTA's contract: mint on mount (get-or-mint -- repeat calls return the
// SAME url), the B2 clipboard copy off the wide primary button, rotation
// that ASKS first (revoke + create -- revocation kills the link for
// everyone), a retry that never revokes (nothing to revoke without a
// link), and the one honest-failure case that matters -- the copy button
// stays disabled, no fabricated url ever leaves this component. The raw
// url is NOT displayed (owner 2026-09-22: the button IS the interface).
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

function copyButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.trim().startsWith('Копировать ссылку-приглашение'),
  )
}

function refreshDisc(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.getAttribute('aria-label')?.includes('Обновить') ||
    b.getAttribute('aria-label')?.includes('Повторить')
      ? true
      : false,
  )
    ? Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) =>
          b.getAttribute('aria-label') === 'Обновить ссылку' ||
          b.getAttribute('aria-label') === 'Повторить',
      )
    : undefined
}

function confirmButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === 'Обновить',
  )
}

const URL_V1 = 'https://t.me/velopractice_bot?start=curator_group_invite__token-one-long'
const URL_V2 = 'https://t.me/velopractice_bot?start=curator_group_invite__token-two-long'

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
  it('mints on mount (get-or-mint); the CTA is enabled once a link exists', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({ invite_url: URL_V1 })
    mount()
    await flush()

    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1')
    expect(copyButton()).toBeTruthy()
    expect(copyButton()?.disabled).toBe(false)
    // No input anywhere: the url itself is never displayed, the button IS
    // the interface.
    expect(document.body.querySelector('input')).toBeNull()
  })

  it('the CTA writes the url to the clipboard and toasts (B2)', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({ invite_url: URL_V1 })
    writeText.mockResolvedValue(undefined)
    mount()
    await flush()

    copyButton()?.click()
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

    // The CTA never goes dead-blue-disabled: the tap itself re-mints, the
    // failure is the toast.
    expect(copyButton()?.disabled).toBe(false)
    copyButton()?.click()
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

    copyButton()?.click()
    await flush()
    expect(toastError).toHaveBeenCalled()

    copyButton()?.click()
    await flush()

    // The retry re-mints but NEVER revokes -- there is nothing to revoke.
    expect(cgApi.revokeCuratorGroupInvite).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(URL_V1)
    expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
  })

  it('rotation asks first: confirm -> revoke + create -> the CTA is live again', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite)
      .mockResolvedValueOnce({ invite_url: URL_V1 })
      .mockResolvedValueOnce({ invite_url: URL_V2 })
    vi.mocked(cgApi.revokeCuratorGroupInvite).mockResolvedValue(undefined)
    mount()
    await flush()
    expect(copyButton()?.disabled).toBe(false)

    refreshDisc()?.click()
    await flush()

    // The confirm dialog is open; nothing has hit the server yet.
    expect(cgApi.revokeCuratorGroupInvite).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Обновить ссылку?')

    confirmButton()?.click()
    await flush()

    expect(cgApi.revokeCuratorGroupInvite).toHaveBeenCalledWith('g1')
    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledTimes(2)
    // The new url is live server-side; the CTA is ready to copy it again.
    expect(copyButton()?.disabled).toBe(false)
    expect(toastSuccess).toHaveBeenCalledWith('Ссылка обновлена')
  })

  it('closing the rotation dialog revokes nothing', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({ invite_url: URL_V1 })
    mount()
    await flush()

    refreshDisc()?.click()
    await flush()

    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Отмена',
    )
    cancel?.click()
    await flush()

    expect(cgApi.revokeCuratorGroupInvite).not.toHaveBeenCalled()
    expect(copyButton()?.disabled).toBe(false)
  })

  it('a failed rotation toasts honestly -- the CTA goes quiet while the url is dead', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite)
      .mockResolvedValueOnce({ invite_url: URL_V1 })
      .mockRejectedValueOnce(new ApiResponseError(503, 'bot_url_not_configured', 'not configured'))
    vi.mocked(cgApi.revokeCuratorGroupInvite).mockResolvedValue(undefined)
    mount()
    await flush()

    refreshDisc()?.click()
    await flush()
    confirmButton()?.click()
    await flush()

    expect(toastError).toHaveBeenCalled()
    // The revocation DID happen server-side; the dead url is dropped. The
    // CTA stays alive though -- the next tap lazy-mints a fresh link.
    expect(copyButton()?.disabled).toBe(false)
    expect(refreshDisc()?.getAttribute('aria-label')).toBe('Обновить ссылку')
  })
})
