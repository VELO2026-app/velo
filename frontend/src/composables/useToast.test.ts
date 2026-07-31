// =============================================================================
// VELO Frontend -- useToast Composable Unit Tests (PROMPT №500)
// =============================================================================
//
// Every other test file in the repo mocks this module entirely
// (`vi.mock('@/composables/useToast', ...)`), so the real _push() eviction
// cap, the real auto-dismiss timer, and the real dismiss() had never
// executed under test -- 88 toast.error() call sites relying on logic no
// test ever ran. This file drives the REAL module.
//
// Module-level singleton state (_toasts) persists across tests in the same
// file; dismiss() every leftover toast in afterEach so tests don't leak into
// each other (useToast.ts exports no reset helper, unlike api/client.ts's
// resetClientState()).
// =============================================================================

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useToast } from '@/composables/useToast'

const TOAST_DURATION_MS = 3000

afterEach(() => {
  const { toasts, dismiss } = useToast()
  for (const t of [...toasts.value]) dismiss(t.id)
  vi.useRealTimers()
})

describe('useToast', () => {
  describe('eviction cap (MAX_TOASTS = 3)', () => {
    it('a fourth toast evicts the oldest, keeping the three most recent', () => {
      const toast = useToast()
      toast.info('one')
      toast.info('two')
      toast.info('three')
      toast.info('four')

      const messages = toast.toasts.value.map((t) => t.message)
      expect(messages).toEqual(['two', 'three', 'four'])
      expect(toast.toasts.value.length).toBe(3)
    })

    it('a third toast does NOT evict anything (cap is exclusive at 3)', () => {
      const toast = useToast()
      toast.info('one')
      toast.info('two')
      toast.info('three')

      expect(toast.toasts.value.map((t) => t.message)).toEqual(['one', 'two', 'three'])
    })
  })

  describe('auto-dismiss timer', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('a toast clears itself after TOAST_DURATION_MS', () => {
      const toast = useToast()
      toast.error('will vanish')
      expect(toast.toasts.value.length).toBe(1)

      vi.advanceTimersByTime(TOAST_DURATION_MS)

      expect(toast.toasts.value.length).toBe(0)
    })

    it('does NOT clear before the interval elapses', () => {
      const toast = useToast()
      toast.error('not yet')

      vi.advanceTimersByTime(TOAST_DURATION_MS - 1)

      expect(toast.toasts.value.length).toBe(1)
    })

    it('each toast dismisses independently on its own timer, not as a batch', () => {
      const toast = useToast()
      toast.info('first')
      vi.advanceTimersByTime(1500)
      toast.info('second') // pushed 1500ms after the first

      // First toast's 3000ms elapses; second's has only had 1500ms.
      vi.advanceTimersByTime(1500)
      expect(toast.toasts.value.map((t) => t.message)).toEqual(['second'])

      vi.advanceTimersByTime(1500)
      expect(toast.toasts.value.length).toBe(0)
    })
  })

  describe('dismiss()', () => {
    it('removes exactly the toast with the given id, leaving the others', () => {
      const toast = useToast()
      toast.info('keep-1')
      toast.error('remove-me')
      toast.info('keep-2')

      const target = toast.toasts.value.find((t) => t.message === 'remove-me')!
      toast.dismiss(target.id)

      expect(toast.toasts.value.map((t) => t.message)).toEqual(['keep-1', 'keep-2'])
    })

    it('dismissing a non-existent id is a silent no-op', () => {
      const toast = useToast()
      toast.info('stays')

      expect(() => toast.dismiss(999999)).not.toThrow()
      expect(toast.toasts.value.map((t) => t.message)).toEqual(['stays'])
    })
  })

  describe('variant tagging', () => {
    it('success/error/info each set the corresponding variant field', () => {
      const toast = useToast()
      toast.success('ok')
      toast.error('bad')
      toast.info('fyi')

      const variants = toast.toasts.value.map((t) => t.variant)
      expect(variants).toEqual(['success', 'error', 'info'])
    })
  })
})
