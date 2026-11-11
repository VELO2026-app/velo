// =============================================================================
// @velo/ui -- Storybook preview (FE-116 skeleton, tz-ui-package.md §3.3)
// =============================================================================
// The витрина acts as the HOST for tokens: the package itself carries no
// theme values (принцип 2: токены не уезжают), so the showcase imports the
// GOLDEN variables.css from the application by a pinned relative path --
// exactly what the app's cascade hands the package in a golden build
// (variables.css -> @velo/ui css -> skin-tokens.css). A skinned showcase
// stays a storybook build-time concern, never a package one -- §3.7 made
// it a MANDATED one: the skin switcher below is that build-time concern.
//
// FE-118 (tz-ui-package.md §4 P3): the витрина is an i18n HOST too -- it
// injects a demo translator with the golden ru values of the kit registry
// (UI_I18N_KEYS), the same wiring app.ts does with the real composer. A
// registry key missing from the demo map renders its raw key in the story,
// which keeps the map and the registry from drifting apart.
//
// SKIN MODE (tz-ui-package.md §3.7, шаг 1 витрины): a toolbar "Skin" select
// injects an etalon skin's token layer as ONE override appended after
// the golden base -- the same cascade shape the app builds in main.ts
// (variables.css -> kit css -> skin-tokens.css). The kit components consume
// var(--velo-*) only, so the switch repaints every story with no component
// change: значения = данные. Golden removes the layer entirely (the base IS
// golden). The layers come from the virtual module of main.ts, which
// converts the DTCG packages listed in VELO_SKINS (velo carries no skins --
// partner brands live in their own repositories) with the app's
// own skin engine (FE-131) -- a new skin package joins with no edit here;
// showcase tooling, not package code (the boundary law governs src/**,
// nothing here ships).
// =============================================================================

import type { Preview } from '@storybook/vue3-vite'

import { configureUi } from '../src/i18n'

import '../../../frontend/src/styles/variables.css'
import skinLayers from 'virtual:velo-skins'

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

// --- the skin layer (§3.7) ---------------------------------------------------

/** The skins, keyed by the toolbar value (the package's token layer as CSS);
 *  the toolbar items follow the table. */
const SKIN_LAYERS: Record<string, string> = skinLayers

const SKIN_LAYER_ID = 'velo-skin-layer'

function applySkinLayer(selection: string): void {
  let layer = document.getElementById(SKIN_LAYER_ID)
  const css = SKIN_LAYERS[selection]
  if (css === undefined) {
    // Golden (the default): the base layer IS golden -- remove the override.
    layer?.remove()
    return
  }
  if (layer === null) {
    layer = document.createElement('style')
    layer.id = SKIN_LAYER_ID
    // Appended LAST: the override must win the cascade over the golden base
    // and the kit's own css, the way main.ts orders skin-tokens.css.
    document.head.appendChild(layer)
  }
  if (layer.textContent !== css) layer.textContent = css
}

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  globalTypes: {
    veloSkin: {
      name: 'Skin',
      description: 'The token layer over the golden base (§3.7 skin mode)',
      defaultValue: 'golden',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'golden', title: 'Golden (variables.css)' },
          ...Object.keys(SKIN_LAYERS).map((value) => ({ value, title: value })),
        ],
      },
    },
  },
  decorators: [
    // context.globals rides every re-render: a toolbar switch re-decorates
    // all stories at once -- no per-story wiring anywhere.
    (Story, context) => {
      applySkinLayer(context.globals.veloSkin as string)
      return Story()
    },
  ],
}

export default preview
