<!--
  TEMPORARY DIAGNOSTIC -- PROMPT №654/656/657 (T24-1/B29). NOT design-system
  UI: do not theme it, do not keep it. Ships to prod for ONE device
  screenshot from the owner's Android with the diary composer open, then gets
  removed in a follow-up commit (see the removal note in this prompt's commit
  body).

  Visibility: mounted by DiaryFeedView.vue behind a hidden tap gesture on the
  title (persisted in localStorage) -- see DiaryFeedView.vue's onTitleTap.

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
  const screenH = window.screen?.height
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
    ['window.screen.height', fmt(screenH)],
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
    ['visible rect: top (=offsetTop)', fmt(visibleTop)],
    ['visible rect: bottom (=offset+visibleHeight)', fmt(visibleBottom)],
    ['--- CSS vars / classes published by the module ---', ''],
    ['--velo-frozen-vh', frozenVh],
    ['--velo-vvh', veloVvh],
    ['--velo-vv-offset', veloVvOffset],
    ['html.is-keyboard-open present', String(htmlKbOpen)],
    ['.diary-feed--composing present', String(composingOn)],
    ['--- composer element ---', ''],
    ['composer computed bottom', composerBottom],
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
   exactly what it is measuring. */
.kbd-debug {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 999999;
  max-height: 55vh;
  overflow-y: auto;
  background: #000000;
  color: #00ff66;
  font-family: 'Courier New', Consolas, monospace;
  font-size: 10px;
  line-height: 1.5;
  padding: 6px 8px;
  pointer-events: none;
}

.kbd-debug__row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
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
