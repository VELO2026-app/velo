/**
 * Layout detector (FE-240): geometric invariants of a rendered screen, the
 * class of bug happy-dom cannot see and the crash detector does not look for
 * (FE-173: a date drawn over a time; a header under Telegram's controls; a
 * button under the tab bar). No reference images: every rule is a property
 * any screen must have, read from the live layout after the screen settled.
 *
 * Rules (`LayoutRule`):
 * - `overflow`  content past the viewport's left or right edge (the page
 *               scrolls sideways, or the text is cut off), or past the side
 *               of the card it sits in. A horizontal scroller (a carousel)
 *               is exempt: its content is meant to be wider.
 * - `overlap`   two text blocks drawn over each other.
 * - `small-target`   a control smaller than TARGET_PX on a side. Its tap
 *               area counts a ::before / ::after grown around it (a hit area
 *               larger than the drawing). An inline link inside running text
 *               is exempt (WCAG 2.5.8).
 * - `covered-target` another element on top of a control's center: a tap
 *               there does not reach it.
 * - `tabbar`    content that stays under a bar fixed to the bottom (the tab
 *               bar, a sticky action) even when scrolled to the end.
 * - `safe-area` content in the top band Telegram's controls cover, or in the
 *               bottom band of the home indicator.
 *
 * "Content" is what a person reads or taps: a text block, a control, an
 * image, an icon. Backgrounds and decoration may go anywhere.
 *
 * The scan runs at each size of LAYOUT_SIZES on one loaded page: the
 * viewport is resized, Telegram's stub reports the new viewport, the layout
 * settles, the scan runs. Findings that an allowlist entry
 * (./layout-allowlist.ts) accepts are dropped; the rest become crash
 * detector signals of kind `layout`.
 */
import type { Page } from '@playwright/test'
import type { CrashSignal, Crashes } from './crashes'
import { IPHONE_FULLSCREEN } from './fixtures'
import type { LayoutAllowance, LayoutRule } from './layout-allowance'
import { LAYOUT_ALLOWLIST } from './layout-allowlist'

export type { LayoutAllowance, LayoutRule }

/** A screen size the detector checks. */
export interface LayoutSize {
  width: number
  height: number
}

/**
 * The three widths of FE-240: a narrow phone (iPhone SE 1st gen), the
 * common one (iPhone 12-16), a wide one (iPhone Pro Max).
 */
export const LAYOUT_SIZES: readonly LayoutSize[] = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 430, height: 932 },
]

/** The smallest side of a tap target, CSS px (Apple HIG, WCAG 2.5.5). */
export const TARGET_PX = 44

/** The bands content must stay out of, CSS px from each edge. */
export interface SafeBands {
  top: number
  bottom: number
}

/**
 * The bands of Telegram on an iPhone in fullscreen (IPHONE_FULLSCREEN). Top:
 * Telegram's controls -- the clearance useSafeArea.ts measured on a device
 * (status bar 44 + controls 46, less the 20 px the two overlap). Bottom: the
 * home indicator.
 */
export const TELEGRAM_BANDS: SafeBands = {
  top: IPHONE_FULLSCREEN.safe.top + IPHONE_FULLSCREEN.content.top - 20,
  bottom: IPHONE_FULLSCREEN.safe.bottom,
}

/** One breakage at one size, before the allowlist. */
export interface LayoutFinding {
  rule: LayoutRule
  /** The element at fault: `tag#id.class [testid] "text"`. */
  element: string
  /** What is wrong with it, with the measured numbers. */
  detail: string
  /** `390x844`. */
  size: string
}

/** Whether one of `allowances` accepts `finding` on route `route`. */
export function isLayoutAllowed(
  finding: LayoutFinding,
  route: string,
  allowances: readonly LayoutAllowance[],
): boolean {
  const width = Number(finding.size.split('x')[0])
  return allowances.some(
    (a) =>
      a.rules.includes(finding.rule) &&
      (!a.routes || a.routes.includes(route)) &&
      (!a.element || a.element.test(finding.element)) &&
      (!a.widths || a.widths.includes(width)),
  )
}

