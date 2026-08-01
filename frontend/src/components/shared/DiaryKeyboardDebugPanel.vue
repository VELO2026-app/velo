<!--
  TEMPORARY DIAGNOSTIC -- PROMPT №654 (T24-1/B29). NOT design-system UI: do not
  theme it, do not keep it. Ships to prod for ONE device screenshot from the
  owner's Android with the diary composer open, then gets removed in a
  follow-up commit (see the removal note in this prompt's commit body).

  Visibility: mounted by DiaryFeedView.vue behind `authStore.role === 'admin'`
  only -- the owner's own account, no separate switch to flip. A normal user
  role never sees this file execute.

  Every value below is READ-ONLY: it queries window/document/CSS state and the
  SAME isKeyboardOpen/nativeKeyboardDelta functions the real mechanism calls,
  but never writes a style, a class, or a listener onto .diary-feed /
  .diary-feed__composer / #app / html -- the elements under test. Its own box
  is `position: fixed; top: 0` in plain, literal pixel values (no --velo-* var,
  no design token) so a bug in the thing being diagnosed cannot also mis-place
  the diagnostic itself.
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
import { viewport } from '@tma.js/sdk-vue'
import { KEYBOARD_VIEWPORT_THRESHOLD } from '@/utils/constants'
import { isKeyboardOpen, nativeKeyboardDelta } from '@/utils/keyboardDetection'

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
  const vvH = vv?.height ?? null
  const vvOffsetTop = vv?.offsetTop ?? null
  const vvPageTop = (vv as unknown as { pageTop?: number } | null)?.pageTop ?? null

  const browserDelta = vvH !== null ? innerH - vvH : null

  const tmaMounted = viewport.isMounted()
  const tmaStable = tmaMounted ? viewport.isStable() : null
  const tmaHeight = tmaMounted ? viewport.height() : null
  const tmaStableHeight = tmaMounted ? viewport.stableHeight() : null
  const nativeDelta = nativeKeyboardDelta()
  const usedBranch = nativeDelta !== null ? 'NATIVE' : 'BROWSER'
  const kbOpen =
    vvH !== null ? isKeyboardOpen(nativeDelta, innerH, vvH, KEYBOARD_VIEWPORT_THRESHOLD) : null

  const wa = readTelegramWebApp()

  const root = document.documentElement
  const frozenVh = getComputedStyle(root).getPropertyValue('--velo-frozen-vh').trim() || '(unset)'
  const veloVvh = getComputedStyle(root).getPropertyValue('--velo-vvh').trim() || '(unset)'
  const htmlKbOpen = root.classList.contains('is-keyboard-open')

  const feedEl = document.querySelector('.diary-feed')
  const composingOn = feedEl?.classList.contains('diary-feed--composing') ?? false
  const composerEl = document.querySelector('.diary-feed__composer') as HTMLElement | null
  const composerBottom = composerEl ? getComputedStyle(composerEl).bottom : 'n/a (not mounted)'
  const rect = composerEl?.getBoundingClientRect() ?? null

  lines.value = [
    ['window.innerHeight', fmt(innerH)],
    ['window.screen.height', fmt(screenH)],
    ['devicePixelRatio', fmt(dpr)],
    ['visualViewport.height', fmt(vvH)],
    ['visualViewport.offsetTop', fmt(vvOffsetTop)],
    ['visualViewport.pageTop', fmt(vvPageTop)],
    ['browserDelta (inner - vv.h)', fmt(browserDelta)],
    ['KEYBOARD_VIEWPORT_THRESHOLD', fmt(KEYBOARD_VIEWPORT_THRESHOLD)],
    ['--- @tma.js/sdk-vue viewport ---', ''],
    ['viewport.isMounted()', String(tmaMounted)],
    ['viewport.isStable()', String(tmaStable)],
    ['viewport.height()', fmt(tmaHeight)],
    ['viewport.stableHeight()', fmt(tmaStableHeight)],
    ['nativeDelta (stable - height)', fmt(nativeDelta)],
    ['isKeyboardOpen USED BRANCH', usedBranch],
    ['isKeyboardOpen() result', String(kbOpen)],
    ['--- window.Telegram.WebApp (raw) ---', ''],
    ['WebApp.viewportHeight', wa.vh],
    ['WebApp.viewportStableHeight', wa.vsh],
    ['WebApp.isExpanded', wa.exp],
    ['--- CSS vars / classes ---', ''],
    ['--velo-frozen-vh', frozenVh],
    ['--velo-vvh', veloVvh],
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
