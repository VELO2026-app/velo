// =============================================================================
// VELO Frontend -- ESLint Configuration (Flat Config)
// =============================================================================

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  js.configs.recommended,

  // Type-aware linting: rules read the type graph and catch the async bug
  // class plain lint cannot see (forgotten await, promise in a sync slot,
  // dead conditions). Costs lint speed -- accepted: the gate runs in the
  // night protocol, not on every save.
  ...tseslint.configs.recommendedTypeChecked,

  ...pluginVue.configs['flat/recommended'],

  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        parser: tseslint.parser,
        // `project` (not projectService): the service cannot resolve imports
        // inside .vue SFC script blocks -- every import came back "error
        // typed" and produced ~13k false no-unsafe-* findings. The plain
        // program matches what vue-tsc sees (verified on IconArt.vue).
        project: ['./tsconfig.json'],
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // Allow unused vars with underscore prefix.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow single-word component names (VButton, VCard, etc.).
      'vue/multi-word-component-names': 'off',
      // console.warn/error allowed; console.log is a hard lint failure.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // --- Architecture: components are imported through barrels only. ----
      // Deep paths bypass the barrel's contract; the ban is mechanical so it
      // holds for any amount of hand-written or generated code. Intra-folder
      // deep imports and *.test.ts are exempted below.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/components/ui/*', '@/components/ui/*/*'],
              message: 'Import from the barrel: import { VButton } from "@/components/ui".',
            },
            {
              group: ['@/components/icons/*', '@/components/icons/*/*'],
              message: 'Import from the barrel: import { IconHome } from "@/components/icons".',
            },
          ],
        },
      ],

      // --- Platform seam: window/document live only inside platform/. -----
      // This is a Telegram Mini App; host access goes through @/platform
      // (platform/host.ts for window globals, platform/dom.ts for document).
      // Rollout done: zero findings outside the seam since the migration, so
      // the rule is error-level. Exempted below: platform/**, main.ts, tests
      // (happy-dom fixtures).
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Go through @/platform (the Telegram WebApp seam).' },
        { name: 'document', message: 'Go through @/platform (the Telegram WebApp seam).' },
      ],
      // --- Legacy debt rides the warning budget (see lint-budget.json). ---
      // Every rule in the legacy-debt block below is error-worthy; the
      // codebase still carries counted findings (no silent bypass: any
      // GROWTH fails the lint via the budget). Promote each to 'error' when
      // its budget slice hits zero.
      // --- Timezone hygiene: only the DANGEROUS Date constructors. --------
      // Bare new Date() (current instant) and Date.now() are tz-safe and
      // stay allowed. String/field constructors interpret in the runtime
      // timezone -- a real bug class in a timezone product; use luxon
      // DateTime with useViewerTimezone. Legacy sites ride the warning
      // budget (lint-budget.json) until paid off.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "NewExpression[callee.name='Date'][arguments.length=1][arguments.0.type='Literal']",
          message:
            'Date(string) interprets unpredictably -- use luxon DateTime + useViewerTimezone.',
        },
        ...[2, 3, 4, 5, 6, 7].map((n) => ({
          selector: `NewExpression[callee.name='Date'][arguments.length=${n}]`,
          message:
            'new Date(y, m, ...) builds in the runtime tz -- use luxon DateTime + useViewerTimezone.',
        })),
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Date() without new -- use new Date() or luxon DateTime.',
        },
      ],

      // --- TMA storage seam. ------------------------------------------------
      'no-restricted-properties': [
        'warn',
        {
          object: 'localStorage',
          property: '*',
          message: 'Route storage through @/platform, not localStorage directly.',
        },
        {
          object: 'window.localStorage',
          property: '*',
          message: 'Route storage through @/platform, not localStorage directly.',
        },
      ],
      // Template FORMATTING belongs to prettier (lint-staged runs it on every
      // commit and would immediately revert these rules' fixes -- verified on
      // App.vue: eslint --fix -> 0 warnings, prettier -> warning returns).
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-self-closing': 'off',
      // Attribute/event NAMING stays camelCase: props are typed camelCase and
      // vue-tsc resolves template bindings strictly -- a hyphenated binding
      // does not match the camelCase prop and falls through as an unknown
      // attr (broke typecheck on EntryView's :ariaLabel -> :aria-label).
      'vue/attribute-hyphenation': 'off',
      'vue/v-on-event-hyphenation': 'off',
      // Optional props are intentional: optionality/nullability is expressed
      // in the types, withDefaults is added only where a real default exists
      // (e.g. AddToGroupSheet's existingGroupIds). A missing default IS the
      // "not provided" semantics, not an omission.
      'vue/require-default-prop': 'off',
    },
  },

  {
    // Tests drive components through createApp(...) -- the component-per-file
    // and name-casing rules misread those prop/passing objects as component
    // definitions (e.g. SendMessageModal's `name: 'Анна Кузнецова'` fixture is
    // a student-name prop, not a component name).
    files: ['src/**/*.test.ts'],
    rules: {
      'vue/one-component-per-file': 'off',
      'vue/component-definition-name-casing': 'off',
      // happy-dom fixtures use window/document; date fixtures build Dates.
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      // wrapper.vm is typed any and its methods read as unbound; async test
      // fixtures await nothing on purpose; querySelectorAll assertions are
      // real narrowings the rule misreads through projectService.
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // vi.fn()/vi.spyOn()/vi.mock-factory plumbing is inherently loosely
      // typed; the unsafe family stays ON for production code (see the
      // legacy-debt block above).
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  {
    // The barrels and the components themselves may use deep paths internally
    // (a barrel importing its own export through itself would be circular).
    files: ['src/components/ui/**', 'src/components/icons/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  {
    // The platform seam and the bootstrap own the host objects.
    files: ['src/platform/**', 'src/main.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
]
