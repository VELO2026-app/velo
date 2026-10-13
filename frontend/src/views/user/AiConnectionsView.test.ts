// =============================================================================
// AiConnectionsView (BE-138) -- the token is shown once and kept nowhere
// =============================================================================
//
// The api module, router, toast and auth store are mocked; the UI kit is
// real. VModal / VConfirmDialog teleport to <body>, so dialog content is
// looked up in document.body, the page itself in the mount host.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AiConnectionsView from '@/views/user/AiConnectionsView.vue'
import * as mcpApi from '@/api/mcpTokens'
import { ApiResponseError } from '@/api/client'
import type { McpTokenItem } from '@/api/types'

vi.mock('@/api/mcpTokens')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { timezone: 'UTC' } }),
}))

const TOKEN = 'velo_pat_0123456789abcdef_' + 'S'.repeat(43)

function item(id: string, overrides: Partial<McpTokenItem> = {}): McpTokenItem {
  return {
    id,
    name: `token ${id}`,
    prefix: '0123456789abcdef',
    scopes: ['read', 'diary:write', 'bookings:write'],
    created_at: '2026-10-11T10:00:00Z',
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let writeText: ReturnType<typeof vi.fn>
let setItem: ReturnType<typeof vi.spyOn>

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AiConnectionsView)
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
  }
}

// The component's own memory. A closed dialog renders nothing, so the DOM
// cannot tell "dropped" from "still held in the ref"; the done-when is about
// the latter too. Read through the mounted instance's setupState (dev build,
// as under vitest) -- the VInput.test.ts precedent of reaching the instance --
// rather than a defineExpose added purely for the test.
function heldToken(): unknown {
  const inst = (app as unknown as { _instance?: { setupState: Record<string, unknown> } })._instance
  expect(inst, 'mounted instance').toBeTruthy()
  expect('createdToken' in inst!.setupState, 'createdToken binding').toBe(true)
  return inst!.setupState.createdToken
}

function el<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  return document.body.querySelector<T>(sel)
}

function bodyButton(label: string, within = '.v-modal__container'): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>(`${within} button`)).find(
    (b) => b.textContent?.includes(label),
  )
}

async function openAndFill(name: string): Promise<void> {
  el<HTMLButtonElement>('[data-test="open-create"]')!.click()
  await flush()
  const input = el<HTMLInputElement>('.v-modal__container input')!
  input.value = name
  input.dispatchEvent(new Event('input'))
  await flush()
}

beforeEach(() => {
  vi.mocked(mcpApi.listMcpTokens).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(mcpApi.createMcpToken).mockReset()
  vi.mocked(mcpApi.revokeMcpToken).mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: { writeText },
  })
  setItem = vi.spyOn(Storage.prototype, 'setItem')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  setItem.mockRestore()
  vi.clearAllMocks()
})

