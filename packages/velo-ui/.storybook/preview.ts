// =============================================================================
// @velo/ui -- Storybook preview (FE-116 skeleton, tz-ui-package.md §3.3)
// =============================================================================
// The витрина acts as the HOST for tokens: the package itself carries no
// theme values (принцип 2: токены не уезжают), so the showcase imports the
// GOLDEN variables.css from the application by a pinned relative path --
// exactly what the app's cascade hands the package in a golden build
// (variables.css -> @velo/ui css -> skin-tokens.css). A skinned showcase,
// if ever wanted, is a storybook build-time concern, never a package one.
//
// FE-118 (tz-ui-package.md §4 P3): the витрина is an i18n HOST too -- it
// injects a demo translator with the golden ru values of the kit registry
// (UI_I18N_KEYS), the same wiring app.ts does with the real composer. A
// registry key missing from the demo map renders its raw key in the story,
// which keeps the map and the registry from drifting apart.
// =============================================================================

import type { Preview } from '@storybook/vue3-vite'

import { configureUi } from '../src/i18n'

import '../../../frontend/src/styles/variables.css'

// Golden ru values of the kit registry (UI_I18N_KEYS), spelled out so the
// витрина needs no app import for the demo dictionary.
const DEMO_MESSAGES: Record<string, string> = {
  'ui.cancel': 'Отмена',
  'ui.close': 'Закрыть',
  'ui.collapse': 'Свернуть',
  'ui.confirm': 'Подтвердить',
  'ui.expand': 'Развернуть',
  'ui.menuAria': 'Меню',
  'ui.noData': 'Данных пока нет',
  'ui.weekdays': 'Дни недели',
  'ui.dayFull.mon': 'Понедельник',
  'ui.dayFull.tue': 'Вторник',
  'ui.dayFull.wed': 'Среда',
  'ui.dayFull.thu': 'Четверг',
  'ui.dayFull.fri': 'Пятница',
  'ui.dayFull.sat': 'Суббота',
  'ui.dayFull.sun': 'Воскресенье',
  'ui.dayShort.mon': 'ПН',
  'ui.dayShort.tue': 'ВТ',
  'ui.dayShort.wed': 'СР',
  'ui.dayShort.thu': 'ЧТ',
  'ui.dayShort.fri': 'ПТ',
  'ui.dayShort.sat': 'СБ',
  'ui.dayShort.sun': 'ВС',
}

configureUi({ t: (key) => DEMO_MESSAGES[key] ?? key })

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
}

export default preview
