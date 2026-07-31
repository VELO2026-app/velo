// =============================================================================
// VELO Frontend -- VEmptyState Slot Contract Tests (T8, PROMPT №433)
// =============================================================================
//
// Written alongside the fix for the defect found in PROMPT №432: VEmptyState
// rendered only `icon` and the DEFAULT slot, but 11 views passed their retry
// button as `<template #action>`. Vue drops an unmatched named slot SILENTLY --
// no warning, no error, no button -- so all eleven rendered an error state with
// nothing to click and no way out but to leave the screen.
//
// This file exists because that failure mode is INVISIBLE. It produces no
// console noise and no exception; the only symptom is a button that is not
// there. It cannot be caught by reading the call site (which looks correct) --
// only by asserting the contract here or by rendering the screen.
//
// It guards all 35 action sites at once, which matters because 9 of the 11
// repaired views have NO tests of their own: AdminCatalog, AdminMasters,
// AdminMethodRequests, AdminParticipants, AdminReports, AdminUsers, DetailView,
// DiaryFeedView, EntryView. (AdminWithdrawals + AdminPromos have their own
// regression guards in their view tests.) If `action` is ever dropped again,
// those nine break silently and this file is what says so.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1 -- the
// repo has no @vue/test-utils usage.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, nextTick, h, type App, type Slots } from 'vue'
import VEmptyState from '@/components/ui/VEmptyState.vue'

let app: App | null = null
let host: HTMLElement | null = null

/** VEmptyState's own props (VEmptyState.vue:53-67). */
interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  variant?: 'full' | 'note'
}

async function render(
  props: EmptyStateProps,
  slots: Record<string, () => unknown> = {},
): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () => h(VEmptyState, props, slots as unknown as Slots),
  })
  app.mount(host)
  await nextTick()
  return host
}

function action(): Element | null {
  return host?.querySelector('.v-empty__action') ?? null
}

function text(): string {
  return host?.textContent ?? ''
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VEmptyState', () => {
  describe('the action slot (the PROMPT №432 defect)', () => {
    it('renders a button passed as #action', async () => {
      // THE regression guard. This is the spelling 11 views were already written
      // against and which silently rendered nothing.
      await render({ icon: 'warning', title: 'Ошибка' }, { action: () => h('button', 'Повторить') })

      expect(action()).not.toBeNull()
      expect(text()).toContain('Повторить')
    })

    it('still renders a button passed in the DEFAULT slot', async () => {
      // 24 sites use this spelling and always worked. The fix must not trade one
      // broken spelling for another -- both render into .v-empty__action.
      await render(
        { icon: 'warning', title: 'Ошибка' },
        { default: () => h('button', 'Повторить') },
      )

      expect(action()).not.toBeNull()
      expect(text()).toContain('Повторить')
    })

    it('renders NO action wrapper when neither slot is passed', async () => {
      // 18 sites are bare. An empty .v-empty__action would add dead margin
      // (VEmptyState.vue: margin-top on the wrapper) under every plain empty state.
      await render({ icon: 'list', title: 'Пусто' })

      expect(action()).toBeNull()
    })

    it('renders BOTH slots when a caller passes both', async () => {
      // Not a pattern anyone should use, but the guard must not silently swallow
      // one of them the way the original swallowed #action.
      await render(
        { icon: 'warning', title: 'Ошибка' },
        { action: () => h('button', 'Повторить'), default: () => h('button', 'Назад') },
      )

      expect(text()).toContain('Повторить')
      expect(text()).toContain('Назад')
    })
  })

  describe('the rest of the contract (unchanged by the fix)', () => {
    it('renders the title and description', async () => {
      await render({ icon: 'warning', title: 'Ошибка', description: 'Проверьте соединение' })

      expect(text()).toContain('Ошибка')
      expect(text()).toContain('Проверьте соединение')
    })

    it('omits the description element entirely when there is none', async () => {
      await render({ icon: 'warning', title: 'Ошибка' })

      expect(host?.querySelector('.v-empty__desc')).toBeNull()
    })

    it('resolves the semantic icon key to a glyph', async () => {
      // The `icon` prop is a KEY, not an emoji (VEmptyState.vue:6-7).
      await render({ icon: 'warning', title: 'Ошибка' })

      expect(host?.querySelector('.v-empty__icon svg')).not.toBeNull()
    })

    it('an unknown icon key renders no glyph rather than throwing', async () => {
      await render({ icon: 'no-such-key', title: 'Ошибка' })

      expect(host?.querySelector('.v-empty__icon svg')).toBeNull()
      expect(text()).toContain('Ошибка')
    })

    it('a custom #icon slot overrides the key', async () => {
      await render({ icon: 'warning', title: 'Ошибка' }, { icon: () => h('i', 'CUSTOM') })

      expect(text()).toContain('CUSTOM')
      expect(host?.querySelector('.v-empty__icon svg')).toBeNull()
    })
  })

  describe('the note variant (must not regress -- it owns the default slot)', () => {
    it('renders its message from the title', async () => {
      await render({ variant: 'note', title: 'Данных пока нет' })

      expect(host?.querySelector('.v-empty-note')?.textContent).toContain('Данных пока нет')
    })

    it('renders its message from the DEFAULT slot when given one', async () => {
      // This is WHY the default slot cannot simply be removed in favour of
      // `action`: for `note` the default slot is the MESSAGE, not an action
      // (VEmptyState.vue:19-22,27).
      await render({ variant: 'note', title: 'fallback' }, { default: () => h('span', 'Из слота') })

      expect(host?.querySelector('.v-empty-note')?.textContent).toContain('Из слота')
      expect(text()).not.toContain('fallback')
    })

    it('has no icon, no title element and no action wrapper', async () => {
      await render(
        { variant: 'note', title: 'Данных пока нет' },
        { action: () => h('button', 'X') },
      )

      expect(host?.querySelector('.v-empty__icon')).toBeNull()
      expect(host?.querySelector('.v-empty__title')).toBeNull()
      expect(action()).toBeNull()
      expect(text()).not.toContain('X')
    })
  })
})
