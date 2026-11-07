// =============================================================================
// @velo/ui -- ESLint Configuration (Flat Config, FE-116)
// =============================================================================
//
// Mirrors frontend/eslint.config.js -- that file is the law source; this one
// applies the same law to package code. A SEPARATE file is mechanical, not
// organizational: ESLint flat config refuses to lint files outside its base
// path ("File ignored because outside of base path", verified on eslint
// 9.39), so the frontend gate cannot reach into packages/ -- instead
// frontend/scripts/lint-budget.mjs runs THIS config from THIS directory
// under the same zero-warning budget (FE-116, tz-ui-package.md §3.7).
//
// Deliberate differences from the frontend config:
//   - no barrel/icons deep-import rules (the §7.2 conventions -- data-velo-*,
//     attrs-root, slots -- arrive with each component's переносной PR, P2+)
//   - the platform seam landed in FE-143 as a MINI-dom-seam
//     (src/platform/dom.ts: onDocumentEvent/offDocumentEvent for the P6
//     overlays, setBodyOverflow/toggleRootClass for the moved body-scroll
//     lock) and carries the same no-restricted-globals law as the
//     frontend's platform/** -- see the rule below.
// =============================================================================

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  js.configs.recommended,

  // Type-aware linting, same cost/benefit trade-off as the frontend.
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
        // `project` (not projectService), same reasoning as the frontend
        // config: the service cannot resolve imports inside .vue SFC script
        // blocks; the plain program matches what vue-tsc sees.
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
      // Allow single-word component names (VStub, VButton, etc.).
      'vue/multi-word-component-names': 'off',
      // console.warn/error allowed; console.log is a hard lint failure.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // --- Platform seam (FE-143): window/document live only inside
      // src/platform/ -- the kit's own door to the DOM, mirroring the
      // frontend's law word for word. Exempted below: src/platform/** and
      // tests (happy-dom fixtures).
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Go through src/platform/dom.ts (the kit dom-seam).' },
        { name: 'document', message: 'Go through src/platform/dom.ts (the kit dom-seam).' },
      ],

      // Template FORMATTING belongs to prettier (same carve-out and reasoning
      // as the frontend config: prettier runs in this package too).
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      // FE-117 batch A: the P1 mirror missed this one (VStub never tripped
      // it); the frontend config disables it the same way -- prettier owns
      // the closing-bracket layout.
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-closing-tag-newline': 'off',
      'vue/html-self-closing': 'off',
      // Attribute/event NAMING stays camelCase (vue-tsc resolves template
      // bindings strictly; see the frontend config's note).
      'vue/attribute-hyphenation': 'off',
      'vue/v-on-event-hyphenation': 'off',
      // Optional props are intentional (same policy as the frontend).
      'vue/require-default-prop': 'off',
    },
  },

  {
    // Same test relaxations as the frontend: mounts, fixtures and vitest
    // plumbing read as violations through the type-aware rules.
    files: ['src/**/*.test.ts'],
    rules: {
      'vue/one-component-per-file': 'off',
      'vue/component-definition-name-casing': 'off',
      // happy-dom fixtures use window/document (same carve-out as the
      // frontend's tests).
      'no-restricted-globals': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  {
    // The platform seam owns the host objects (FE-143) -- the kit's mirror
    // of the frontend's src/platform exemption.
    files: ['src/platform/**'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  {
    // --- P8: the reverse boundary (tz-ui-package.md §4 P8; principle 2). --
    // The kit consumes the HOST's tokens and seams; it never reaches back
    // into the host application ('@/...' aliases, 'frontend/...' paths) --
    // a kit component importing app code would invert the dependency arrow
    // the whole migration built. Mirrored by src/boundary.test.ts (the
    // vitest gate that actually runs in CI).
    files: ['src/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', '@/**', 'frontend/*', 'frontend/**'],
              message:
                'The kit never imports the host application -- host wiring arrives through seams (configureUi, provide keys) or props.',
            },
          ],
        },
      ],
    },
  },

  {
    ignores: ['dist/', 'node_modules/', '*.config.*', 'storybook-static/'],
  },
]