describe('AiConnectionsView', () => {
  describe('states', () => {
    it('lists the tokens: prefix shown, revoked ones without a revoke button', async () => {
      vi.mocked(mcpApi.listMcpTokens).mockResolvedValue({
        items: [item('a'), item('b', { revoked_at: '2026-10-11T11:00:00Z' })],
      })
      mount()
      await flush()
      const rows = host!.querySelectorAll('[data-test="token-row"]')
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain('velo_pat_0123456789abcdef…')
      expect(rows[0]!.textContent).toContain('ещё не использовался')
      expect(rows[0]!.querySelector('[data-test="revoke"]')).not.toBeNull()
      expect(rows[1]!.querySelector('[data-test="revoke"]')).toBeNull()
      expect(rows[1]!.textContent).toContain('Отозван')
    })

    it('says so when there are no tokens', async () => {
      mount()
      await flush()
      expect(host!.querySelector('[data-test="empty"]')).not.toBeNull()
    })

    it('a 404 (MCP switched off) is "unavailable", not an error, with no create button', async () => {
      vi.mocked(mcpApi.listMcpTokens).mockRejectedValue(
        new ApiResponseError(404, 'Not found', 'not_found'),
      )
      mount()
      await flush()
      expect(host!.querySelector('[data-test="unavailable"]')).not.toBeNull()
      expect(host!.querySelector('[data-test="open-create"]')).toBeNull()
    })

    it('any other failure is a load error', async () => {
      vi.mocked(mcpApi.listMcpTokens).mockRejectedValue(
        new ApiResponseError(500, 'boom', 'internal_error'),
      )
      mount()
      await flush()
      expect(host!.querySelector('[data-test="load-error"]')).not.toBeNull()
    })
  })

  describe('create', () => {
    it('shows the token once and keeps it nowhere after the dialog closes', async () => {
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      await openAndFill('  Claude дома  ')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()

      expect(mcpApi.createMcpToken).toHaveBeenCalledWith('Claude дома', [
        'read',
        'diary:write',
        'bookings:write',
      ])
      // Y is there: the token is on screen, selectable, with the warning.
      expect(heldToken()).toBe(TOKEN)
      const shown = el('[data-test="token-text"]')
      expect(shown?.textContent).toBe(TOKEN)
      expect(shown?.classList.contains('ai-conn__token')).toBe(true)
      expect(el('[data-test="token-once"]')!.textContent).toContain('больше мы его не покажем')
      // The new row joined the list -- by prefix, never the token.
      expect(host!.querySelectorAll('[data-test="token-row"]')).toHaveLength(1)
      expect(host!.textContent).not.toContain(TOKEN)

      el<HTMLButtonElement>('[data-test="done"]')!.click()
      await flush()
      // X is not: nowhere in the document, nothing written to web storage.
      expect(document.body.innerHTML).not.toContain(TOKEN)
      expect(heldToken()).toBeNull()
      for (const call of setItem.mock.calls) {
        expect(String(call[1])).not.toContain(TOKEN)
      }
      // Reopening starts a fresh form, not the old token.
      el<HTMLButtonElement>('[data-test="open-create"]')!.click()
      await flush()
      expect(el('[data-test="create-form"]')).not.toBeNull()
      expect(document.body.innerHTML).not.toContain(TOKEN)
    })

    it('the close cross also drops the token', async () => {
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      await openAndFill('x')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      expect(document.body.innerHTML).toContain(TOKEN)
      el<HTMLButtonElement>('.v-modal__close')!.click()
      await flush()
      expect(document.body.innerHTML).not.toContain(TOKEN)
      expect(heldToken()).toBeNull()
    })

    it('a tap on the overlay does not lose a shown token, but closes the form', async () => {
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      await openAndFill('x')
      el<HTMLElement>('.v-modal__overlay')!.click()
      await flush()
      expect(el('[data-test="create-form"]')).toBeNull()

      await openAndFill('x')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      el<HTMLElement>('.v-modal__overlay')!.click()
      await flush()
      expect(el('[data-test="token-text"]')?.textContent).toBe(TOKEN)
    })

    it('sends a chosen subset of scopes in canonical order; none chosen -> cannot create', async () => {
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      await openAndFill('subset')
      el<HTMLButtonElement>('[data-test="scope-diary:write"]')!.click()
      await flush()
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      expect(mcpApi.createMcpToken).toHaveBeenCalledWith('subset', ['read', 'bookings:write'])

      el<HTMLButtonElement>('[data-test="done"]')!.click()
      await flush()
      await openAndFill('none')
      for (const s of ['read', 'diary:write', 'bookings:write']) {
        el<HTMLButtonElement>(`[data-test="scope-${s}"]`)!.click()
        await flush()
      }
      expect(el<HTMLButtonElement>('[data-test="create"]')!.disabled).toBe(true)
    })

    it('a blank name cannot be submitted', async () => {
      mount()
      await flush()
      await openAndFill('   ')
      expect(el<HTMLButtonElement>('[data-test="create"]')!.disabled).toBe(true)
    })

    it('the limit refusal is shown in words and no token appears', async () => {
      vi.mocked(mcpApi.createMcpToken).mockRejectedValue(
        new ApiResponseError(409, 'Too many active tokens', 'mcp_token_limit_reached'),
      )
      mount()
      await flush()
      await openAndFill('eleventh')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Активных токенов уже 10'))
      expect(el('[data-test="token-once"]')).toBeNull()
    })
  })

  describe('typography (BE-139 item 11)', () => {
    // Every text a person reads on this screen, in every state: the product
    // dash «—», never the code/docs convention '--'. Pair: the dash IS there.
    function assertDashes(where: string): void {
      const text = document.body.textContent ?? ''
      expect(text, where).not.toMatch(/(^|[^-])--([^-]|$)/)
    }

    it('no "--" in the list, the form or the shown token; "—" present', async () => {
      vi.mocked(mcpApi.listMcpTokens).mockResolvedValue({ items: [item('a')] })
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      assertDashes('list')
      expect(host!.textContent).toContain('—')
      await openAndFill('x')
      assertDashes('form')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      assertDashes('token shown')
      expect(el('[data-test="token-once"]')!.textContent).toContain('—')
    })

    it('the copy refusal toast uses the dash', async () => {
      writeText.mockRejectedValue(new Error('NotAllowedError'))
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      await openAndFill('c')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      el<HTMLButtonElement>('[data-test="copy"]')!.click()
      await flush()
      const phrase = String(toastError.mock.calls[0]?.[0])
      expect(phrase).toContain('—')
      expect(phrase).not.toContain('--')
    })

    it('a taken name is refused in words (mcp_token_name_taken)', async () => {
      vi.mocked(mcpApi.createMcpToken).mockRejectedValue(
        new ApiResponseError(409, 'taken', 'mcp_token_name_taken'),
      )
      mount()
      await flush()
      await openAndFill('TEST')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('Токен с таким названием уже есть'),
      )
      expect(el('[data-test="token-once"]')).toBeNull()
    })
  })

  describe('copy', () => {
    async function created(): Promise<void> {
      vi.mocked(mcpApi.createMcpToken).mockResolvedValue({ token: TOKEN, item: item('n') })
      mount()
      await flush()
      await openAndFill('c')
      el<HTMLButtonElement>('[data-test="create"]')!.click()
      await flush()
    }

    it('copies the token on the tap', async () => {
      await created()
      el<HTMLButtonElement>('[data-test="copy"]')!.click()
      await flush()
      expect(writeText).toHaveBeenCalledWith(TOKEN)
      expect(toastSuccess).toHaveBeenCalled()
    })

    it('a refused clipboard says so and leaves the token on screen to copy by hand', async () => {
      writeText.mockRejectedValue(new Error('NotAllowedError'))
      await created()
      el<HTMLButtonElement>('[data-test="copy"]')!.click()
      await flush()
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('вручную'))
      expect(el('[data-test="token-text"]')?.textContent).toBe(TOKEN)
    })
  })

  describe('revoke', () => {
    it('asks first, then marks the row revoked', async () => {
      vi.mocked(mcpApi.listMcpTokens).mockResolvedValue({ items: [item('a')] })
      vi.mocked(mcpApi.revokeMcpToken).mockResolvedValue(
        item('a', { revoked_at: '2026-10-11T12:00:00Z' }),
      )
      mount()
      await flush()
      host!.querySelector<HTMLButtonElement>('[data-test="revoke"]')!.click()
      await flush()
      expect(mcpApi.revokeMcpToken).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('сразу потеряет доступ')

      bodyButton('Отозвать')!.click()
      await flush()
      expect(mcpApi.revokeMcpToken).toHaveBeenCalledWith('a')
      const row = host!.querySelector('[data-test="token-row"]')!
      expect(row.textContent).toContain('Отозван')
      expect(row.querySelector('[data-test="revoke"]')).toBeNull()
    })

    it('cancel revokes nothing', async () => {
      vi.mocked(mcpApi.listMcpTokens).mockResolvedValue({ items: [item('a')] })
      mount()
      await flush()
      host!.querySelector<HTMLButtonElement>('[data-test="revoke"]')!.click()
      await flush()
      bodyButton('Отмена')!.click()
      await flush()
      expect(mcpApi.revokeMcpToken).not.toHaveBeenCalled()
      expect(host!.querySelector('[data-test="revoke"]')).not.toBeNull()
    })
  })
})
