// =============================================================================
// VELO Frontend -- ESLint Configuration (Flat Config)
// =============================================================================

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  js.configs.recommended,

  ...tseslint.configs.recommended,

  ...pluginVue.configs['flat/recommended'],

  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        parser: tseslint.parser,
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
      // No console.log in production code.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
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
    },
  },

  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
]
