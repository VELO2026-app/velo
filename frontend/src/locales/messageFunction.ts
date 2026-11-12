// =============================================================================
// VELO Frontend -- catalog-syntax strings as message functions (FE-157)
// =============================================================================
//
// The bundle ships vue-i18n WITHOUT its message compiler (vite.config.ts,
// dropMessageCompiler): the catalogs arrive precompiled, and a plain string
// handed to the composer at runtime renders as raw text -- placeholders,
// plural cases and linked keys included. Messages that only exist at runtime
// (the instance overlays of applyInstanceOverrides) therefore go in as
// message FUNCTIONS built here, through the public message-function API
// (named / list / linked / plural).
//
// Supported syntax is the subset the catalogs use, with the compiler's own
// tokenizing rules (pinned against the real compiler over every catalog
// message in messageFunction.test.ts):
//   - named `{name}` and list `{0}` interpolation;
//   - literal `{'@'}`;
//   - linked `@:key`, `@.modifier:key`, `@:{name}` (key from a named value);
//   - plural cases `a | b | c` (spaces around the pipe are dropped);
//   - text escapes `\{` `\}` `\@` `\|` `\\`.
// Syntax the compiler rejects (an unclosed brace, a bare `@`) renders as
// text here instead of throwing: an overlay typo must not break a screen.
// Output is text: the app renders every message through t(), never in
// vnode mode.
// =============================================================================

import type { MessageContext, MessageFunction } from 'vue-i18n'

type Part =
  | { kind: 'text'; value: string }
  | { kind: 'named'; key: string }
  | { kind: 'list'; index: number }
  | { kind: 'linked'; key: Part; modifier?: string }

const SPACE = /[ \n]/
const IDENTIFIER_START = /[A-Za-z_]/
const NAMED_CHAR = /[A-Za-z0-9_$-]/
const MODIFIER_CHAR = /[A-Za-z0-9_$]/
const TEXT_ESCAPABLE = new Set(['{', '}', '@', '|', '\\'])
// The linked key runs until one of these (or a space / the end).
const LINKED_KEY_STOP = new Set(['{', '@', '|', '(', ')'])

/** Same output as the composer's default interpolation (toDisplayString). */
function display(value: unknown): string {
  if (value == null) return ''
  const plainObject =
    Object.prototype.toString.call(value) === '[object Object]' &&
    (value as { toString: unknown }).toString === Object.prototype.toString
  if (Array.isArray(value) || plainObject) return JSON.stringify(value, null, 2)
  // Primitives and objects with their own toString (a Date, a class).
  return (value as { toString(): string }).toString()
}

/** A literal's escape at `source[i] === '\\'`: the character and its length. */
function literalEscape(source: string, i: number): [string, number] | null {
  const next = source[i + 1]
  if (next === '\\' || next === "'") return [next, 2]
  const digits = next === 'u' ? 4 : next === 'U' ? 6 : 0
  const hex = source.slice(i + 2, i + 2 + digits)
  if (digits && hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) {
    return [String.fromCodePoint(parseInt(hex, 16)), 2 + digits]
  }
  return null
}

