// =============================================================================
// VELO Frontend -- passportHtmlDefaults (tz-whitelabel F1, §2.2)
// =============================================================================
// BUILD-side passport seam: vite.config.ts plugs this in to resolve the
// %VITE_*% placeholders in index.html. (The browser-side seam is
// platform/instance.ts -- it reads import.meta.env, which does not exist in
// Node, which is why the two cannot share one module.)
//
// Vite replaces %VITE_*% in index.html natively -- but ONLY env vars that are
// DEFINED at build time, and CI builds without a .env: an undefined var would
// ship the literal "%VITE_BRAND%" as the title. This post-transform resolves
// whatever is left from .env files / process.env, falling back to the golden
// defaults. The defaults DUPLICATE platform/instance.ts on purpose (same
// mirror pattern as telegram.ts ↔ variables.css): instance.test.ts pins the
// golden side, passport-html.test.ts pins this one.
// =============================================================================

import { loadEnv, type Plugin } from 'vite'

const PASSPORT_HTML_DEFAULTS: Record<string, string> = {
  VITE_BRAND: 'VELO',
  VITE_DEFAULT_LOCALE: 'ru',
}

export function passportHtmlDefaults(): Plugin {
  let files: Record<string, string> = {}
  return {
    name: 'velo-passport-html-defaults',
    configResolved(config) {
      files = loadEnv(config.mode, config.envDir ?? config.root, 'VITE_')
    },
    transformIndexHtml: {
      // 'post': run after Vite's own html env replacement, so only
      // unresolved placeholders are handled here.
      order: 'post',
      handler(html) {
        return html.replace(/%VITE_[A-Z0-9_]+%/g, (placeholder) => {
          const name = placeholder.slice(1, -1)
          const value = process.env[name] ?? files[name] ?? PASSPORT_HTML_DEFAULTS[name]
          return value ?? placeholder
        })
      },
    },
  }
}
