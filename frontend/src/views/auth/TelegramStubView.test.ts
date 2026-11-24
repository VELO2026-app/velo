// =============================================================================
// VELO Frontend -- TelegramStubView: the bot hint names the brand
// =============================================================================
// The hint (i18n:auth.stub.hint) quotes the bot's menu button, whose label
// carries the brand word. The catalogs once wrote the link as `@:{brand}`
// -- a placeholder the view never passes -- so the quoted label rendered
// with the brand missing.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TelegramStubView from '@/views/auth/TelegramStubView.vue'
import i18n, { setLocale } from '@/locales'
import { SKIN_BRAND } from 'virtual:skin-brand'

afterEach(async () => {
  await setLocale('ru')
})

describe('TelegramStubView', () => {
  it.each(['ru', 'en', 'uk'])(
    'the %s hint quotes the button label with the brand',
    async (locale) => {
      await setLocale(locale)
      const hint = mount(TelegramStubView).find('.stub__hint').text()
      expect(hint).toContain(SKIN_BRAND)
      expect(i18n.global.locale.value).toBe(locale)
    },
  )

  it('the closing quote survives right after the brand', () => {
    const hint = mount(TelegramStubView).find('.stub__hint').text()
    expect(hint).toContain(`${SKIN_BRAND}\u00bb`)
  })
})
