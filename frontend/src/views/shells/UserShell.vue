<!--
  VELO Frontend -- UserShell (Phase F2.2)

  Layout wrapper for all /user/* routes.
  MobileLayout provides header slot + scrollable content + tab bar.
  Child views render inside <RouterView />.
-->

<template>
  <MobileLayout
    :tabs="USER_TABS"
    :active-tab="activeTab"
    :fill="isFillRoute"
    :hide-tab-bar="isDiaryRoute || isFormRoute || keyboardOpen"
    :fog="isFogRoute"
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
import { USER_TABS } from '@/router/tabs'
import { useKeyboardOpen } from '@/composables/useKeyboardOpen'

const route = useRoute()
const router = useRouter()

// Hide the floating tab bar while the soft keyboard is open, so it does not ride
// up over a focused input (e.g. the "запрос мастеру" field on booking-confirmed).
const { keyboardOpen } = useKeyboardOpen()

// Active tab: a route may pin one via meta.activeTab (e.g. the post-booking
// screen lights up Calendar). Otherwise match the path to the closest tab
// (e.g. /user/practices/123 -> /user).
const activeTab = computed(() => {
  const metaTab = route.meta.activeTab as string | undefined
  if (metaTab) return metaTab
  const path = route.path
  const match = USER_TABS.find((tab) => path.startsWith(tab.to))
  return match?.to ?? USER_TABS[0]?.to ?? ''
})

// The diary is an immersive full-screen mode: no bottom tab bar (the feed,
// the entry view and the check-in/feedback detail all hide it). Exit is via
// the "..." menu inside the diary, not tab navigation. These same three routes
// are also the fill-mode routes (see isFillRoute below) — keep the two in sync.
const DIARY_ROUTES = ['user-diary', 'user-diary-entry', 'user-diary-detail']
const isDiaryRoute = computed(() => DIARY_ROUTES.includes(route.name as string))

// All three diary screens render in the layout's fill mode: each owns its
// internal scroll (a body with overflow-y:auto) plus an inline header, which is
// exactly the fill contract (padding:0 + flex column, no reserved floating-header
// clearance). The feed was already fill; the entry + check-in/feedback detail
// join it. Non-fill previously reserved a phantom ~104px header fallback (no
// VHeader teleports on these screens) that collapsed their content into a
// cramped, pushed-down box (G2: «Запись» скукоженный).
const isFillRoute = computed(() => DIARY_ROUTES.includes(route.name as string))

// Focused full-screen form flows (check-in / feedback / no-show reflection)
// hide the tab bar too: they have their own "Close" + submit/skip actions, and
// an in-flow tab bar rides up over the textarea when the keyboard opens.
// user-reflection (T22-1): same FormShell full-screen contract as the other
// two, just reached from the no-show banner instead of the feedback one --
// omitting it here was the only thing that left its tab bar showing.
const FORM_ROUTES = ['user-checkin', 'user-feedback', 'user-reflection']
const isFormRoute = computed(() => FORM_ROUTES.includes(route.name as string))

// Edge-to-edge fog mask: the long scrolling lists/feeds + the practice-detail
// screen (operator 2026-06-09: dissolve its hero under the header and its CTA
// over the tabbar instead of a hard collision). Forms and the profile still
// opt out (their footers/actions must stay crisp). The diary owns its own fog
// via fill mode, so it is not listed here.
// EXCEPTION (operator PE-2a, 2026-07-01): user-edit-profile opts IN for parity
// with the master edit-profile variant (master-edit-profile is fogged via FOG-1) —
// see the entry below.
const FOG_ROUTES = [
  'user-dashboard',
  'user-calendar',
  'user-bookings',
  'user-master-public',
  'practice-detail',
  // Edit-profile (operator PE-2a, 2026-07-01): parity with the fogged master
  // variant — top+bottom dissolve under the floating header. «Сохранить» + the
  // delete link are in-flow at the list bottom and rest above the bottom fade
  // (like the profile hub), so they stay crisp. At rest the fog dissolves content
  // under the floating title; on keyboard-open the mask drops (global.css) and the
  // focused field scrolls above the keyboard (PE-2c). No solid header — the design
  // has no white plates (operator, no-plate call).
  'user-edit-profile',
  // Support (batch O, O3 / operator Q3=А): the «Поддержка» screen is a form like
  // edit-profile — fog dissolves content under the floating header so it no longer
  // overlaps on scroll. Default form-safe tuning: the submit button + inputs sit
  // above the bottom fade (the tab-bar clearance), so they stay crisp.
  'user-support',
]
const isFogRoute = computed(() => FOG_ROUTES.includes(route.name as string))

// Per-screen fog tuning. The list feeds keep MobileLayout's defaults
// (16/40/70/90 — omitted = unchanged). practice-detail uses a softer top
// dissolve + tighter bottom so the «Записаться бесплатно» CTA stays crisp above
// the tab bar. The four numbers live as --velo-fog-pd-* tokens (variables.css,
// single reusable source); read once here since the values flow through JS into
// MobileLayout. Confirmed on the .tmp preview 2026-06-09.
let pdFogCache: {
  topGap: number
  fogTopHard: number
  fogBotFade: number
  fogBotHard: number
} | null = null
function practiceDetailFog() {
  if (pdFogCache) return pdFogCache
  const cs = getComputedStyle(document.documentElement)
  const tok = (name: string, fallback: number): number => {
    const n = parseInt(cs.getPropertyValue(`--velo-fog-pd-${name}`), 10)
    return Number.isFinite(n) ? n : fallback
  }
  pdFogCache = {
    topGap: tok('top-gap', 25),
    fogTopHard: tok('top-hard', 60),
    fogBotFade: tok('bot-fade', 50),
    fogBotHard: tok('bot-hard', 90),
  }
  return pdFogCache
}
const fogTuning = computed(() => (route.name === 'practice-detail' ? practiceDetailFog() : {}))
</script>
