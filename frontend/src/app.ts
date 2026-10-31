// =============================================================================
// VELO Frontend -- Application start (moved out of main.ts in BE-149)
// =============================================================================
//
// Equivalent of backend/app/main.py.
// Creates the Vue app, attaches plugins (router, pinia), mounts it.
//
// Imported by main.ts ONLY AFTER platform/launch.ts has prepared the host:
// everything below -- and platform/index.ts, which picks the platform at
// module evaluation -- must see telegram-web-app.js already loaded when
// Telegram launched the app. Do not import this module statically.
//
// Telegram SDK (safe-area, step 1): we initialize @tma.js/sdk BEFORE creating
// the Vue app and bind its viewport CSS variables + insets. This runs IN
// PARALLEL with the existing window.Telegram.WebApp platform layer -- the old
// layer is untouched for now, so nothing else (auth, tests) changes yet. The
// SDK is what finally makes the content safe-area inset reactive: it owns the
// --tg-viewport-* / safe-area CSS vars and updates them with a real reflow,
// unlike the raw setProperty in the vendored SDK.
//
// initTelegramSdk() is best-effort and guarded: the SDK throws when launched
// outside Telegram (standalone browser, unit tests in happy-dom), so we only
// init when a Telegram environment is detected and swallow any failure. This
// keeps the standalone build and the 353-test gate green.
// =============================================================================

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import i18n from './locales'

// Global styles (order matters: variables first, then reset/base).
import './styles/variables.css'
import './styles/global.css'
import './styles/motion.css'
// tz-whitelabel §3 cascade: the skin overrides ride LAST, mechanically --
// this file is GENERATED at build time (public/skin/tokens.css when a skin
// ships, an empty stub otherwise; see platform/skin.ts). The TZ sketch said
// main.ts, but the app-wide stylesheet order lives HERE, so the generated
// import sits in the same chain -- hopeful import order is not a mechanism.
import './styles/skin-tokens.css'

import { initTelegramSdk } from './platform/telegram-sdk'
import { installRenderDebug } from './platform/render-debug'
import { readLocaleHint, setLocale } from './locales'
import { isSupportedLocale } from './platform/instance'

// Initialize the Telegram SDK (best-effort) before mounting. Safe outside
// Telegram: it detects the environment and no-ops on failure.
initTelegramSdk()

const app = createApp(App)

// Pinia = state manager (like a global dict of reactive objects).
app.use(createPinia())

// i18n (tz-i18n phase 0): the ru catalog is verbatim the previously
// hardcoded strings, so this changes no rendered text. The UI language
// follows authStore.user.language (App.vue watches it).
app.use(i18n)

// Router = URL -> component mapping (like FastAPI include_router).
app.use(router)

// Dev-only render log (platform/render-debug.ts): off unless the
// 'velo:debug-renders' storage flag is set; a no-op in production builds.
installRenderDebug(app, router)

// Boot locale hint (tz-i18n phase 5): apply the last CHOSEN locale BEFORE the
// first render -- without this, a reopen shows the default locale for the
// whole auth round-trip and then flips (the "5-10s of Russian" report). The
// catalog chunk loads in parallel here (~tens of ms), so the splash grows by
// roughly nothing; the server value later corrects a stale hint via the
// App.vue watcher (same-locale no-op when they agree).
const localeHint = readLocaleHint()
if (localeHint && isSupportedLocale(localeHint)) await setLocale(localeHint)

// Mount into <div id="app"> in index.html.
app.mount('#app')