/** Findings per rule beyond which a signal says "and N more". */
const MAX_PER_RULE = Number(process.env.LAYOUT_MAX ?? 8)

/**
 * The findings as crash-detector signals: one per rule + element + detail,
 * with the sizes it shows at, capped at MAX_PER_RULE per rule.
 */
export function layoutSignals(findings: readonly LayoutFinding[], path: string): CrashSignal[] {
  const merged = new Map<string, { finding: LayoutFinding; sizes: string[] }>()
  for (const f of findings) {
    const key = `${f.rule}|${f.element}|${f.detail}`
    const seen = merged.get(key)
    if (seen) seen.sizes.push(f.size)
    else merged.set(key, { finding: f, sizes: [f.size] })
  }
  const perRule = new Map<LayoutRule, number>()
  const signals: CrashSignal[] = []
  for (const { finding, sizes } of merged.values()) {
    const n = (perRule.get(finding.rule) ?? 0) + 1
    perRule.set(finding.rule, n)
    if (n > MAX_PER_RULE) continue
    signals.push({
      kind: 'layout',
      message: `${finding.rule} @${sizes.join(',')}: ${finding.element} -- ${finding.detail}`,
      path,
    })
  }
  for (const [rule, n] of perRule) {
    if (n > MAX_PER_RULE) {
      signals.push({ kind: 'layout', message: `${rule}: and ${n - MAX_PER_RULE} more`, path })
    }
  }
  return signals
}

/**
 * Judge the screen of `route` (a sweep route name) at every size of `sizes`
 * and hand what LAYOUT_ALLOWLIST leaves to the crash detector,
 * which fails the test with it.
 */
export async function checkLayout(
  page: Page,
  crashes: Crashes,
  route: string,
  sizes: readonly LayoutSize[] = LAYOUT_SIZES,
): Promise<void> {
  const path = new URL(page.url()).pathname
  const findings = (await inspectLayout(page, TELEGRAM_BANDS, sizes)).filter(
    (f) => !isLayoutAllowed(f, route, LAYOUT_ALLOWLIST),
  )
  for (const signal of layoutSignals(findings, path)) crashes.record(signal)
}

/**
 * Scan the page at every size of `sizes`. Leaves the page at the last size
 * and scrolled back to where it was.
 */
export async function inspectLayout(
  page: Page,
  bands: SafeBands,
  sizes: readonly LayoutSize[] = LAYOUT_SIZES,
): Promise<LayoutFinding[]> {
  const findings: LayoutFinding[] = []
  for (const size of sizes) {
    await page.setViewportSize(size)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await layoutSettled(page)
    const label = `${size.width}x${size.height}`
    for (const f of await page.evaluate(scanLayout, { bands, targetPx: TARGET_PX })) {
      findings.push({ ...f, size: label })
    }
  }
  return findings
}

/** How long a resized screen may keep moving before it is judged as it stands. */
const SETTLE_CEILING_MS = 1_500

/**
 * Wait until the geometry stops changing: the boxes of all elements are the
 * same on two animation frames in a row. A resize reflows on the next frame,
 * but what the app recomputes on it (Telegram's viewport_changed, a resize
 * observer, a transition) lands later. A screen that never settles (an
 * endless animation) is judged as it stands after SETTLE_CEILING_MS.
 */
async function layoutSettled(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        let hash = 0
        for (const el of document.body.querySelectorAll('*')) {
          const r = el.getBoundingClientRect()
          hash = (hash * 31 + Math.round(r.left * 7 + r.top * 13 + r.width * 17 + r.height)) | 0
        }
        const w = window as unknown as { __veloLayoutHash?: number }
        const same = w.__veloLayoutHash === hash
        w.__veloLayoutHash = hash
        return same
      },
      undefined,
      { polling: 'raf', timeout: SETTLE_CEILING_MS },
    )
    .catch(() => {})
}

