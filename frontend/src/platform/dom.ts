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