/** One pass over the source: plural cases, each a list of parts. */
function parse(source: string): Part[][] {
  const cases: Part[][] = [[]]
  let at = 0
  let text = ''

  const parts = (): Part[] => cases[cases.length - 1] as Part[]
  const flushText = (): void => {
    if (text) parts().push({ kind: 'text', value: text })
    text = ''
  }
  const skipSpaces = (from: number): number => {
    let i = from
    while (i < source.length && SPACE.test(source[i] as string)) i++
    return i
  }

  /** `{...}` starting at `open`: the part and the index after `}`, or null. */
  const readPlaceholder = (open: number, namedOnly: boolean): [Part, number] | null => {
    let i = skipSpaces(open + 1)
    let part: Part
    const ch = source[i] ?? ''
    if (IDENTIFIER_START.test(ch)) {
      let key = ''
      while (i < source.length && NAMED_CHAR.test(source[i] as string)) key += source[i++]
      part = { kind: 'named', key }
    } else if (namedOnly) {
      return null
    } else if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let digits = ch
      i++
      while (i < source.length && /[0-9]/.test(source[i] as string)) digits += source[i++]
      part = { kind: 'list', index: Number(digits) }
    } else if (ch === "'") {
      let value = ''
      i++
      while (i < source.length && source[i] !== "'" && source[i] !== '\n') {
        const escape = source[i] === '\\' ? literalEscape(source, i) : null
        if (!escape && source[i] === '\\') return null
        value += escape ? escape[0] : source[i]
        i += escape ? escape[1] : 1
      }
      if (source[i] !== "'") return null
      i++
      part = { kind: 'text', value }
    } else {
      return null
    }
    i = skipSpaces(i)
    if (source[i] !== '}') return null
    return [part, i + 1]
  }

  /** `@...` starting at `at`: the linked part and the index after it, or null. */
  const readLinked = (start: number): [Part, number] | null => {
    let i = start + 1
    let modifier: string | undefined
    if (source[i] === '.') {
      i++
      let name = ''
      while (i < source.length && MODIFIER_CHAR.test(source[i] as string)) name += source[i++]
      if (!name) return null
      modifier = name
    }
    if (source[i] !== ':') return null
    i++
    if (source[i] === '{') {
      const placeholder = readPlaceholder(i, true)
      if (!placeholder) return null
      return [{ kind: 'linked', key: placeholder[0], modifier }, placeholder[1]]
    }
    let key = ''
    while (i < source.length) {
      const ch = source[i] as string
      if (LINKED_KEY_STOP.has(ch) || ch === ' ') break
      key += ch
      i++
    }
    if (!key || key[0] === '.' || key[0] === ':' || key[0] === '\n') return null
    return [{ kind: 'linked', key: { kind: 'text', value: key }, modifier }, i]
  }

  while (at < source.length) {
    const ch = source[at] as string
    if (ch === '\\' && TEXT_ESCAPABLE.has(source[at + 1] ?? '')) {
      text += source[at + 1]
      at += 2
      continue
    }
    if (ch === '|') {
      text = text.replace(/[ \n]+$/, '')
      flushText()
      cases.push([])
      at = skipSpaces(at + 1)
      continue
    }
    if (ch === '{' || ch === '@') {
      const read = ch === '{' ? readPlaceholder(at, false) : readLinked(at)
      if (read) {
        flushText()
        parts().push(read[0])
        at = read[1]
        continue
      }
    }
    text += ch
    at++
  }
  flushText()
  return cases
}

function renderPart(ctx: MessageContext, part: Part): string {
  switch (part.kind) {
    case 'text':
      return part.value
    case 'named':
      return display(ctx.named(part.key))
    case 'list':
      return display(ctx.list(part.index))
    case 'linked':
      return display(ctx.linked(renderPart(ctx, part.key), part.modifier ?? ''))
  }
}

/**
 * Build a message function from one catalog-syntax string.
 *
 * @remarks
 * The composer resolves a message function as is -- no compiler needed --
 * so a runtime message (an instance overlay) keeps its placeholders,
 * plural cases and linked keys in a bundle without the compiler.
 *
 * @example
 * ```ts
 * compileMessage('{n} item | {n} items') // t(key, 2) -> '2 items'
 * ```
 */
export function compileMessage(source: string): MessageFunction {
  const cases = parse(source)
  const render = (ctx: MessageContext, parts: Part[]): string =>
    parts.map((part) => renderPart(ctx, part)).join('')
  const [only = []] = cases
  return (ctx: MessageContext) =>
    cases.length > 1 ? ctx.plural(cases.map((parts) => render(ctx, parts))) : render(ctx, only)
}

/** One catalog value as messages: strings compile, functions pass, the rest drops. */
function toMessageValue(value: unknown): unknown {
  if (typeof value === 'string') return compileMessage(value)
  if (typeof value === 'function') return value
  if (Array.isArray(value)) return value.map(toMessageValue)
  if (value && typeof value === 'object')
    return toMessageFunctions(value as Record<string, unknown>)
  return undefined
}

/**
 * Map a catalog-shaped tree (nested objects and arrays of strings, like
 * `dates.shortMonths`) onto message functions; existing functions pass
 * through, non-message values drop.
 */
export function toMessageFunctions(tree: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tree)) {
    const message = toMessageValue(value)
    if (message !== undefined) out[key] = message
  }
  return out
}
