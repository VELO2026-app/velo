// =============================================================================
// VELO Frontend -- SupportMessageBubble Tests (FE-100, BE-166)
// =============================================================================
//
// The whole state grid of one admin-feed message: who wrote it (the person or
// support) x its translation state (comms' closed set of five, or no block) x
// `retryable`. What is shown, which mark, which buttons; the original only on
// demand. The card's part (which thread a retry hits, the poll) is in
// AdminSupportDetailView.test.ts.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import SupportMessageBubble from '@/components/admin/SupportMessageBubble.vue'
import type { SupportMessage, SupportTranslationState } from '@/api/support'

let app: App | null = null
let host: HTMLElement | null = null
let emitted: string[] = []

function msg(
  state: SupportTranslationState | null,
  retryable = false,
  overrides: Partial<SupportMessage> = {},
): SupportMessage {
  return {
    id: 'm_1',
    thread_id: 't_1',
    sender: 'u_1',
    created_at: '2026-10-25T10:00:00Z',
    body: 'Привет',
    original: 'Hello',
    translation: state === null ? null : { locale: 'ru', state, source_locale: 'en', retryable },
    ...overrides,
  }
}

const showOriginal = ref(false)

async function mount(
  message: SupportMessage,
  opts: { fromPerson?: boolean; mine?: boolean; retrying?: boolean } = {},
): Promise<HTMLElement> {
  emitted = []
  showOriginal.value = false
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(SupportMessageBubble, {
        message,
        fromPerson: opts.fromPerson ?? true,
        mine: opts.mine ?? false,
        showOriginal: showOriginal.value,
        retrying: opts.retrying ?? false,
        time: '10:00',
        onToggle: () => {
          emitted.push('toggle')
          showOriginal.value = !showOriginal.value
        },
        onRetry: () => emitted.push('retry'),
      }),
  }).use(createTestI18n())
  app.mount(host)
  await nextTick()
  return host
}

function body(): string | undefined {
  return host?.querySelector('.bubble__body')?.textContent ?? undefined
}
function mark(): string | null {
  return host?.querySelector('.bubble__mark')?.textContent?.trim() ?? null
}
function link(text: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.bubble__link') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
}
function links(): string[] {
  return Array.from(host?.querySelectorAll('.bubble__link') ?? []).map(
    (b) => b.textContent?.trim() ?? '',
  )
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('SupportMessageBubble -- the person\u2019s message', () => {
  it('ready: the translation is shown; the original ONLY after «Показать оригинал»', async () => {
    await mount(msg('ready'))

    expect(body()).toBe('Привет')
    expect(host?.textContent).not.toContain('Hello')
    expect(mark()).toBeNull()

    link('Показать оригинал')?.click()
    await nextTick()

    expect(emitted).toEqual(['toggle'])
    expect(body()).toBe('Hello')
    expect(link('Показать перевод')).toBeDefined()

    link('Показать перевод')?.click()
    await nextTick()
    expect(body()).toBe('Привет')
  })

  it.each(['preparing', 'not_requested'] as const)(
    '%s: «Переводится…», the body as is, no toggle',
    async (state) => {
      await mount(msg(state, false, { body: 'Hello' }))

      expect(mark()).toBe('Переводится…')
      expect(body()).toBe('Hello')
      expect(links()).toEqual([])
    },
  )

  it('impossible, retryable: «Ошибка перевода» and «Повторить»', async () => {
    await mount(msg('impossible', true, { body: 'Hello' }))

    expect(mark()).toBe('Ошибка перевода')
    expect(links()).toEqual(['Повторить'])
    link('Повторить')?.click()
    expect(emitted).toEqual(['retry'])
  })

  it('impossible, NOT retryable (declined by the model): the mark, no «Повторить»', async () => {
    await mount(msg('impossible', false, { body: 'Hello' }))

    expect(mark()).toBe('Ошибка перевода')
    expect(links()).toEqual([])
  })

  it.each([['not_needed'], [null]] as const)('%s: nothing but the text', async (state) => {
    await mount(msg(state, false, { body: 'Привет', original: 'Привет' }))

    expect(body()).toBe('Привет')
    expect(mark()).toBeNull()
    expect(links()).toEqual([])
  })
})

describe('SupportMessageBubble -- a reply of support', () => {
  const reply = { fromPerson: false }

  it('ready: the reply as written, no mark, no «Показать оригинал»', async () => {
    await mount(msg('ready', false, { body: 'Здравствуйте', original: 'Здравствуйте' }), reply)

    expect(body()).toBe('Здравствуйте')
    expect(mark()).toBeNull()
    expect(links()).toEqual([])
  })

  it.each(['preparing', 'not_requested'] as const)('%s: «Переводится…»', async (state) => {
    await mount(msg(state, false, { body: 'Здравствуйте' }), reply)

    expect(mark()).toBe('Переводится…')
  })

  it('impossible, retryable: «Не доставлено» and «Повторить»', async () => {
    await mount(msg('impossible', true, { body: 'Здравствуйте' }), reply)

    expect(mark()).toBe('Не доставлено')
    expect(links()).toEqual(['Повторить'])
  })

  it('impossible, not retryable: «Не доставлено», no button', async () => {
    await mount(msg('impossible', false, { body: 'Здравствуйте' }), reply)

    expect(mark()).toBe('Не доставлено')
    expect(links()).toEqual([])
  })

  it('no block (the person reads the support language): nothing', async () => {
    await mount(msg(null, false, { body: 'Здравствуйте' }), reply)

    expect(mark()).toBeNull()
    expect(links()).toEqual([])
  })

  it('«Не доставлено» on ANOTHER admin\u2019s reply too -- any admin may retry', async () => {
    await mount(msg('impossible', true, { sender: 'admin_2' }), { fromPerson: false, mine: false })

    expect(mark()).toBe('Не доставлено')
    expect(link('Повторить')).toBeDefined()
  })
})

describe('SupportMessageBubble -- layout and the in-flight retry', () => {
  it('mine -> right-aligned; another\u2019s -> left', async () => {
    await mount(msg(null), { mine: true })
    expect(host?.querySelector('.bubble-row')?.classList.contains('bubble-row--mine')).toBe(true)
    app?.unmount()
    host?.remove()

    await mount(msg(null), { mine: false })
    expect(host?.querySelector('.bubble-row')?.classList.contains('bubble-row--mine')).toBe(false)
  })

  it('while a retry is in flight «Повторить» is disabled', async () => {
    await mount(msg('impossible', true), { retrying: true })

    expect(link('Повторить')?.disabled).toBe(true)
  })
})
