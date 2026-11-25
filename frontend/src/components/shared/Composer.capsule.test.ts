// =============================================================================
// VELO Frontend -- Composer capsule band (FE-249)
// =============================================================================
// The single-line field is a capsule whose textarea fills the 44px band (the
// tap target). autogrow() decides capsule or card from the textarea's
// scrollHeight: a one-line band is 44px, a second line ~58px, and the cut
// sits between them. happy-dom has no layout, so the test gives the textarea
// a fixed scrollHeight; the pixel geometry itself is proven in the browser by
// the layout sweep (docs/agents/e2e.md, `small-target`).
//
// Mount pattern: createApp + happy-dom (see DiaryComposer.test.ts).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import Composer from './Composer.vue'

let app: App | null = null
let host: HTMLElement | null = null

/** Mount the composer, give its textarea a scrollHeight, and type one line. */
async function typeAtHeight(scrollHeight: number): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(Composer, {
    placeholder: 'Message',
    send: async () => ({ ok: true }),
  }).use(createTestI18n())
  app.mount(host)
  const el = host.querySelector('textarea')
  if (!el) throw new Error('textarea did not render')
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  el.value = 'a line'
  el.dispatchEvent(new Event('input'))
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('Composer capsule band (FE-249: the textarea is a 44px tap target)', () => {
  it('stays the capsule while the text fits the 44px band, with room to spare', async () => {
    await typeAtHeight(50)
    expect(host?.querySelector('.composer--single')).not.toBeNull()
  })

  it('gives way to the card once the text takes a second line', async () => {
    await typeAtHeight(58)
    expect(host?.querySelector('.composer--single')).toBeNull()
  })
})
