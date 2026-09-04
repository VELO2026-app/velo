// =============================================================================
// VELO Frontend -- CuratorGroupInviteSheet Tests (schools FE-20 / GT P3)
// =============================================================================
//
// The link sheet's contract: mint on open (same url back on repeat), the B2
// clipboard copy, the CONFIRMED revoke, and -- the one honest-failure case
// that matters -- 503 bot_url_not_configured showing the errorMessages
// phrase with NO fabricated link. happy-dom has no navigator.clipboard, so
// it is stubbed (same as MasterPracticeDetailView.test.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CuratorGroupInviteSheet from '@/components/shared/CuratorGroupInviteSheet.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/curatorGroups')

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

const writeText = vi.fn()

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: { kind?: 'master' | 'student' }): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CuratorGroupInviteSheet, {
    open: true,
    kind: props.kind ?? 'master',
    groupId: 'g1',
  })
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  vi.mocked(cgApi.createCuratorGroupInvite).mockReset()
  vi.mocked(cgApi.revokeCuratorGroupInvite).mockReset()
  writeText.mockReset().mockResolvedValue(undefined)
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CuratorGroupInviteSheet', () => {
  it('mints on open, with the right group and kind', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({
      kind: 'master',
      invite_url: 'https://t.me/bot?startapp=curator_group_invite__tok',
    })
    mount({ kind: 'master' })
    await flush()

    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1', 'master')
    expect(bodyText()).toContain('https://t.me/bot?startapp=curator_group_invite__tok')
    expect(bodyText()).toContain('Ссылка для мастеров')
  })

  it('copy: B2 clipboard + toast', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({
      kind: 'student',
      invite_url: 'https://t.me/bot?startapp=curator_group_invite__tok2',
    })
    mount({ kind: 'student' })
    await flush()

    buttonWith('Скопировать')?.click()
    await flush()

    expect(writeText).toHaveBeenCalledWith('https://t.me/bot?startapp=curator_group_invite__tok2')
    expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
  })

  it('503 bot_url_not_configured: the table phrase, and NO link on screen', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockRejectedValue(
      new ApiResponseError(503, 'no url', 'bot_url_not_configured'),
    )
    mount({ kind: 'master' })
    await flush()

    expect(toastError).toHaveBeenCalledWith(
      'Ссылки для приглашений временно недоступны. Сообщите в поддержку.',
    )
    expect(bodyText()).not.toContain('https://')
    expect(bodyText()).toContain('Не удалось получить ссылку')
  })

  it('revoke: confirm first, then DELETE the right kind and close', async () => {
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({
      kind: 'master',
      invite_url: 'https://t.me/bot?startapp=curator_group_invite__tok',
    })
    vi.mocked(cgApi.revokeCuratorGroupInvite).mockResolvedValue(undefined)
    mount({ kind: 'master' })
    await flush()

    // The revoke confirm itself (danger, must not fire on the first tap).
    buttonWith('Отозвать ссылку')?.click()
    await flush()
    expect(cgApi.revokeCuratorGroupInvite).not.toHaveBeenCalled()
    expect(bodyText()).toContain('Прежняя ссылка перестанет работать')

    buttonWith('Отозвать')?.click()
    await flush()
    expect(cgApi.revokeCuratorGroupInvite).toHaveBeenCalledWith('g1', 'master')
    expect(toastSuccess).toHaveBeenCalledWith('Ссылка отозвана')
  })
})
