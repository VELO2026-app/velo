<!--
  TEMPORARY DIAGNOSTIC -- PROMPT №654/656/657/663 (T24-1/B29). NOT
  design-system UI: do not theme it, do not keep it. It comes out on the
  Navigator's word, once the rebuild is accepted on the owner's device --
  NOT on this prompt.

  Visibility: UNCONDITIONAL (PROMPT №660) -- mounted by DiaryFeedView.vue for
  every diary visitor, no gesture, no role, no storage. Four gesture-gated
  activation attempts before №660 never produced a confirmed sighting, so the
  gesture layer itself was removed as a variable. PROMPT №663 (owner-ruled,
  after finally seeing it): kept, made small with a small font so the field
  list fits without covering the app.

  PROMPT №657: reports what useViewportGeometry.ts -- the ONE place in the
  tree that now reads raw visualViewport height/offset or the tma.js viewport
  SDK for keyboard state -- actually PUBLISHED (its CSS vars + its exported
  refs, imported directly here, not re-derived). This panel does NOT read
  window.visualViewport.height/offsetTop or call viewport.isMounted() /
  stableHeight() itself anymore (it did in №654/656) -- that would have made
  TWO readers again, exactly the defect this rebuild exists to remove. Three
  things it still reads directly, deliberately, because they are NOT part of
  what useViewportGeometry computes and so cannot duplicate it: basic device
  metrics (innerHeight/screen.height/devicePixelRatio/pageTop), the RAW
  window.Telegram.WebApp surface (a third, independent platform layer, kept
  as a cross-check per the original №654 ask), and the composer element's own
  DOM geometry (a measurement of the RESULT, not an input). Writes no style,
  class, or listener onto .diary-feed / .diary-feed__composer / #app / html
  -- the elements under test. Its own box is `position: fixed; top: 0` in
  plain, literal pixel values (no --velo-* var, no design token) so a bug in
  the thing being diagnosed cannot also mis-place the diagnostic itself.
-->
<template>
  <div class="kbd-debug" aria-hidden="true">
    <div v-for="line in lines" :key="line[0]" class="kbd-debug__row">
      <span class="kbd-debug__k">{{ line[0] }}</span>
      <span class="kbd-debug__v">{{ line[1] }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import {
  keyboardOpen as canonicalKeyboardOpen,
  keyboardSignal as canonicalKeyboardSignal,
  visibleHeight as canonicalVisibleHeight,
  viewportOffsetTop as canonicalOffsetTop,
  keyboardRestHeight as canonicalRestHeight,
} from '@/composables/useViewportGeometry'

const POLL_MS = 300

const lines = ref<[string, string][]>([])
let rafId = 0
let intervalId = 0
let vv: VisualViewport | null = null

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a'
  return String(Math.round(n * 100) / 100)
}

function readTelegramWebApp(): { vh: string; vsh: string; exp: string } {
  const wa = (window as unknown as { Telegram?: { WebApp?: Record<string, unknown> } }).Telegram
    ?.WebApp
  if (!wa) return { vh: 'n/a (no WebApp)', vsh: 'n/a', exp: 'n/a' }
  return {
    vh: fmt(wa.viewportHeight as number | undefined),
    vsh: fmt(wa.viewportStableHeight as number | undefined),
    exp: String(wa.isExpanded),
  }
}

