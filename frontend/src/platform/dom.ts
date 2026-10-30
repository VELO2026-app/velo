// =============================================================================
// VELO Frontend -- Document seam
// =============================================================================
//
// Единственная точка доступа к `document` для прикладного кода (закон
// no-restricted-globals: window/document только внутри platform/**).
// Покрывает фактические операции приложения: слушатели на document,
// видимость, activeElement, блокировка скролла body, root CSS-переменные
// и классы, точечный querySelector.
// =============================================================================

/** document.addEventListener с типизацией по карте событий документа. */
export function onDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  listener: (this: Document, ev: DocumentEventMap[K]) => unknown,
  options?: AddEventListenerOptions | boolean,
): void {
  document.addEventListener(type, listener as EventListener, options)
}

/** document.removeEventListener с типизацией по карте событий документа. */
export function offDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  listener: (this: Document, ev: DocumentEventMap[K]) => unknown,
  options?: EventListenerOptions | boolean,
): void {
  document.removeEventListener(type, listener as EventListener, options)
}

/**
 * window.addEventListener с типизацией по карте событий окна. Окно нужно
 * жестам, которые не должны обрываться, когда указатель уходит за пределы
 * компонента (drag вне strip): document сюда не подходит — pointerup над
 * элементом вне документа-цели всплывает именно до window.
 */
export function onWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  listener: (this: Window, ev: WindowEventMap[K]) => unknown,
  options?: AddEventListenerOptions | boolean,
): void {
  window.addEventListener(type, listener as EventListener, options)
}

/** window.removeEventListener, пара к onWindowEvent. */
export function offWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  listener: (this: Window, ev: WindowEventMap[K]) => unknown,
  options?: EventListenerOptions | boolean,
): void {
  window.removeEventListener(type, listener as EventListener, options)
}

/** document.hidden. */
export function isDocumentHidden(): boolean {
  return document.hidden
}

/** document.visibilityState. */
export function documentVisibility(): DocumentVisibilityState {
  return document.visibilityState
}

/** document.activeElement, суженный до HTMLElement (типовой кейс приложения). */
export function activeHTMLElement(): HTMLElement | null {
  return document.activeElement as HTMLElement | null
}

/** document.body.style.overflow = value (блокировка/разблокировка скролла). */
export function setBodyOverflow(value: string): void {
  document.body.style.overflow = value
}

/** document.documentElement.style.setProperty. */
export function setRootStyleProperty(prop: string, value: string): void {
  document.documentElement.style.setProperty(prop, value)
}

/** document.documentElement.lang = value (язык интерфейса, tz-i18n 0.3). */
export function setRootLang(lang: string): void {
  document.documentElement.lang = lang
}

/** document.documentElement.classList.add. */
export function addRootClass(cls: string): void {
  document.documentElement.classList.add(cls)
}

/** document.documentElement.classList.remove. */
export function removeRootClass(cls: string): void {
  document.documentElement.classList.remove(cls)
}

/** getComputedStyle(document.documentElement) — для чтения CSS-переменных. */
export function rootComputedStyle(): CSSStyleDeclaration {
  return getComputedStyle(document.documentElement)
}

/** Значение CSS-переменной на documentElement (без fallback'а — решает вызов). */
export function rootStyleValue(prop: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(prop)
}

/** document.documentElement.classList.toggle. */
export function toggleRootClass(cls: string, force: boolean): void {
  document.documentElement.classList.toggle(cls, force)
}

/** document.querySelector с дженериком элемента (контракт T | null). */
export function queryDocument<T extends Element = Element>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

/** document.elementFromPoint. */
export function elementFromPoint(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y)
}

/** The part of a ViewTransition the app uses (lib.dom may lack the type on
 * the pinned TS version). */
export interface ViewTransitionHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  readonly updateCallbackDone: Promise<void>
  skipTransition(): void
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void>) => ViewTransitionHandle
}

/** True when the host can run View Transitions (see startViewTransition). */
export function supportsViewTransitions(): boolean {
  return typeof (document as ViewTransitionDocument).startViewTransition === 'function'
}

/**
 * document.startViewTransition, or null where the host has no View
 * Transitions (iOS < 18, older Android WebView) -- the caller then applies the
 * update directly. The promises are pre-handled: a skipped transition rejects
 * `ready`/`finished`, which is a normal outcome here, not an error.
 */
export function startViewTransition(update: () => Promise<void>): ViewTransitionHandle | null {
  const doc = document as ViewTransitionDocument
  if (typeof doc.startViewTransition !== 'function') return null
  const vt = doc.startViewTransition(update)
  vt.ready.catch(() => undefined)
  vt.finished.catch(() => undefined)
  vt.updateCallbackDone.catch(() => undefined)
  return vt
}

/**
 * True on WebKit (every iOS browser and Telegram iOS, which is WKWebView;
 * desktop Safari). Its View Transitions (Safari 18+) cannot be trusted with
 * this app's layers: a named scroll container's live snapshot is not clipped
 * to its box, backdrop-filter is dropped while a transition runs, and the
 * snapshot geometry ignores the snapshot containing block -- see
 * router/viewTransition.ts. `GestureEvent` exists only in WebKit.
 */
export function isWebKitEngine(): boolean {
  if (typeof (window as { GestureEvent?: unknown }).GestureEvent !== 'undefined') return true
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

/** A duration token on the root (`--velo-dur-*`) in ms, or `fallback` where
 * it is not set or not parseable (the unit-test DOM). */
export function rootDurationMs(prop: string, fallback: number): number {
  const raw = rootStyleValue(prop).trim()
  const value = parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return raw.endsWith('ms') ? value : raw.endsWith('s') ? value * 1000 : value
}

/** The user asked the OS for less motion (smooth scrolls become instant). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Forces a style flush on the root, so a class removed and re-added in the
 * same task restarts its CSS animation instead of being coalesced away. */
export function flushRootStyle(): void {
  void document.documentElement.offsetWidth
}

/** Resolves on the next animation frame (after style/layout of this one). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

/** Run `task` when the main thread is idle (requestIdleCallback where it
 * exists -- not in iOS WebKit -- else a timeout). */
export function whenIdle(task: () => void, timeout = 2000): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout })
    return
  }
  setTimeout(task, Math.min(timeout, 600))
}

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string }

/** The user asked for less data (Data Saver) or the link is 2G-slow: no
 * speculative loading then. Unknown (iOS WebKit has no Network Information
 * API) = not constrained. */
export function isConstrainedNetwork(): boolean {
  const connection = (navigator as { connection?: NetworkInformationLike }).connection
  if (!connection) return false
  if (connection.saveData === true) return true
  return connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g'
}
