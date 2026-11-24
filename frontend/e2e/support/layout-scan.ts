/**
 * The layout detector's scan (FE-240), run INSIDE the page by
 * page.evaluate(scanLayout, args): it is serialized, so it closes over
 * nothing of this module -- every helper is declared inside it.
 *
 * Rules:
 * - `overflow`  content past the viewport's left or right edge (the page
 *               scrolls sideways, or the text is cut off), past the side of
 *               the card it sits in, or text cut off mid-word by a box that
 *               hides its overflow without an ellipsis. A horizontal scroller
 *               (a carousel) is exempt: its content is meant to be wider.
 * - `overlap`   two text blocks drawn over each other.
 * - `small-target`   a control smaller than `targetPx` on a side. Its tap
 *               area counts a ::before / ::after grown around it (a hit area
 *               larger than the drawing) unless that layer ignores the
 *               pointer. A link inside running text is exempt (WCAG 2.5.8).
 * - `covered-target` another element on top of a control's center: a tap
 *               there does not reach it. A bar floating over the scroll (the
 *               tab bar, a sticky header) is the `tabbar` rule's business.
 * - `tabbar`    content that stays under a bar resting on the bottom (the tab
 *               bar, a sticky action) even when scrolled to the end.
 * - `safe-area` content in the top band Telegram's controls cover (at the
 *               top of the scroll), or in the bottom band of the home
 *               indicator (at its end).
 *
 * "Content" is what a person reads or taps: a text block, a control, an
 * image, an icon. Backgrounds and decoration (`alt=""`, `aria-hidden`) may go
 * anywhere. The whole screen is judged, not its first view: the geometric
 * rules ignore the clipping of a scroll container (what it hides is reached
 * by scrolling), and the covered-target check pages through the scroll.
 */
import type { LayoutRule } from './layout-allowance'

/** The bands content must stay out of, CSS px from each edge. */
export interface SafeBands {
  top: number
  bottom: number
}

/** Arguments of the scan. */
export interface ScanArgs {
  bands: SafeBands
  targetPx: number
}

/** One finding of the scan. */
export interface ScanFinding {
  rule: LayoutRule
  /** The element at fault: `tag#id.class [testid] "text"`. */
  element: string
  /** What is wrong with it, with the measured numbers. */
  detail: string
  /** `small-target`: the tap area measured. */
  measured?: { width: number; height: number }
}