function collect(): void {
  const innerH = window.innerHeight
  const innerW = window.innerWidth
  const screenH = window.screen?.height
  const screenW = window.screen?.width
  const clientW = document.documentElement.clientWidth
  const dpr = window.devicePixelRatio
  // pageTop only -- height/offsetTop come from the canonical refs below, not
  // re-read here (see the file header: reading them again would restore the
  // exact "two readers" defect this rebuild removed).
  const vvPageTop = (vv as unknown as { pageTop?: number } | null)?.pageTop ?? null

  const wa = readTelegramWebApp()

  const root = document.documentElement
  const frozenVh = getComputedStyle(root).getPropertyValue('--velo-frozen-vh').trim() || '(unset)'
  const veloVvh = getComputedStyle(root).getPropertyValue('--velo-vvh').trim() || '(unset)'
  const veloVvOffset =
    getComputedStyle(root).getPropertyValue('--velo-vv-offset').trim() || '(unset)'
  const htmlKbOpen = root.classList.contains('is-keyboard-open')

  const feedEl = document.querySelector('.diary-feed')
  const composingOn = feedEl?.classList.contains('diary-feed--composing') ?? false
  const composerEl = document.querySelector('.diary-feed__composer') as HTMLElement | null
  const composerBottom = composerEl ? getComputedStyle(composerEl).bottom : 'n/a (not mounted)'
  const rect = composerEl?.getBoundingClientRect() ?? null

  // The true visible rect, in layout-box coordinates -- offsetTop is the
  // ONLY new number this whole rebuild is about; bottom = offset + height is
  // computeKeyboardBottomOffset's other half, made visible in plain terms.
  const visibleTop = canonicalOffsetTop.value
  const visibleBottom = canonicalOffsetTop.value + canonicalVisibleHeight.value

  lines.value = [
    ['window.innerHeight', fmt(innerH)],
    ['window.innerWidth', fmt(innerW)],
    ['window.screen.height', fmt(screenH)],
    ['window.screen.width', fmt(screenW)],
    ['documentElement.clientWidth', fmt(clientW)],
    ['devicePixelRatio', fmt(dpr)],
    ['visualViewport.pageTop (not tracked by the module)', fmt(vvPageTop)],
    ['--- window.Telegram.WebApp (raw, independent cross-check) ---', ''],
    ['WebApp.viewportHeight', wa.vh],
    ['WebApp.viewportStableHeight', wa.vsh],
    ['WebApp.isExpanded', wa.exp],
    ['--- useViewportGeometry canonical refs (the ONE reader) ---', ''],
    ['visibleHeight', fmt(canonicalVisibleHeight.value)],
    ['viewportOffsetTop', fmt(canonicalOffsetTop.value)],
    ['keyboardOpen', String(canonicalKeyboardOpen.value)],
    ['keyboardSignal (WHICH signal decided it)', canonicalKeyboardSignal.value],
    ['keyboardRestHeight (PROMPT №663 baseline)', fmt(canonicalRestHeight.value)],
    [
      'baseline delta (restHeight - visibleHeight)',
      fmt(canonicalRestHeight.value - canonicalVisibleHeight.value),
    ],
    ['visible rect: top (=offsetTop)', fmt(visibleTop)],
    ['visible rect: bottom (=offset+visibleHeight)', fmt(visibleBottom)],
    ['--- CSS vars / classes published by the module ---', ''],
    ['--velo-frozen-vh', frozenVh],
    ['--velo-vvh', veloVvh],
    ['--velo-vv-offset', veloVvOffset],
    ['html.is-keyboard-open present', String(htmlKbOpen)],
    ['.diary-feed--composing present', String(composingOn)],
    ['--- composer element ---', ''],
    [
      'composer computed bottom (expect "auto": normal-flow row since №663, not bottom-pinned)',
      composerBottom,
    ],
    ['composer rect.top', rect ? fmt(rect.top) : 'n/a (not mounted)'],
    ['composer rect.bottom', rect ? fmt(rect.bottom) : 'n/a (not mounted)'],
  ]
}

function schedule(): void {
  if (rafId) return
  rafId = window.requestAnimationFrame(() => {
    rafId = 0
    collect()
  })
}

onMounted(() => {
  vv = window.visualViewport ?? null
  collect()
  vv?.addEventListener('resize', schedule)
  vv?.addEventListener('scroll', schedule)
  intervalId = window.setInterval(collect, POLL_MS)
})

onBeforeUnmount(() => {
  vv?.removeEventListener('resize', schedule)
  vv?.removeEventListener('scroll', schedule)
  window.clearInterval(intervalId)
  if (rafId) window.cancelAnimationFrame(rafId)
})
</script>

<style scoped>
/* Plain literal values only -- see the file header. This box must survive a
   bug in --velo-frozen-vh / --velo-vvh / is-keyboard-open, since those are
   exactly what it is measuring.
   PROMPT №663 (owner-ruled, after seeing it on his phone): shrunk font/
   padding/line-height so the whole field list fits without covering most of
   the screen -- his own report was the panel covering ~830px of an 828px
   viewport, cutting off exactly the field he needed to read.
   PROMPT №665: `max-height` changed from `30vh` to a FIXED `300px`. `vh`
   tracks the live viewport -- exactly the thing this panel measures -- so a
   `vh` cap made the panel itself resize between keyboard-open and
   keyboard-closed, the owner's second report. NO `vh`/`dvh`/`lvh`/`svh`/`%`
   anywhere in this file, on purpose: this box must survive a bug in the very
   numbers it prints, and a relative unit here would make it one more thing
   that could be wrong at the moment it's needed. 300px comfortably holds the
   full field list at the current 8px/1.3 sizing without scrolling on a
   typical device; overflow-y:auto stays as the safety valve if the list
   grows past that again. */
.kbd-debug {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 999999;
  max-height: 300px;
  overflow-y: auto;
  background: #000000;
  color: #00ff66;
  font-family: 'Courier New', Consolas, monospace;
  font-size: 8px;
  line-height: 1.3;
  padding: 4px 6px;
  pointer-events: none;
}

.kbd-debug__row {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  white-space: nowrap;
}

.kbd-debug__k {
  color: #7fd9ff;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kbd-debug__v {
  color: #00ff66;
  font-weight: 700;
}
</style>