/** Arguments of the in-page scan. */
interface ScanArgs {
  bands: SafeBands
  targetPx: number
}

/**
 * The scan itself, run INSIDE the page (serialized by page.evaluate: no
 * closure over this module, every helper is declared inside).
 */
export function scanLayout({ bands, targetPx }: ScanArgs): Array<Omit<LayoutFinding, 'size'>> {
  type Box = { left: number; top: number; right: number; bottom: number }
  const out: Array<Omit<LayoutFinding, 'size'>> = []
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
  const MEDIA = 'img, svg, video, canvas, picture'
  /** A notice that shows for a moment and goes: never a bar content must clear. */
  const TRANSIENT = '.v-toast-container, [aria-live], [role=status], [role=alert]'

  const styles = new Map<Element, CSSStyleDeclaration>()
  const style = (el: Element): CSSStyleDeclaration => {
    let s = styles.get(el)
    if (!s) styles.set(el, (s = getComputedStyle(el)))
    return s
  }
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  })
  const width = (b: Box): number => Math.max(0, b.right - b.left)
  const height = (b: Box): number => Math.max(0, b.bottom - b.top)
  const box = (r: DOMRect): Box => ({
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
  })
  const round = (n: number): number => Math.round(n)

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
      if (['auto', 'scroll'].includes(style(e).overflowY)) return e
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
   * the intersection of every box with an overflow other than visible.
   */
  function clipOf(el: Element, self: boolean): Box {
    let b: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
    const fixed = style(el).position === 'fixed'
    const start = self ? el : el.parentElement
    for (let e = start; e && e !== document.documentElement; e = e.parentElement) {
      if (fixed && e !== el && !e.contains(el)) break
      const s = style(e)
      const clipsX = s.overflowX !== 'visible'
      const clipsY = s.overflowY !== 'visible'
      if (clipsX || clipsY) {
        const r = e.getBoundingClientRect()
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
  function visibleBox(el: Element): Box {
    return intersect(box(el.getBoundingClientRect()), clipOf(el, false))
  }

  /**
   * The area a tap reaches `el` in: its box, grown by a ::before / ::after
   * placed around it with px insets (`position: absolute; inset: -8px` -- a
   * hit area larger than what is drawn).
   */
  function hitBox(el: Element): Box {
    const r = box(el.getBoundingClientRect())
    let hit = r
    for (const pseudo of ['::before', '::after']) {
      const s = getComputedStyle(el, pseudo)
      if (s.content === 'none' || s.display === 'none' || s.position !== 'absolute') continue
      const sides = [s.top, s.right, s.bottom, s.left]
      if (!sides.every((v) => v.endsWith('px'))) continue
      const [top, right, bottom, left] = sides.map((v) => parseFloat(v)) as [
        number,
        number,
        number,
        number,
      ]
      hit = {
        left: Math.min(hit.left, r.left + left),
        top: Math.min(hit.top, r.top + top),
        right: Math.max(hit.right, r.right - right),
        bottom: Math.max(hit.bottom, r.bottom - bottom),
      }
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
      if (s.overflowX !== 'auto' && s.overflowX !== 'scroll') continue
      if (e.scrollWidth <= e.clientWidth) continue
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

  /** Visually hidden on purpose (the sr-only pattern) or too small to see. */
  function srOnly(b: Box): boolean {
    return width(b) <= 2 || height(b) <= 2
  }

  // --- collect ------------------------------------------------------------------
  // The whole body: overlays and the tab bar may be teleported out of the app root.
  const root = document.body
  const all = [...root.querySelectorAll('*')].filter((el) => !hidden(el))

  /** Elements with their own text, and the line boxes of that text. */
  const texts: Array<{ el: Element; rects: Box[] }> = []
  /** Where an element's own text is drawn, even past its box (FE-173). */
  const ink = new Map<Element, Box>()
  for (const el of all) {
    if (el.closest('svg, style, script, noscript, template')) continue
    const rects: Box[] = []
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) rects.push(box(r))
      }
    }
    if (rects.length === 0) continue
    // Text runs on past a box that is too narrow; only a clipping box (the
    // element's own overflow, or an ancestor's) hides it.
    const clip = clipOf(el, true)
    const shown = rects.map((r) => intersect(r, clip)).filter((r) => !srOnly(r))
    if (shown.length > 0) {
      ink.set(
        el,
        shown.reduce((u, r) => ({
          left: Math.min(u.left, r.left),
          top: Math.min(u.top, r.top),
          right: Math.max(u.right, r.right),
          bottom: Math.max(u.bottom, r.bottom),
        })),
      )
    }
    if (shown.length > 0) texts.push({ el, rects: shown })
  }

  const controls = all.filter((el) => {
    if (!el.matches(INTERACTIVE)) return false
    if ((el as HTMLButtonElement).disabled) return false
    // A control inside another control: the outer one is the target.
    return !el.parentElement?.closest(INTERACTIVE)
  })
  const media = all.filter((el) => el.matches(MEDIA) && !el.parentElement?.closest('svg'))

  /** Everything a person reads or taps, once, with its visible box. */
  const content = new Map<Element, Box>()
  for (const el of [...texts.map((t) => t.el), ...controls, ...media]) {
    if (content.has(el)) continue
    const b = visibleBox(el)
    if (!srOnly(b)) content.set(el, b)
  }

  // --- overflow ----------------------------------------------------------------------
  const pageWidth = document.documentElement.scrollWidth
  const culprits = new Set<Element>()
  for (const [el, b] of content) {
    if (inHorizontalScroller(el)) continue
    const rect = box(el.getBoundingClientRect())
    const text = ink.get(el)
    const own = text
      ? {
          left: Math.min(rect.left, text.left),
          top: rect.top,
          right: Math.max(rect.right, text.right),
          bottom: rect.bottom,
        }
      : rect
    // The element reaches past the viewport, whether the page then scrolls
    // sideways or an ancestor cuts it off.
    if (own.right > vw + EPS || own.left < -EPS) {
      if (width(b) === 0 && height(b) === 0) continue
      culprits.add(el)
      continue
    }
    // Past the side of the card it sits in (a surface: a background, a
    // border or a shadow). An absolutely placed badge may stick out.
    if (style(el).position === 'absolute' || style(el).position === 'fixed') continue
    for (let e = el.parentElement; e && e !== root; e = e.parentElement) {
      const s = style(e)
      if (s.position === 'absolute' || s.position === 'fixed') break
      const surface =
        s.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
        parseFloat(s.borderLeftWidth) > 0 ||
        s.boxShadow !== 'none'
      if (!surface) continue
      const r = e.getBoundingClientRect()
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
  // Report the outermost culprits only: a row that is too wide drags its
  // children along, the row is the bug.
  for (const el of culprits) {
    let parent = el.parentElement
    while (parent && !content.has(parent)) parent = parent.parentElement
    if (parent && culprits.has(parent)) continue
    const r = el.getBoundingClientRect()
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

  // --- overlap -----------------------------------------------------------------------
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i]!
    for (let j = i + 1; j < texts.length; j++) {
      const b = texts[j]!
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      // A bar floating over the scroll covers content by design; whether the
      // content gets out from under it is the `tabbar` rule's question.
      if (floats(a.el, b.el) || floats(b.el, a.el)) continue
      let hit: Box | null = null
      for (const ra of a.rects) {
        for (const rb of b.rects) {
          const x = intersect(ra, rb)
          // Glyph boxes of adjacent lines may touch or graze; text drawn over
          // text overlaps by a real share of the smaller line.
          const minH = Math.min(height(ra), height(rb))
          if (width(x) > 2 && height(x) > Math.max(2, minH * 0.3)) hit = x
        }
      }
      if (hit) {
        out.push({
          rule: 'overlap',
          element: describe(a.el),
          detail: `drawn over ${describe(b.el)} (${round(width(hit))}x${round(height(hit))} px)`,
        })
      }
    }
  }

  // --- targets -------------------------------------------------------------------------
  for (const el of controls) {
    const b = content.get(el)
    if (!b) continue
    // An inline link in running text is exempt (WCAG 2.5.8): its size is the
    // text's, and the sentence around it gives the spacing.
    const inline =
      el.tagName === 'A' &&
      style(el).display === 'inline' &&
      [...(el.parentElement?.childNodes ?? [])].some(
        (n) => n !== el && n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim(),
      )
    const hit = hitBox(el)
    if (!inline && (width(hit) < targetPx - 0.5 || height(hit) < targetPx - 0.5)) {
      out.push({
        rule: 'small-target',
        element: describe(el),
        detail: `${round(width(hit))}x${round(height(hit))} px, under ${targetPx}x${targetPx}`,
      })
    }
    // Covered: something else is on top of its center. Only on screen, and
    // only by a non-floating element -- a bar floating over the scroll is
    // the `tabbar` rule's business.
    const cx = (b.left + b.right) / 2
    const cy = (b.top + b.bottom) / 2
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue
    const top = document.elementFromPoint(cx, cy)
    if (!top || el.contains(top) || top.contains(el)) continue
    if (floats(top, el)) continue
    out.push({
      rule: 'covered-target',
      element: describe(el),
      detail: `covered at its center by ${describe(top)}`,
    })
  }

  // --- safe-area (top), at the current scroll ------------------------------------------
  for (const [el, b] of content) {
    if (b.top < bands.top - EPS && b.bottom > 0 && height(b) > 0) {
      out.push({
        rule: 'safe-area',
        element: describe(el),
        detail: `top at ${round(b.top)} px, inside the top ${bands.top} px Telegram's controls cover`,
      })
    }
  }

  // --- tabbar and safe-area (bottom), scrolled to the end ---------------------------------
  const scrollers = [document.scrollingElement, ...all].filter(
    (e): e is Element =>
      !!e &&
      e.scrollHeight > e.clientHeight + EPS &&
      (e === document.scrollingElement || ['auto', 'scroll'].includes(style(e).overflowY)),
  )
  const saved = scrollers.map((e) => e.scrollTop)
  for (const e of scrollers) e.scrollTop = e.scrollHeight
  // Positioned elements as wide as half the screen, resting at its bottom:
  // the tab bar, a sticky action bar. They count where they float over the
  // content's scroll.
  const bars = all.filter((el) => {
    if (!['fixed', 'absolute', 'sticky'].includes(style(el).position)) return false
    if (el.closest(TRANSIENT)) return false
    const r = el.getBoundingClientRect()
    return r.top > vh / 2 && r.bottom > vh - 120 && r.width >= vw / 2 && r.height > 0
  })
  for (const [el] of content) {
    const b = visibleBox(el)
    if (width(b) === 0 || height(b) === 0 || b.bottom <= 0 || b.top >= vh) continue
    for (const bar of bars) {
      if (bar.contains(el) || !floats(bar, el)) continue
      const x = intersect(b, box(bar.getBoundingClientRect()))
      if (width(x) > 0 && height(x) > EPS) {
        out.push({
          rule: 'tabbar',
          element: describe(el),
          detail: `stays ${round(height(x))} px under ${describe(bar).split(' ')[0]} scrolled to the end`,
        })
        break
      }
    }
    if (bands.bottom > 0 && b.bottom > vh - bands.bottom + EPS && b.top < vh) {
      out.push({
        rule: 'safe-area',
        element: describe(el),
        detail: `bottom at ${round(b.bottom)} px, inside the bottom ${bands.bottom} px of the home indicator (viewport ${vh})`,
      })
    }
  }
  scrollers.forEach((e, i) => (e.scrollTop = saved[i]!))

  // One finding per rule + element + detail.
  const seen = new Set<string>()
  return out.filter((f) => {
    const key = `${f.rule}|${f.element}|${f.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