/** Run in the page. Leaves every scroll container where it was. */
export function scanLayout({ bands, targetPx }: ScanArgs): ScanFinding[] {
  type Box = { left: number; top: number; right: number; bottom: number }
  /** Which clipping counts: only what hides overflow, or scroll containers too. */
  type ClipMode = 'layout' | 'view'

  const out: ScanFinding[] = []
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  const EPS = 1
  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=tab]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=switch]',
    '[role=menuitem]',
    '[role=option]',
  ].join(',')
  /** Pictures that carry meaning: a decorative image says so with alt="". */
  const MEDIA = 'img:not([alt=""]), svg, video, canvas, picture'
  /** A notice that shows for a moment and goes: never a bar content must clear. */
  const TRANSIENT = '.v-toast-container, [aria-live], [role=status], [role=alert]'

  // --- geometry helpers ------------------------------------------------------------
  const styles = new Map<Element, CSSStyleDeclaration>()
  const style = (el: Element): CSSStyleDeclaration => {
    let s = styles.get(el)
    if (!s) styles.set(el, (s = getComputedStyle(el)))
    return s
  }
  const INFINITE: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  })
  const unite = (a: Box, b: Box): Box => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  })
  const width = (b: Box): number => Math.max(0, b.right - b.left)
  const height = (b: Box): number => Math.max(0, b.bottom - b.top)
  const rectOf = (el: Element): Box => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  const round = Math.round
  const scrolls = (v: string): boolean => v === 'auto' || v === 'scroll'

  // --- element helpers -------------------------------------------------------------
  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase()
    // Ids from Vue's useId() (`v-0-1-2`) change with the render order.
    const id = el.id && !/^v-[\d-]+$/.test(el.id) ? `#${el.id}` : ''
    const cls = [...el.classList]
      .filter((c) => !/^(v-(enter|leave)|router-link)/.test(c))
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join('')
    const testid = el.closest('[data-testid]')?.getAttribute('data-testid')
    const text = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 32)
    return `${tag}${id}${cls}${testid ? ` [${testid}]` : ''}${text ? ` "${text}"` : ''}`
  }

  /** Not drawn at all: display/visibility/opacity, an inert or hidden subtree. */
  function hidden(el: Element): boolean {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true
    return !!el.closest('[inert], [aria-hidden=true]')
  }

  /** The element's own position, or the nearest fixed/sticky ancestor's. */
  function layerOf(el: Element): Element | null {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const p = style(e).position
      if (p === 'fixed' || p === 'sticky') return e
    }
    return null
  }

  /** The element that scrolls `el` vertically: an ancestor, or the document. */
  function scrollerOf(el: Element): Element {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      if (scrolls(style(e).overflowY)) return e
    }
    return document.documentElement
  }

  /**
   * Whether `t` floats over `el`'s scroll instead of scrolling with it: it is
   * outside `el`'s scroller (the tab bar beside the screen's <main>), or in a
   * fixed or sticky layer `el` is not in.
   */
  function floats(t: Element, el: Element): boolean {
    const scroller = scrollerOf(el)
    if (scroller !== document.documentElement && !scroller.contains(t)) return true
    const layer = layerOf(t)
    return layer !== null && layer !== layerOf(el)
  }

  /**
   * The area the ancestors of `el` (and `el` itself, with `self`) let show:
   * the intersection of the boxes that clip their overflow. In `layout` mode
   * a scroll container and everything above it do not clip -- what they hide
   * is reached by scrolling; in `view` mode they do (what is on screen now).
   */
  function clipOf(el: Element, self: boolean, mode: ClipMode): Box {
    let b = INFINITE
    const fixed = style(el).position === 'fixed'
    for (
      let e = self ? el : el.parentElement;
      e && e !== document.documentElement;
      e = e.parentElement
    ) {
      if (fixed && e !== el && !e.contains(el)) break
      const s = style(e)
      // What a scroll container hides is reached by scrolling, and so is
      // what its own ancestors cut off: in `layout` mode the walk ends there.
      if (mode === 'layout' && e !== el && (scrolls(s.overflowX) || scrolls(s.overflowY))) break
      const clips = (v: string): boolean => v !== 'visible' && (mode === 'view' || !scrolls(v))
      const clipsX = clips(s.overflowX)
      const clipsY = clips(s.overflowY)
      if (clipsX || clipsY) {
        const r = rectOf(e)
        b = intersect(b, {
          left: clipsX ? r.left : -Infinity,
          right: clipsX ? r.right : Infinity,
          top: clipsY ? r.top : -Infinity,
          bottom: clipsY ? r.bottom : Infinity,
        })
      }
      if (s.position === 'fixed') break
    }
    return b
  }

  /** The part of `el`'s box no ancestor clips away. */
  const visibleBox = (el: Element, mode: ClipMode): Box =>
    intersect(rectOf(el), clipOf(el, false, mode))

  /** Visually hidden on purpose (the sr-only pattern) or too small to see. */
  const srOnly = (b: Box): boolean => width(b) <= 2 || height(b) <= 2

  /**
   * The area a tap reaches `el` in: its box, grown by a ::before / ::after
   * placed around it with px insets (`position: absolute; inset: -8px` -- a
   * hit area larger than what is drawn). A layer that ignores the pointer is
   * decoration, not a hit area.
   */
  function hitBox(el: Element): Box {
    const r = rectOf(el)
    let hit = r
    for (const pseudo of ['::before', '::after']) {
      const s = getComputedStyle(el, pseudo)
      if (s.content === 'none' || s.display === 'none' || s.position !== 'absolute') continue
      if (s.pointerEvents === 'none') continue
      const sides = [s.top, s.right, s.bottom, s.left]
      if (!sides.every((v) => v.endsWith('px'))) continue
      const [top, right, bottom, left] = sides.map((v) => parseFloat(v)) as [
        number,
        number,
        number,
        number,
      ]
      hit = unite(hit, {
        left: r.left + left,
        top: r.top + top,
        right: r.right - right,
        bottom: r.bottom - bottom,
      })
    }
    return hit
  }

  /**
   * Inside an element that scrolls sideways by design: a carousel, a chip
   * row, a wide table. A vertical scroller (the screen's <main>) scrolls
   * sideways too once something is too wide -- CSS turns its overflow-x to
   * auto with overflow-y -- so the design is told by the layout: a row
   * (flex row, a grid flowing in columns, nowrap text), or no vertical
   * scrolling at all.
   */
  function inHorizontalScroller(el: Element): boolean {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = style(e)
      if (!scrolls(s.overflowX) || e.scrollWidth <= e.clientWidth) continue
      const row =
        (s.display.endsWith('flex') && s.flexDirection.startsWith('row')) ||
        (s.display.endsWith('grid') && s.gridAutoFlow.startsWith('column')) ||
        s.whiteSpace === 'nowrap' ||
        s.overflowY === 'hidden' ||
        s.overflowY === 'clip'
      if (row) return true
    }
    return false
  }

  /** A link that is a part of a sentence: its block has text besides it. */
  function inlineLink(el: Element): boolean {
    if (el.tagName !== 'A' || style(el).display !== 'inline') return false
    let block = el.parentElement
    while (block && style(block).display === 'inline') block = block.parentElement
    const own = ((el as HTMLElement).innerText || '').trim().length
    return !!block && (block.innerText || '').trim().length > own
  }

  /** A small absolutely placed element (a counter, a dot) that may sit over a label. */
  function inBadge(el: Element): boolean {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      if (style(e).position !== 'absolute') continue
      const r = rectOf(e)
      return width(r) <= 24 && height(r) <= 24
    }
    return false
  }

  // --- collect -------------------------------------------------------------------
  // The whole body: overlays and the tab bar may be teleported out of the app root.
  const all = [...document.body.querySelectorAll('*')].filter((el) => !hidden(el))

  /** Elements with their own text, and the line boxes of that text. */
  const texts: Array<{ el: Element; rects: Box[] }> = []
  /** Where an element's own text is drawn, even past its box (FE-173). */
  const ink = new Map<Element, Box>()
  /** The same text before any box clipped it (to tell text cut off). */
  const rawInk = new Map<Element, Box>()
  for (const el of all) {
    if (el.closest('svg, style, script, noscript, template')) continue
    const rects: Box[] = []
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) {
          rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
        }
      }
    }
    if (rects.length === 0) continue
    rawInk.set(el, rects.reduce(unite))
    // Text runs on past a box that is too narrow; only a clipping box (the
    // element's own overflow, or an ancestor's) hides it.
    const clip = clipOf(el, true, 'layout')
    const shown = rects.map((r) => intersect(r, clip)).filter((r) => !srOnly(r))
    if (shown.length === 0) continue
    ink.set(el, shown.reduce(unite))
    texts.push({ el, rects: shown })
  }

  const controls = all.filter((el) => {
    if (!el.matches(INTERACTIVE)) return false
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
      return false
    }
    // A control inside another control: the outer one is the target.
    return !el.parentElement?.closest(INTERACTIVE)
  })
  const media = all.filter((el) => el.matches(MEDIA) && !el.parentElement?.closest('svg'))

  /** Everything a person reads or taps, once, with its box as laid out. */
  const content = new Map<Element, Box>()
  for (const el of [...texts.map((t) => t.el), ...controls, ...media]) {
    if (content.has(el)) continue
    const b = visibleBox(el, 'layout')
    if (!srOnly(b)) content.set(el, b)
  }

  // --- rules ---------------------------------------------------------------------
  function overflow(): void {
    const pageWidth = document.documentElement.scrollWidth
    const culprits = new Set<Element>()
    for (const [el, b] of content) {
      if (inHorizontalScroller(el)) continue
      const rect = rectOf(el)
      const text = ink.get(el)
      const own = text
        ? { ...rect, left: Math.min(rect.left, text.left), right: Math.max(rect.right, text.right) }
        : rect
      // Past the viewport, whether the page then scrolls sideways or an
      // ancestor cuts it off.
      if (own.right > vw + EPS || own.left < -EPS) {
        if (width(b) > 0 || height(b) > 0) culprits.add(el)
        continue
      }
      // Text cut off by a box that hides its overflow, with no ellipsis to
      // say so.
      const raw = rawInk.get(el)
      if (raw && text && (raw.right > text.right + EPS || raw.left < text.left - EPS)) {
        let ellipsis = false
        for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
          if (style(e).textOverflow === 'ellipsis') ellipsis = true
          if (style(e).overflowX !== 'visible') break
        }
        if (!ellipsis) {
          out.push({
            rule: 'overflow',
            element: describe(el),
            detail: `text cut off: drawn x ${round(raw.left)}..${round(raw.right)}, shown ${round(text.left)}..${round(text.right)}`,
          })
          continue
        }
      }
      // Past the side of the card it sits in (a surface: a background, a
      // border or a shadow). An absolutely placed badge may stick out.
      if (['absolute', 'fixed'].includes(style(el).position)) continue
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const s = style(e)
        if (s.position === 'absolute' || s.position === 'fixed') break
        const surface =
          s.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
          parseFloat(s.borderLeftWidth) > 0 ||
          s.boxShadow !== 'none'
        if (!surface) continue
        const r = rectOf(e)
        if (own.right > r.right + EPS || own.left < r.left - EPS) {
          out.push({
            rule: 'overflow',
            element: describe(el),
            detail: `spans x ${round(own.left)}..${round(own.right)}, its card ${describe(e).split(' ')[0]} x ${round(r.left)}..${round(r.right)}`,
          })
        }
        break
      }
    }
    // The outermost culprits only: a row that is too wide drags its
    // children along, the row is the bug.
    for (const el of culprits) {
      let parent = el.parentElement
      while (parent && !content.has(parent)) parent = parent.parentElement
      if (parent && culprits.has(parent)) continue
      const r = rectOf(el)
      out.push({
        rule: 'overflow',
        element: describe(el),
        detail: `spans x ${round(r.left)}..${round(r.right)} in a ${vw} px viewport${pageWidth > vw + EPS ? ` (page ${pageWidth} px wide)` : ''}`,
      })
    }
    if (pageWidth > vw + EPS && culprits.size === 0) {
      out.push({
        rule: 'overflow',
        element: 'html',
        detail: `page ${pageWidth} px wide in a ${vw} px viewport`,
      })
    }
  }

  function overlap(): void {
    for (let i = 0; i < texts.length; i++) {
      const a = texts[i]!
      for (let j = i + 1; j < texts.length; j++) {
        const b = texts[j]!
        let hit: Box | null = null
        for (const ra of a.rects) {
          for (const rb of b.rects) {
            const x = intersect(ra, rb)
            // Glyph boxes of adjacent lines may touch or graze; text drawn
            // over text overlaps by a real share of the smaller line.
            const minH = Math.min(height(ra), height(rb))
            if (width(x) > 2 && height(x) > Math.max(2, minH * 0.3)) hit = x
          }
        }
        if (!hit) continue
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        // A bar floating over the scroll covers content by design (the
        // `tabbar` rule asks whether content gets out from under it); a
        // counter on a label's corner is drawn there on purpose.
        if (floats(a.el, b.el) || floats(b.el, a.el)) continue
        if (inBadge(a.el) || inBadge(b.el)) continue
        out.push({
          rule: 'overlap',
          element: describe(a.el),
          detail: `drawn over ${describe(b.el)} (${round(width(hit))}x${round(height(hit))} px)`,
        })
      }
    }
  }

  function smallTargets(): void {
    for (const el of controls) {
      if (!content.has(el) || inlineLink(el)) continue
      const hit = hitBox(el)
      if (width(hit) >= targetPx - 0.5 && height(hit) >= targetPx - 0.5) continue
      out.push({
        rule: 'small-target',
        element: describe(el),
        detail: `${round(width(hit))}x${round(height(hit))} px, under ${targetPx}x${targetPx}`,
        measured: { width: round(width(hit)), height: round(height(hit)) },
      })
    }
  }

  /** Content in the top band, at the top of the scroll. */
  function topBand(): void {
    for (const el of content.keys()) {
      const b = visibleBox(el, 'view')
      if (srOnly(b) || b.bottom <= 0 || b.top >= vh) continue
      if (b.top < bands.top - EPS) {
        out.push({
          rule: 'safe-area',
          element: describe(el),
          detail: `top at ${round(b.top)} px, inside the top ${bands.top} px Telegram's controls cover`,
        })
      }
    }
  }

  /** Controls on screen now whose center something else covers. */
  const covered = new Set<Element>()
  function coveredTargets(): void {
    for (const el of controls) {
      if (covered.has(el) || !content.has(el)) continue
      const b = visibleBox(el, 'view')
      if (srOnly(b)) continue
      const cx = (b.left + b.right) / 2
      const cy = (b.top + b.bottom) / 2
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue
      covered.add(el)
      const top = document.elementFromPoint(cx, cy)
      if (!top || el.contains(top) || top.contains(el) || floats(top, el)) continue
      out.push({
        rule: 'covered-target',
        element: describe(el),
        detail: `covered at its center by ${describe(top)}`,
      })
    }
  }

  /** At the end of the scroll: content under a bottom bar, or on the home indicator. */
  function bottomEdge(): void {
    // Positioned elements as wide as half the screen, resting at its
    // bottom: the tab bar, a sticky action bar.
    const bars = all.filter((el) => {
      if (!['fixed', 'absolute', 'sticky'].includes(style(el).position)) return false
      if (el.closest(TRANSIENT)) return false
      const r = rectOf(el)
      return r.top > vh / 2 && r.bottom > vh - 120 && width(r) >= vw / 2 && height(r) > 0
    })
    for (const el of content.keys()) {
      const b = visibleBox(el, 'view')
      if (srOnly(b) || b.bottom <= 0 || b.top >= vh) continue
      for (const bar of bars) {
        if (bar.contains(el) || !floats(bar, el)) continue
        const x = intersect(b, rectOf(bar))
        if (width(x) > 0 && height(x) > EPS) {
          out.push({
            rule: 'tabbar',
            element: describe(el),
            detail: `stays ${round(height(x))} px under ${describe(bar).split(' ')[0]} scrolled to the end`,
          })
          break
        }
      }
      if (bands.bottom > 0 && b.bottom > vh - bands.bottom + EPS) {
        out.push({
          rule: 'safe-area',
          element: describe(el),
          detail: `bottom at ${round(b.bottom)} px, inside the bottom ${bands.bottom} px of the home indicator (viewport ${vh})`,
        })
      }
    }
  }

  // --- run -----------------------------------------------------------------------
  overflow()
  overlap()
  smallTargets()

  // Page through the scroll: covered controls are checked where they come on
  // screen, the bottom edge at the end. `instant`, so a smooth-scrolling
  // container is measured where it is told to be.
  const scrollers = [document.documentElement, ...all].filter(
    (e) =>
      e.scrollHeight > e.clientHeight + EPS &&
      (e === document.documentElement || scrolls(style(e).overflowY)),
  )
  const saved = scrollers.map((e) => e.scrollTop)
  const to = (e: Element, top: number): void => e.scrollTo({ top, behavior: 'instant' })
  scrollers.forEach((e) => to(e, 0))
  topBand()
  const step = Math.max(vh * 0.8, 100)
  const longest = Math.max(0, ...scrollers.map((e) => e.scrollHeight - e.clientHeight))
  const pages = Math.min(Math.ceil(longest / step), 30)
  for (let i = 0; i <= pages; i++) {
    for (const e of scrollers) to(e, Math.min(i * step, e.scrollHeight - e.clientHeight))
    coveredTargets()
  }
  scrollers.forEach((e) => to(e, e.scrollHeight))
  bottomEdge()
  scrollers.forEach((e, i) => to(e, saved[i]!))
  // One finding per rule + element + detail.
  const seen = new Set<string>()
  return out.filter((f) => {
    const key = `${f.rule}|${f.element}|${f.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
