// =============================================================================
// VELO Frontend -- ESLint Configuration (Flat Config)
// =============================================================================

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import pluginTsdoc from 'eslint-plugin-tsdoc'
import globals from 'globals'

// Timezone-hygiene selectors (see the rule below); shared with the platform
// block, which must repeat them (flat config replaces same-rule options).
const DATE_SELECTORS = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=1][arguments.0.type='Literal']",
    message: 'Date(string) interprets unpredictably -- use luxon DateTime + useViewerTimezone.',
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
]

// Dynamic import() of the Telegram SDK: no-restricted-imports only sees static
// imports, so the lazy-loading door needs its own selector. Allowed inside
// src/platform/ only (that block omits it).
const TMA_DYNAMIC_IMPORT = {
  selector: 'ImportExpression[source.value=/^@tma\\.js\\//]',
  message:
    'The Telegram SDK is reachable only inside src/platform/ (lazy-loaded seam): use @/platform/tma-viewport.',
}

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
    plugins: {
      tsdoc: pluginTsdoc,
    },
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

      // --- TSDoc syntax gate (FE-137): every /** */ comment parses as ----
      // valid TSDoc, and only the standard's allowed tags
      // (docs/frontend-comments.md §2.1) pass -- the whitelist lives in
      // frontend/tsdoc.json. A misspelled tag (@parma -> unsupported-tag),
      // a {type} annotation, a broken {@link} all fail here. Rides
      // pnpm lint through lint-budget.mjs (eslint over src/), next to
      // no-cyrillic and key-audit.
      //
      // ERROR since FE-138 (2026-11-03) closed the escape backlog the rule
      // rode the warning budget for: the FE-134 prose kept `->` arrows, REST
      // placeholders like {user_id} and @/alias paths verbatim as grep
      // anchors; FE-138 either lifted their semantics into
      // @param/@returns/@throws tags or wrapped them in single-line code
      // spans, so hand-written files lint clean and the promised promotion
      // (zero-budget slice -> error) happened. Generated files are exempted
      // by the override below -- build output is not held to the standard.
      'tsdoc/syntax': 'error',
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
      'no-restricted-syntax': ['warn', ...DATE_SELECTORS, TMA_DYNAMIC_IMPORT],

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

  // --- P8: the @velo/ui boundary (tz-ui-package.md §4 P8; mirrors the ----
  // ui-package-boundary.test.ts law). The kit is imported ONLY through its
  // doors -- the barrels that re-export it plus the two seam doors (the
  // keyboard factory and the loading rule). (The P8 VTextarea door closed
  // with FE-153: the field moved into the kit.)
  // Deep subpaths ('@velo/ui/...') stay banned everywhere. Flat config does
  // not merge rule options: a later block with the same rule REPLACES the
  // earlier one for matching files. So this block carries the app-barrel
  // deep-import patterns ('@/components/ui/*', '@/components/icons/*') too --
  // otherwise it would silently erase the ban set in the base block above for
  // every file under src/. The doors override below repeats the patterns it
  // still needs verbatim.
  {
    files: ['src/**/*.{ts,vue}'],
    rules: {
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
            {
              group: ['@velo/ui', '@velo/ui/*'],
              message:
                'The kit is imported through its doors only: @/components/ui (or @/components/icons).',
            },
            {
              group: ['@tma.js/*'],
              message:
                'The Telegram SDK is reachable only inside src/platform/ (lazy-loaded seam): use @/platform/tma-viewport.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/components/ui/index.ts',
      'src/components/icons/index.ts',
      'src/composables/useKeyboardFieldScroll.ts',
      'src/composables/useLoadingHold.ts',
    ],
    rules: {
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
            // '@velo/ui' (exact barrel) is the door's whole point; deep
            // subpaths stay banned -- the same law ui-package-boundary
            // .test.ts enforces.
            {
              group: ['@velo/ui/*'],
              message: 'The exact barrel specifier only: "@velo/ui".',
            },
            {
              group: ['@tma.js/*'],
              message:
                'The Telegram SDK is reachable only inside src/platform/ (lazy-loaded seam): use @/platform/tma-viewport.',
            },
          ],
        },
      ],
    },
  },

  {
    // Tests drive components through createApp(...) -- the component-per-file
    // and name-casing rules misread those prop/passing objects as component
    // definitions (e.g. SendMessageModal's student-name `name` prop fixture
    // carries a person's name, not a component name).
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
    // The platform seam is the one place allowed to import @tma.js/*; every
    // other ban from the P8 block is repeated (flat config replaces, not
    // merges, same-rule options).
    files: ['src/platform/**'],
    rules: {
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
            {
              group: ['@velo/ui', '@velo/ui/*'],
              message:
                'The kit is imported through its doors only: @/components/ui (or @/components/icons).',
            },
          ],
        },
      ],
    },
  },

  {
    // The platform seam may import() the SDK lazily; the timezone selectors
    // stay (same-rule options are replaced, not merged).
    files: ['src/platform/**'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['warn', ...DATE_SELECTORS],
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
    // --- Generated code: not held to the comment standard. ----------------
    // src/api/generated.ts (the OpenAPI client) is build output of a
    // generator that lives in backend/** and carries a "DO NOT EDIT" header. Its
    // docstrings keep `->`, {placeholders} and @-aliases verbatim (~182
    // TSDoc grammar findings in generated.ts alone): hand-escaping is
    // futile -- the next regen wipes it -- and fixing the generator is a
    // backend change, off-limits to frontend work. The other FE-135 gates
    // already exclude these files the same way (typedoc.json lists both
    // patterns under exclude and externalPattern; note `**/generated.ts`
    // must be listed separately: the `*.generated.ts` glob requires a
    // basename prefix before the dot). The durable fix is upstream -- the
    // generator emitting tsdoc-safe docstrings -- until then this override
    // stands.
    files: ['**/generated.ts', '**/*.generated.ts'],
    rules: {
      'tsdoc/syntax': 'off',
    },
  },

  {
    // FE-157 5C: the .mjs build scripts. Same type-aware ruleset as the app,
    // typed through tsconfig.scripts.json (checkJs); Node globals instead of
    // the browser's.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ['./tsconfig.scripts.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The scripts are untyped JS (implicit-any parameters, JSON.parse
      // results): the unsafe family would flag ~1300 sites of "any" that the
      // JSDoc-less code cannot answer. Floating promises, unused vars and the
      // rest of the type-aware set stay on. Scoped to the .mjs scripts only:
      // the TypeScript files below keep the full set.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  {
    // The TypeScript build configs (Vite/Vitest): typed code, so the whole
    // type-aware set stays on (no no-unsafe-* relaxation), typed through
    // tsconfig.configs.json (strict, noImplicitAny on); Node globals.
    files: ['vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ['./tsconfig.configs.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // The Playwright suite (e2e/ and its config), typed through
    // e2e/tsconfig.json. Page callbacks run in the browser, hence both sets
    // of globals.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        project: ['./e2e/tsconfig.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // node:test registers tests with top-level test(...) calls that return a
    // promise nobody awaits by design.
    files: ['scripts/**/*.test.mjs'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },

  {
    // FE-131 scripts/lib/skin-package.mjs has a .d.mts sidecar: TypeScript
    // takes the declaration and leaves the .mjs out of tsconfig.scripts.json's
    // program, so the type-aware rules cannot run on it. Syntax-level rules
    // still apply; its types are checked through the .d.mts by vue-tsc.
    files: ['scripts/lib/skin-package.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // eslint.config.js and the other tooling configs stay unlinted; the two
    // build configs above are linted. The .d.mts type sidecars of the scripts
    // (FE-131 scripts/lib/skin-package.d.mts) are declarations only, outside
    // tsconfig.scripts.json; vue-tsc checks them through their TS importers.
    ignores: [
      'dist/',
      'node_modules/',
      'eslint.config.js',
      'stylelint.config.*',
      'scripts/**/*.d.mts',
    ],
  },
]
