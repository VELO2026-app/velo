// =============================================================================
// VELO Frontend -- chatRows.ts Unit Tests (FE-103 / BE-163 / BE-166)
// =============================================================================
//
// Pure derivations for one GET /api/v1/chats row. What is under test:
//   chatRowTime    -- today renders HH:MM, older renders DD.MM; the row's
//                     display time rides `last_message_at`, falling back to
//                     `created_at` (the thread-not-yet-written case).
//   chatRowPreview -- the newest-message line: plain bodies pass through,
//                     the BE-166 translation states become their wording
//                     («Переводится…» / «Перевод недоступен»), and a thread
//                     without messages previews as nothing.
// The t() wording comes from the locales module singleton (ru catalog).
// =============================================================================

import { describe, it, expect } from 'vitest'
import { chatRowPreview, chatRowTime } from '@/utils/chatRows'
import type { ChatThread } from '@/api/chats'

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 't-1',
    channel: 'support',
    created_at: '2026-02-03T10:30:00+00:00',
    last_message: null,
    ...overrides,
  }
}

describe('chatRowTime', () => {
  it('today renders HH:MM, device-local', () => {
    const now = new Date()
    const iso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).toISOString()
    expect(chatRowTime(thread({ last_message_at: iso }))).toMatch(/^\d{2}:\d{2}$/)
  })

  it('an older message renders DD.MM', () => {
    expect(chatRowTime(thread({ last_message_at: '2026-02-03T11:00:00Z' }))).toMatch(
      /^\d{2}\.\d{2}$/,
    )
  })

  it('without last_message_at the row time is the thread creation', () => {
    expect(chatRowTime(thread({ created_at: '2026-02-03T11:00:00Z' }))).toMatch(/^\d{2}\.\d{2}$/)
  })

  it('nothing usable renders as nothing (the row just hides the corner)', () => {
    expect(chatRowTime(thread({ created_at: '', last_message_at: null }))).toBe('')
    expect(chatRowTime(thread({ created_at: 'not a date', last_message_at: null }))).toBe('')
  })
})

describe('chatRowPreview', () => {
  it('a plain body passes through -- chat rows and own/same-language support messages', () => {
    expect(
      chatRowPreview(
        thread({
          last_message: {
            id: 'm1',
            sender: 'u',
            created_at: '2026-02-03T10:00:00Z',
            body: 'Здравствуйте!',
            translation: null,
          },
        }),
      ),
    ).toBe('Здравствуйте!')
  })

  it('body:null + translating renders «Переводится…»', () => {
    expect(
      chatRowPreview(
        thread({
          last_message: {
            id: 'm1',
            sender: 'a',
            created_at: '2026-02-03T10:00:00Z',
            body: null,
            translation: 'translating',
          },
        }),
      ),
    ).toBe('Переводится…')
  })

  it('body:null + unavailable renders «Перевод недоступен»', () => {
    expect(
      chatRowPreview(
        thread({
          last_message: {
            id: 'm1',
            sender: 'a',
            created_at: '2026-02-03T10:00:00Z',
            body: null,
            translation: 'unavailable',
          },
        }),
      ),
    ).toBe('Перевод недоступен')
  })

  it('a thread with no messages yet previews as nothing', () => {
    expect(chatRowPreview(thread())).toBe('')
  })
})
