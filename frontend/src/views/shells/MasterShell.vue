<!--
  VELO Frontend -- MasterShell (Phase F2.2)

  Layout wrapper for all /master/* routes.
  MobileLayout provides header slot + scrollable content + tab bar.
-->

<template>
  <MobileLayout
    :tabs="MASTER_TABS"
    :active-tab="activeTab"
    :fill="isFillRoute"
    :fog="isFogRoute"
    :hide-tab-bar="hideTabBar"
    v-bind="fogTuning"
    @navigate="router.push($event)"
  >
    <RouterView />
  </MobileLayout>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MobileLayout } from '@/components/layout'
import { MASTER_TABS } from '@/router/tabs'
import { useKeyboardOpen } from '@/composables/useKeyboardOpen'

const route = useRoute()
const router = useRouter()

// Hide the floating tab bar while the soft keyboard is open, so it does not ride
// up over a focused input (parity with UserShell — e.g. the «Мои ученики» search).
const { keyboardOpen } = useKeyboardOpen()

const activeTab = computed(() => {
  const path = route.path
  const match = MASTER_TABS.find((tab) => path.startsWith(tab.to))
  return match?.to ?? MASTER_TABS[0]?.to ?? ''
})

// Chat thread runs in MobileLayout `fill` mode (internal-scroll thread + a truly
// pinned composer + its own top fog), the same per-route opt-in the diary uses in
// UserShell (MC-2, №242). Opt-in ONLY — every other master route keeps fill=false
// and renders byte-identically (MobileLayout's `--fill` branch never applies).
const isFillRoute = computed(() => route.name === 'master-chat')

// Edge-to-edge fog on the long scrolling master LIST/feed screens, matching the
// User zone (operator tester-fix 2026-06-17, scope А). Forms / profile / create-
// edit / single-detail / message-thread composer stay CRISP (DS rule: their
// CTAs/footers must not fade) — so notifications (settings toggles) and finance
// (payout form + «Запросить вывод» CTA) are deliberately NOT fogged.
// Every hideTabBar list below gets the compact bottom fade automatically:
// MobileLayout substitutes --velo-fog-list-z3/z4 when fog && hideTabBar, so the
// dissolve lands at the real content bottom (this also fixes the latent
// practice-reviews bottom clip the previous comment flagged).
const FOG_ROUTES = [
  'master-practices',
  'master-dashboard',
  'master-analytics',
  'master-practice-reviews',
  'master-students',
  'master-messages',
  'master-promocodes',
  'master-summary',
  'master-attendance-roster',
  // Check-ins list (the same per-practice attendance feed as the roster) — fog
  // for parity with master-attendance-roster (WS-1, 2026-06-19).
  'master-attendance',
  // Scrolling profile (check-ins + feedbacks lists) — fog so the floating header
  // doesn't collide with content on scroll (operator tester-fix 2026-06-17).
  'master-student-profile',
  // Master GROUPS (P2, ПРОМТ №591): list + per-group member list are both
  // long scrolling lists, same treatment as master-students. The create
  // form stays CRISP (not listed here) per the fog rule above.
  'master-groups',
  'master-group-detail',
  // Notifications: long settings list — fog so the «Уведомления» header doesn't
  // overlap the rows on scroll (operator 2026-06-19).
  'master-notifications',
  // Detail / form screens with a transparent floating header — fog so content
  // doesn't collide with the header on scroll (the white «solid» plate was
  // dropped 2026-06-29). practice-detail + finance + the 3 Stage-2 forms
  // (create / edit practice, new promocode) carry an IN-FLOW bottom CTA, so they
  // take the CTA-safe pd-tuning below (softer top / tighter bottom) — the button
  // sits above the fade and stays solid. The profile hub has no in-flow CTA
  // (logout in a modal) + keeps its tab bar, so default fog clears its last row.
  // KEYBOARD-SAFE (operator-mandate 2026-06-29): fog over a form input no longer
  // clips it — the keyboard-aware mask (global.css `html.is-keyboard-open` +
  // `--velo-vvh`, commit e95e05a) shrinks the masked area to the visible viewport
  // on keyboard-open, so create/edit/promocode forms join finance under the same
  // (de-solid → fog, keyboard-safe) rationale. Support is now re-fogged too (SP-2,
  // 2026-07-01) — see its CTA-safe entry below.
  'master-practice-detail',
  'master-finance',
  'master-practice-new',
  'master-practice-edit',
  'master-promocode-new',
  'master-profile',
  // Edit-profile + language/timezone: fog so content doesn't smudge under the
  // floating header on scroll (operator FOG-1, 2026-06-30). Both are keyboard
  // screens — keyboard-safe via the e95e05a viewport mask (ships in this batch),
  // so this follows the same de-solid → fog, keyboard-safe rationale as the forms.
  'master-edit-profile',
  'master-language-timezone',
  // Support (SP-2, 2026-07-01): RE-FOGGED after being un-fogged in #8/#9 (5d74c8c,
  // where the pre-keyboard-aware fog clipped the form into a band). Safe now: the
  // «убрать туман при вводе» rule (global.css) drops the mask while typing, and the
  // CTA-safe bottom (below) keeps the «Отправить» button crisp at rest. Fixes the
  // header-overlap-on-scroll the operator flagged.
  'master-support',
  // NB: master-chat is NOT here — it runs in MobileLayout `fill` mode (isFillRoute),
  // which drops the shared mask; the chat owns its top fog view-side (MC-2, №242).
]
const isFogRoute = computed(() => FOG_ROUTES.includes(route.name as string))

// Read a numeric px CSS custom property off :root (callers pass a cached `cs`).
function fogPx(cs: CSSStyleDeclaration, name: string, fallback: number): number {
  const n = parseInt(cs.getPropertyValue(name), 10)
  return Number.isFinite(n) ? n : fallback
}

// CTA-safe fog tuning: a softer top dissolve + the full pd bottom via the shared
// --velo-fog-pd-* tokens, so an in-flow bottom action button clears the bottom
// fade and stays crisp. Read once + memoized. The create/edit/promocode forms
// (and now finance, PC2b) moved to the COMPACT bottom (ПРОМТ №233 / 2026-07-12 —
// the full 140px read as a too-wide fog band; see COMPACT_BOTTOM_FOG_ROUTES /
// FORM_FOG_ROUTES). Support is the only screen left on the full pd bottom.
const CTA_SAFE_FOG_ROUTES = ['master-support']
let pdFogCache: {
  topGap: number
  fogTopHard: number
  fogBotFade: number
  fogBotHard: number
} | null = null
function ctaSafeFog() {
  if (pdFogCache) return pdFogCache
  const cs = getComputedStyle(document.documentElement)
  pdFogCache = {
    topGap: fogPx(cs, '--velo-fog-pd-top-gap', 25),
    fogTopHard: fogPx(cs, '--velo-fog-pd-top-hard', 60),
    fogBotFade: fogPx(cs, '--velo-fog-pd-bot-fade', 50),
    fogBotHard: fogPx(cs, '--velo-fog-pd-bot-hard', 90),
  }
  return pdFogCache
}

// Compact-bottom fog: soft pd TOP + the COMPACT list bottom (--velo-fog-list-z3/z4)
// for hideTabBar screens whose in-flow CTA sits just above a short bottom fade.
//   • master-practice-detail (FOG-2, 2026-06-30): the pd bottom (fade 50 + hard 90
//     = 140px, sized for a tab bar the screen hides) wasted screen; the past-state
//     «Посещаемость» CTA still clears the 48px fade.
//   • create / edit practice + new promocode (ПРОМТ №233): same 140px read as a
//     "too-wide" bottom fog band; the in-flow «Создать …» CTA clears the shorter
//     48px fade the same way. Master-scoped; finance keeps the full pd bottom.
// Reuses existing tokens, no new token. Device-tunable via --velo-fog-list-z3/z4.
let compactBottomFogCache: {
  topGap: number
  fogTopHard: number
  fogBotFade: number
  fogBotHard: number
} | null = null
function compactBottomFog() {
  if (compactBottomFogCache) return compactBottomFogCache
  const cs = getComputedStyle(document.documentElement)
  compactBottomFogCache = {
    topGap: fogPx(cs, '--velo-fog-pd-top-gap', 25),
    fogTopHard: fogPx(cs, '--velo-fog-pd-top-hard', 60),
    fogBotFade: fogPx(cs, '--velo-fog-list-z3', 48),
    fogBotHard: fogPx(cs, '--velo-fog-list-z4', 0),
  }
  return compactBottomFogCache
}

// Screens on the compact-bottom fog above (soft top, short bottom fade). Now just
// practice-detail — the forms moved to formFog() (M7, taller top-hard). Detail
// keeps the softer 60 top-hard (FOG-2): its transparent header over the soft hero
// is intentional, unlike the forms' crisp fields.
const COMPACT_BOTTOM_FOG_ROUTES = ['master-practice-detail']

// Form-only fog (M7, ПРОМТ №275; joined by finance, PC2b 2026-07-12): the create /
// edit practice + new promocode FORMS carry a TRANSPARENT floating VHeader
// (~88px). The shared pd-top-hard (60) is shorter than the header, so form
// content ghosted UNDER the header's lower half on scroll (operator «наезжает
// заголовок при скролле»). Same tuning as compactBottomFog but with the taller
// --velo-fog-pd-top-hard-form so content fully dissolves before the header.
// Finance uses the identical VHeader pattern (`<VHeader title="Вывод средств"
// show-back />`) and had the same "too much fog" complaint on its bottom pd —
// moved here rather than to COMPACT_BOTTOM_FOG_ROUTES (that one's tuned for
// practice-detail's non-VHeader hero header). practice-detail stays on
// compactBottomFog. Reuses the fogPx reader; the header stays transparent (no
// solid plate).
const FORM_FOG_ROUTES = [
  'master-practice-new',
  'master-practice-edit',
  'master-promocode-new',
  'master-finance',
]
let formFogCache: {
  topGap: number
  fogTopHard: number
  fogBotFade: number
  fogBotHard: number
} | null = null
function formFog() {
  if (formFogCache) return formFogCache
  const cs = getComputedStyle(document.documentElement)
  formFogCache = {
    topGap: fogPx(cs, '--velo-fog-pd-top-gap', 25),
    fogTopHard: fogPx(cs, '--velo-fog-pd-top-hard-form', 88),
    fogBotFade: fogPx(cs, '--velo-fog-list-z3', 48),
    fogBotHard: fogPx(cs, '--velo-fog-list-z4', 0),
  }
  return formFogCache
}

// master-dashboard (DB-1, 2026-06-30 → DB-1b, ПРОМТ №273): the greeting was
// removed, leaving an oversized top band. The hub is HEADERLESS (bell lives in the
// content, no VHeader → islandH=0), so the 88px HEADER_FALLBACK dominates and the
// earlier +8 (--space-2) gap only trimmed 8px off it (88+8=96px). Pull the band
// down with the reusable short-top-fog token --velo-fog-z1-short (negative top-gap,
// top = 88 + this ⇒ ~48px), mirroring the headerless master-profile fix. Tunable
// in variables.css.
let dashFogCache: { topGap: number } | null = null
function dashboardFog() {
  if (dashFogCache) return dashFogCache
  const cs = getComputedStyle(document.documentElement)
  dashFogCache = { topGap: fogPx(cs, '--velo-fog-z1-short', -40) }
  return dashFogCache
}

// master-profile (PE-1, 2026-07-01): the profile hub is HEADERLESS (no VHeader →
// islandH=0), so MobileLayout applies the 88px HEADER_FALLBACK + the default z1 gap
// ≈104px empty band above the first card. A NEGATIVE top-gap pulls that clearance
// down (top = HEADER_FALLBACK + this); the fog fade still lands the card crisp
// because its opaque boundary tracks the reduced paddingTop. Bottom fog unchanged
// (the hub keeps its tab bar). Reuses the fogPx reader; value in --velo-fog-mp-top-gap.
// Does NOT touch MobileLayout shared logic / the HEADER_FALLBACK constant.
let mpFogCache: { topGap: number } | null = null
function masterProfileFog() {
  if (mpFogCache) return mpFogCache
  const cs = getComputedStyle(document.documentElement)
  mpFogCache = { topGap: fogPx(cs, '--velo-fog-mp-top-gap', -40) }
  return mpFogCache
}

const fogTuning = computed(() => {
  const name = route.name as string
  if (FORM_FOG_ROUTES.includes(name)) return formFog()
  if (COMPACT_BOTTOM_FOG_ROUTES.includes(name)) return compactBottomFog()
  if (name === 'master-dashboard') return dashboardFog()
  if (name === 'master-profile') return masterProfileFog()
  return CTA_SAFE_FOG_ROUTES.includes(name) ? ctaSafeFog() : {}
})

// Hide the bottom tab bar on detail routes that opt in via `meta.hideTabBar`
// (the design omits the tab bar on master detail screens), OR while the soft
// keyboard is open so it never rides up over a focused input.
const hideTabBar = computed(() => route.meta.hideTabBar === true || keyboardOpen.value)
</script>
