/**
 * Единственная точка доступа к `window` для прикладного кода: таймеры, rAF,
 * слушатели, location, history, visualViewport. document-доступ — через
 * platform/dom.ts. Зачем: закон no-restricted-globals запрещает
 * window/document вне platform/**, и любой хост-доступ идёт через seam.
 */
export const host: Window & typeof globalThis = window
