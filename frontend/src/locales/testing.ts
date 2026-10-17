// =============================================================================
// VELO Frontend -- i18n test helper (tz-i18n 0.4)
// =============================================================================
//
// A FRESH instance per mounting test app: tests must not share locale state
// through a module singleton (a test that switches the locale would leak
// into the next file in the same worker).
//
// locale 'ru' + the verbatim catalog, so existing text assertions keep
// passing untouched (tz-i18n §4.5). Warnings off: a missing key must not
// flood test output -- the CI key audit (tz-i18n §4.4) is the guard, not
// console noise.
//
// Wiring: @vue/test-utils mounts get it via config.global.plugins
// (test-setup.ts). Raw `createApp(...)` test mounts (120 files) take
// app.use(createTestI18n()) -- the codemod lands at the START of phase 2,
// before the first shared component migrates to useI18n.
// =============================================================================

import { createI18n } from 'vue-i18n'

import { cldrPluralChoice, ru } from './index'

export function createTestI18n() {
  const instance = createI18n({
    legacy: false,
    locale: 'ru',
    fallbackLocale: 'ru',
    pluralRules: { ru: cldrPluralChoice('ru') },
    globalInjection: true,
    missingWarn: false,
    fallbackWarn: false,
  })
  instance.global.setLocaleMessage('ru', ru)
  return instance
}
