// =============================================================================
// VELO Frontend -- PracticeListCard title heading level (FE-246)
// =============================================================================
//
// The card title is a heading. Its level follows the page: h3 under a section
// heading (h2), h2 when the card list sits right under the page title (h1), so
// the levels never skip (WCAG 1.3.1; axe `heading-order`, e2e/a11y).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'

let app: App | null = null
let host: HTMLElement | null = null

async function mountCard(headingLevel?: 2 | 3): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(PracticeListCard, {
          practice: { title: 'Morning flow', direction: 'yoga', master_name: 'Anna' },
          when: '12 Nov',
          ...(headingLevel === undefined ? {} : { headingLevel }),
        })
    },
  })
  app = createApp(Wrapper).use(createTestI18n())
  app.mount(host)
  await nextTick()
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('PracticeListCard -- title heading level (FE-246)', () => {
  it('without headingLevel the title is an h3: the card sits under a section heading', async () => {
    const root = await mountCard()

    const title = root.querySelector('.practice-list-card__title')
    expect(title?.tagName).toBe('H3')
    expect(title?.textContent?.trim()).toBe('Morning flow')
  })

  it('headingLevel 2 makes the title an h2: the card follows the page title directly', async () => {
    const root = await mountCard(2)

    expect(root.querySelector('.practice-list-card__title')?.tagName).toBe('H2')
  })
})
